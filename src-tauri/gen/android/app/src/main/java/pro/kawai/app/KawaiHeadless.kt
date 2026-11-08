package pro.kawai.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap

/**
 * Detached ("headless") WebView renderer for the Rust scrape tier.
 *
 * Tauri's Android WebView support has no detached mode: every webview it creates
 * takes over the activity's content view (`setContentView`), so a "hidden"
 * scrape window replaces the whole app UI and is never put back. This object IS
 * the detached mode — the WebView is created on the UI thread and never added to
 * any view hierarchy, which is how Kotlin/Flutter headless-webview helpers work.
 * A WebView does not need to be attached to load pages or run JavaScript.
 *
 * Contract with Rust (`src-tauri/src/webview_engine/android.rs`):
 *
 *   start(id, url, js)  begin a render (may be called from any thread)
 *   poll(id)            null while pending, else "V"+result or "E"+message
 *   shutdown()          destroy every live view (activity teardown)
 *
 * `result` is the JSON-encoded completion value of `js` — exactly what
 * `WebView.evaluateJavascript` hands back — so the Rust side decodes it with
 * `serde_json::from_str::<String>` like the desktop `eval_with_callback` path.
 * Every finished view is `stopLoading()`ed and `destroy()`ed, so a scrape leaves
 * no native WebView behind (the wry path leaked one per fetch).
 */
object KawaiHeadless {
  /** Hard budget for one render; Rust gives up slightly later. */
  private const val TIMEOUT_MS = 25_000L
  /** Let the page settle after `onPageFinished` before harvesting. */
  private const val SETTLE_MS = 1_000L
  /** Re-harvest delay while a Cloudflare interstitial is still on screen. */
  private const val RETRY_MS = 1_500L
  private const val MAX_ATTEMPTS = 3
  /** Drop a result nobody polled (Rust side gave up) instead of keeping it. */
  private const val RESULT_TTL_MS = 60_000L

  private val handler = Handler(Looper.getMainLooper())
  private var activity: WeakReference<Activity> = WeakReference(null)
  private val results = ConcurrentHashMap<Long, String>()
  private val views = ConcurrentHashMap<Long, WebView>()

  /** Called from `MainActivity.onCreate`; the WebView needs an Activity context. */
  @JvmStatic
  fun attach(activity: Activity) {
    this.activity = WeakReference(activity)
  }

  @JvmStatic
  fun start(id: Long, url: String, js: String) {
    val act = activity.get()
    if (act == null) {
      results[id] = "Eno activity"
      return
    }
    act.runOnUiThread { begin(act, id, url, js) }
  }

  @JvmStatic
  fun poll(id: Long): String? = results.remove(id)

  /** Destroy every live render (activity teardown). */
  @JvmStatic
  fun shutdown() {
    for (id in views.keys.toList()) {
      finish(id, "Eshutdown")
    }
  }

  private fun begin(act: Activity, id: Long, url: String, js: String) {
    if (views.containsKey(id) || results.containsKey(id)) return
    val view = WebView(act)
    views[id] = view
    handler.postDelayed({ finish(id, "Ewebview timeout") }, TIMEOUT_MS)
    try {
      view.settings.javaScriptEnabled = true
      view.settings.domStorageEnabled = true
      // Images are irrelevant to every extractor and cost bandwidth on a phone.
      view.settings.loadsImagesAutomatically = false
      view.setBackgroundColor(0)
      // Detached views are never measured by a parent; give the page a real
      // viewport so media queries, lazy-load observers and layout run.
      val metrics = act.resources.displayMetrics
      val width = metrics.widthPixels.takeIf { it > 0 } ?: 1080
      val height = metrics.heightPixels.takeIf { it > 0 } ?: 1920
      view.measure(
        View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
      )
      view.layout(0, 0, width, height)
      view.webViewClient = object : WebViewClient() {
        override fun onPageFinished(v: WebView, u: String) {
          if (!views.containsKey(id)) return
          handler.postDelayed({ harvest(id, v, js, 1) }, SETTLE_MS)
        }

        override fun onReceivedError(
          v: WebView,
          request: WebResourceRequest,
          error: WebResourceError,
        ) {
          // Sub-resource failures are normal on ad/tracker-heavy pages.
          if (request.isForMainFrame) {
            finish(id, "E" + (error.description?.toString() ?: "load error"))
          }
        }
      }
      view.loadUrl(url)
    } catch (e: Throwable) {
      finish(id, "E" + (e.message ?: e.javaClass.simpleName))
    }
  }

  private fun harvest(id: Long, view: WebView, js: String, attempt: Int) {
    if (!views.containsKey(id)) return
    view.evaluateJavascript(js) { raw ->
      if (!views.containsKey(id)) return@evaluateJavascript
      if (raw == null || raw == "null") {
        finish(id, "Eempty result")
        return@evaluateJavascript
      }
      // A Cloudflare interstitial reports `readyState=complete` long before it
      // redirects; retry instead of handing the challenge page to the caller.
      if (attempt < MAX_ATTEMPTS && looksBlocked(raw)) {
        handler.postDelayed({ harvest(id, view, js, attempt + 1) }, RETRY_MS)
        return@evaluateJavascript
      }
      finish(id, "V$raw")
    }
  }

  private fun looksBlocked(raw: String): Boolean =
    raw.contains("Just a moment") ||
      raw.contains("cf-browser-verification") ||
      raw.contains("_cf_chl_opt")

  private fun finish(id: Long, payload: String) {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      handler.post { finish(id, payload) }
      return
    }
    val view = views.remove(id) ?: return
    results[id] = payload
    handler.postDelayed({ results.remove(id) }, RESULT_TTL_MS)
    try {
      view.stopLoading()
      view.webViewClient = WebViewClient()
      view.destroy()
    } catch (_: Throwable) {
      // A dead renderer throws on destroy; nothing left to clean up.
    }
  }
}
