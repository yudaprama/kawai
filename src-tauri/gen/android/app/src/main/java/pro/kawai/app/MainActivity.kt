package pro.kawai.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
  private var mainWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Detached scrape WebViews (KawaiHeadless) need an Activity context. They
    // are never attached to the view hierarchy, so they cannot replace the app
    // UI the way a wry-created webview does.
    KawaiHeadless.attach(this)

    // The run foreground service is started from the Rust run guard
    // (src-tauri/src/android_foreground.rs), which has no Activity to start it
    // from — hand it the application context.
    KawaiForeground.attach(this)
    // Android 13+ hides the run notification unless POST_NOTIFICATIONS is
    // granted, and the start path is background-side, so it cannot raise a
    // prompt itself. Ask once, on first launch.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST)
    }
    // Hardware back must behave like Esc, never like "exit the app".
    // Tauri's AppPlugin registers an unconditional back callback that
    // finishes the activity; this one is added LATER, so the dispatcher gives
    // it priority and the app decides instead. The press is forwarded to the
    // web layer, which closes its topmost surface (dialog, drawer, asset
    // page, progress rail) and answers "consumed"; with nothing left to close
    // it answers "exit" and the activity moves to the back of the task
    // (state preserved in recents — NOT finish(), which would kill the app).
    // See the mirror handler `__kawaiHandleBackPress` in frontend/src/app/App.tsx.
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val wv = mainWebView
          if (wv == null) {
            this@MainActivity.moveTaskToBack(true)
            return
          }
          wv.evaluateJavascript(
            "(window.__kawaiHandleBackPress ? window.__kawaiHandleBackPress() : 'exit')",
          ) { result ->
            if (result?.trim('"') != "consumed") {
              this@MainActivity.moveTaskToBack(true)
            }
          }
        }
      },
    )
  }

  // The layout is driven by CSS viewport metrics (`dvh`,
  // `env(safe-area-inset-*)`) and the Activity is never recreated for window
  // changes (see configChanges in AndroidManifest.xml), so returning from the
  // background otherwise keeps the viewport and insets the WebView had before
  // the switch — typically captured with the IME up — and the page renders
  // against stale geometry. Re-dispatch the window insets, force a relayout
  // and let the web layer re-measure + log (mirror handler
  // `__kawaiResyncViewport` in frontend/src/lib/viewport-resync.ts).
  override fun onResume() {
    super.onResume()
    val wv = mainWebView ?: return
    window.decorView.requestApplyInsets()
    wv.requestLayout()
    wv.invalidate()
    wv.evaluateJavascript(
      "(window.__kawaiResyncViewport ? window.__kawaiResyncViewport('resume') : null)",
      null,
    )
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // Called for EVERY webview wry creates, not just the app's own. Keeping the
    // first one means the back handler and the viewport resync below can never
    // be pointed at a different webview.
    if (mainWebView == null) {
      mainWebView = webView
      // Status-bar icon contrast: enableEdgeToEdge() follows the SYSTEM dark
      // mode, but the app's dark mode is localStorage-driven — without this
      // bridge a dark app under a light system gets dark icons on dark UI.
      // JS (use-theme.ts → platform/status-bar.ts) pushes the resolved theme;
      // absent calls leave the system default.
      webView.addJavascriptInterface(StatusBarBridge(), "KawaiStatusBar")
    }
  }

  override fun onDestroy() {
    KawaiHeadless.shutdown()
    super.onDestroy()
  }

  private inner class StatusBarBridge {
    @JavascriptInterface
    fun setLightIcons(light: Boolean) {
      runOnUiThread {
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = light
      }
    }
  }

  private companion object {
    const val NOTIFICATION_REQUEST = 4711
  }
}
