package pro.kawai.app

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

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    mainWebView = webView
    // Status-bar icon contrast: enableEdgeToEdge() follows the SYSTEM dark
    // mode, but the app's dark mode is localStorage-driven — without this
    // bridge a dark app under a light system gets dark icons on dark UI.
    // JS (use-theme.ts → platform/status-bar.ts) pushes the resolved theme;
    // absent calls leave the system default.
    webView.addJavascriptInterface(StatusBarBridge(), "KawaiStatusBar")
  }

  private inner class StatusBarBridge {
    @JavascriptInterface
    fun setLightIcons(light: Boolean) {
      runOnUiThread {
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = light
      }
    }
  }
}
