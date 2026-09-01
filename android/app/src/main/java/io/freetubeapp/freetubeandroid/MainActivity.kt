package io.freetubeapp.freetubeandroid

import android.app.Activity
import android.graphics.Color
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceResponse
import android.webkit.WebResourceRequest
import java.io.InputStream
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject

class MainActivity : Activity() {
    companion object {
        val consoleMessages = java.util.concurrent.CopyOnWriteArrayList<String>()
        const val CREATE_FILE_REQUEST = 1001
        const val OPEN_FILE_REQUEST = 1002
        const val DIRECTORY_REQUEST = 1003
    }

    private lateinit var webView: WebView
    private lateinit var androidBridge: AndroidBridge
    private var pendingDeepLink: Intent? = null

    @Suppress("DEPRECATION")
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
        pendingDeepLink = intent
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                val requestUrl = request?.url ?: return null
                if (requestUrl.scheme != "freetube-download") return null
                return openDownloadedFile(requestUrl, request.requestHeaders["Range"])
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                pendingDeepLink?.let {
                    dispatchDeepLink(it)
                    pendingDeepLink = null
                }
            }
        }
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
                root.addView(view)
                insetsController.hide(WindowInsetsCompat.Type.systemBars())
                insetsController.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }

            override fun onHideCustomView() {
                fullscreenView?.let(root::removeView)
                fullscreenView = null
                insetsController.show(WindowInsetsCompat.Type.systemBars())
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                val entry = JSONObject().apply {
                    put("message", message.message())
                    put("source", message.sourceId())
                    put("line", message.lineNumber())
                    put("level", message.messageLevel())
                }.toString()
                consoleMessages.add(entry)
                Log.d("FreeTubeWebView", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        window.attributes.layoutInDisplayCutoutMode =
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        webView.settings.javaScriptEnabled = true
        webView.settings.userAgentString = webView.settings.userAgentString
            .replace(Regex("Mozilla/5.0 \\([^)]*\\)"), "Mozilla/5.0 (X11; Linux x86_64)")
            .replace("Mobile Safari", "Safari")
        webView.settings.domStorageEnabled = true
        @Suppress("DEPRECATION")
        webView.settings.allowUniversalAccessFromFileURLs = true
        @Suppress("DEPRECATION")
        webView.settings.allowFileAccessFromFileURLs = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        androidBridge = AndroidBridge(this, webView, webView.parent as ViewGroup)
        webView.addJavascriptInterface(androidBridge, "Android")
        webView.loadUrl("file:///android_asset/index.html")
    }

    private fun openDownloadedFile(uri: android.net.Uri, range: String?): WebResourceResponse? {
        return try {
            val sourceUri = android.net.Uri.parse(uri.getQueryParameter("uri") ?: return null)
            val descriptor = contentResolver.openAssetFileDescriptor(sourceUri, "r") ?: return null
            val length = descriptor.use { it.length }
            val input = contentResolver.openInputStream(sourceUri) ?: return null
            val headers = mutableMapOf(
                "Accept-Ranges" to "bytes",
                "Access-Control-Allow-Origin" to "*",
                "Content-Type" to (contentResolver.getType(sourceUri) ?: "video/mp4")
            )
            if (range == null || length < 0) {
                if (length >= 0) headers["Content-Length"] = length.toString()
                WebResourceResponse(contentResolver.getType(sourceUri) ?: "video/mp4", null, 200, "OK", headers, input)
            } else {
                val match = Regex("bytes=(\\d+)-(\\d*)").find(range) ?: return null
                val start = match.groupValues[1].toLong()
                val requestedEnd = match.groupValues[2].takeIf { it.isNotEmpty() }?.toLong()
                val end = if (requestedEnd == null || requestedEnd >= length) length - 1 else requestedEnd
                if (start >= length || end < start) return null
                var skipped = 0L
                while (skipped < start) {
                    val count = input.skip(start - skipped)
                    if (count <= 0) break
                    skipped += count
                }
                if (skipped != start) return null
                headers["Content-Range"] = "bytes $start-$end/$length"
                headers["Content-Length"] = (end - start + 1).toString()
                WebResourceResponse(contentResolver.getType(sourceUri) ?: "video/mp4", null, 206, "Partial Content", headers, input.limit(end - start + 1))
            }
        } catch (error: Exception) {
            Log.w("FreeTubePlayback", "Unable to serve downloaded file", error)
            null
        }
    }

    private fun InputStream.limit(bytes: Long): InputStream = object : InputStream() {
        var remaining = bytes
        override fun read(): Int {
            if (remaining <= 0) return -1
            val value = this@limit.read()
            if (value >= 0) remaining--
            return value
        }
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (remaining <= 0) return -1
            val count = this@limit.read(buffer, offset, minOf(length.toLong(), remaining).toInt())
            if (count > 0) remaining -= count
            return count
        }
        override fun close() = this@limit.close()
    }

    private fun dispatchDeepLink(intent: Intent?) {
        val url = intent?.data?.toString() ?: return
        val event = JSONObject.quote(url)
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('youtube-link', { detail: { link: $event } }))",
            null
        )
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            CREATE_FILE_REQUEST -> androidBridge.finishSaveFile(resultCode, data?.data)
            OPEN_FILE_REQUEST -> androidBridge.finishOpenFile(resultCode, data?.data)
            DIRECTORY_REQUEST -> androidBridge.finishDirectoryAccess(resultCode, data?.data)
        }
    }

    override fun onPause() {
        super.onPause()
        Log.i("FreeTubeLifecycle", "onPause")
        webView.evaluateJavascript("window.dispatchEvent(new Event('app-pause'))", null)
    }

    override fun onResume() {
        super.onResume()
        Log.i("FreeTubeLifecycle", "onResume")
        webView.evaluateJavascript("window.dispatchEvent(new Event('app-resume'))", null)
    }

    override fun onDestroy() {
        Log.i("FreeTubeLifecycle", "onDestroy finishing=$isFinishing changingConfigurations=$isChangingConfigurations")
        androidBridge.cancelMediaNotification()
        webView.destroy()
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        when (intent?.action) {
            "MEDIA_PLAY" -> webView.evaluateJavascript("document.querySelector('video')?.play()", null)
            "MEDIA_PAUSE" -> webView.evaluateJavascript("document.querySelector('video')?.pause()", null)
            "DOWNLOAD_CONTROL" -> dispatchDownloadControl(intent)
            Intent.ACTION_VIEW -> dispatchDeepLink(intent)
        }
    }

    private fun dispatchDownloadControl(intent: Intent?) {
        val id = JSONObject.quote(intent?.getStringExtra("downloadId") ?: return)
        val action = JSONObject.quote(intent.getStringExtra("downloadAction") ?: return)
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('android-download-control', { detail: { id: $id, action: $action } }))",
            null
        )
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            androidBridge.cancelMediaNotification()
            super.onBackPressed()
        }
    }
}
