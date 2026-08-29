package org.freetubecommunity.android

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : Activity() {
    companion object {
        const val CREATE_FILE_REQUEST = 1001
        const val OPEN_FILE_REQUEST = 1002
    }

    private lateinit var webView: WebView
    private lateinit var androidBridge: AndroidBridge

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val safeInsets = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val params = view.layoutParams as ViewGroup.MarginLayoutParams
            params.setMargins(safeInsets.left, safeInsets.top, safeInsets.right, safeInsets.bottom)
            view.layoutParams = params
            view.setPadding(0, 0, 0, 0)
            insets
        }
        webView.webViewClient = WebViewClient()
        var fullscreenView: View? = null
        val root = webView.parent as ViewGroup
        val insetsController = WindowInsetsControllerCompat(window, window.decorView)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                fullscreenView = view
                root.addView(view, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                insetsController.hide(WindowInsetsCompat.Type.systemBars())
                insetsController.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }

            override fun onHideCustomView() {
                fullscreenView?.let(root::removeView)
                fullscreenView = null
                insetsController.show(WindowInsetsCompat.Type.systemBars())
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d("FreeTubeWebView", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        window.attributes.layoutInDisplayCutoutMode =
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        @Suppress("DEPRECATION")
        webView.settings.allowUniversalAccessFromFileURLs = true
        @Suppress("DEPRECATION")
        webView.settings.allowFileAccessFromFileURLs = true
        webView.settings.userAgentString = webView.settings.userAgentString
            .replace(Regex("Mozilla/5.0 \\([^)]*\\)"), "Mozilla/5.0 (X11; Linux x86_64)")
            .replace("Mobile Safari", "Safari")
        webView.setInitialScale(100)
        webView.settings.mediaPlaybackRequiresUserGesture = false
        androidBridge = AndroidBridge(this, webView, webView.parent as ViewGroup)
        webView.addJavascriptInterface(androidBridge, "Android")
        webView.loadUrl("file:///android_asset/index.html")
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            CREATE_FILE_REQUEST -> androidBridge.finishSaveFile(resultCode, data?.data)
            OPEN_FILE_REQUEST -> androidBridge.finishOpenFile(resultCode, data?.data)
        }
    }

    override fun onNewIntent(intent: android.content.Intent?) {
        super.onNewIntent(intent)
        when (intent?.action) {
            "MEDIA_PLAY" -> webView.evaluateJavascript("document.querySelector('video')?.play()", null)
            "MEDIA_PAUSE" -> webView.evaluateJavascript("document.querySelector('video')?.pause()", null)
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
