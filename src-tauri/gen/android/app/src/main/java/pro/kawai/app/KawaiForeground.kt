package pro.kawai.app

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Foreground-service handle for the Rust run guard
 * (`src-tauri/src/android_foreground.rs`), called over JNI by name — so this
 * class must survive R8, see proguard-rules.pro.
 *
 * The application context is captured at attach() time (MainActivity.onCreate):
 * a run started in the foreground keeps going after the activity is stopped, and
 * by then the activity is no longer available to start the service from.
 */
object KawaiForeground {
  private const val TAG = "KawaiForeground"

  private var appContext: Context? = null

  @JvmStatic
  fun attach(context: Context) {
    appContext = context.applicationContext
  }

  /** Idempotent: a repeated call just re-delivers the start intent. */
  @JvmStatic
  fun start() {
    val ctx = appContext ?: return
    val intent = Intent(ctx, KawaiForegroundService::class.java)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
    } catch (e: Exception) {
      // API 31+ refuses a start from the background
      // (ForegroundServiceStartNotAllowedException). The run is unaffected; it
      // only loses its protection from the cached-app freezer.
      Log.w(TAG, "could not start the run foreground service", e)
    }
  }

  @JvmStatic
  fun stop() {
    val ctx = appContext ?: return
    try {
      ctx.stopService(Intent(ctx, KawaiForegroundService::class.java))
    } catch (e: Exception) {
      Log.w(TAG, "could not stop the run foreground service", e)
    }
  }
}
