package org.freetubecommunity.android

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

class AndroidBridge(
    private val activity: Activity,
    private val mainWebView: WebView,
    private val parent: ViewGroup
) {
    private val messages = ConcurrentHashMap<String, String>()
    private val scripts = ConcurrentHashMap<String, String>()
    private var sigWebView: WebView? = null
    private var sigReady = false

    @JavascriptInterface
    fun getSyncMessage(id: String): String? = messages.remove(id)

    @JavascriptInterface
    fun generatePOToken(
        id: String,
        videoId: String,
        sessionContext: String,
        initialAttestationData: String,
        ytConfig: String
    ): String {
        activity.runOnUiThread {
            val script = activity.assets.open("botGuardScript.js").bufferedReader().use { it.readText() }
            val functionName = script.substringAfter("export{").substringBefore(" as default};")
            val bakedScript = script.replace(
                "export{${functionName} as default};",
                "; ${functionName}(${JSONObject.quote(videoId)}, $sessionContext, $initialAttestationData, $ytConfig)"
            )
            val quotedId = JSONObject.quote(id)
            val botHtml = "<script>$bakedScript.then((token) => Android.returnToken($quotedId, token)).catch((error) => Android.rejectToken($quotedId, error.toString()))</script>"
            val botWebView = WebView(activity).apply {
                visibility = View.GONE
                settings.javaScriptEnabled = true
                @Suppress("DEPRECATION")
                settings.allowUniversalAccessFromFileURLs = true
                addJavascriptInterface(TokenBridge(this), "Android")
                webChromeClient = object : WebChromeClient() {
                    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                        Log.d("FreeTubeBotGuard", message.message())
                        return true
                    }
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView,
                        request: WebResourceRequest
                    ): WebResourceResponse? {
                        val url = request.url.toString()
                        if (url.startsWith("data:text/html") || url.startsWith("https://www.youtube.com/api/jnn/v1/GenerateIT")) {
                            return super.shouldInterceptRequest(view, request)
                        }
                        return try {
                            val connection = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                            connection.requestMethod = request.method
                            request.requestHeaders.forEach { (key, value) -> connection.setRequestProperty(key, value) }
                            if (url.startsWith("https://www.youtube.com/youtubei/")) {
                                connection.setRequestProperty("Referer", "https://www.youtube.com/")
                                connection.setRequestProperty("Origin", "https://www.youtube.com")
                            }
                            WebResourceResponse(connection.contentType, connection.contentEncoding, connection.inputStream)
                        } catch (error: Exception) {
                            Log.e("FreeTubeBotGuard", error.toString())
                            super.shouldInterceptRequest(view, request)
                        }
                    }
                }
                this@AndroidBridge.parent.addView(this, ViewGroup.LayoutParams(1, 1))
                loadDataWithBaseURL(
                    "https://www.youtube.com/",
                    botHtml,
                    "text/html",
                    "utf-8",
                    null
                )
            }
            botWebView.tag = id
        }
        return id
    }

    @JavascriptInterface
    fun runDecipherScript(id: String, code: String, timeout: Long): String {
        scripts[id] = code
        activity.runOnUiThread {
            ensureSigWebView()
            if (sigReady) dispatchScript(id)
        }
        activity.window.decorView.postDelayed({
            scripts.remove(id)
            messages.remove(id)
        }, timeout)
        return id
    }

    private fun ensureSigWebView() {
        if (sigWebView != null) return

        sigWebView = WebView(activity).apply {
            visibility = View.GONE
            settings.javaScriptEnabled = true
            addJavascriptInterface(SigBridge(), "Android")
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    sigReady = true
                    scripts.keys.toList().forEach(::dispatchScript)
                }
            }
            this@AndroidBridge.parent.addView(this, ViewGroup.LayoutParams(1, 1))
            loadUrl("file:///android_asset/decipher.html")
        }
    }

    private fun dispatchScript(id: String) {
        val code = scripts[id] ?: return
        val event = "window.dispatchEvent(Object.assign(new Event('message'), { id: ${JSONObject.quote(id)} }))"
        sigWebView?.evaluateJavascript("window.AndroidCode = ${JSONObject.quote(code)}; $event", null)
    }

    private inner class TokenBridge(private val webView: WebView) {
        @JavascriptInterface
        fun returnToken(id: String, token: String) {
            messages[id] = token
            notifyMain(id, true)
            destroy(webView)
        }

        @JavascriptInterface
        fun rejectToken(id: String, error: String) {
            messages[id] = error
            notifyMain(id, false)
            destroy(webView)
        }
    }

    private fun destroy(webView: WebView) {
        activity.runOnUiThread {
            parent.removeView(webView)
            webView.destroy()
        }
    }

    private inner class SigBridge {
        @JavascriptInterface
        fun readSync(id: String): String? = scripts[id]

        @JavascriptInterface
        fun resolve(id: String, result: String) {
            Log.d("FreeTubeDecipher", "resolve $id: ${result.take(120)}")
            scripts.remove(id)
            messages[id] = result
            notifyMain(id, true)
        }

        @JavascriptInterface
        fun reject(id: String, error: String) {
            Log.e("FreeTubeDecipher", "reject $id: $error")
            scripts.remove(id)
            messages[id] = error
            notifyMain(id, false)
        }
    }

    private fun notifyMain(id: String, resolved: Boolean) {
        activity.runOnUiThread {
            val event = JSONObject.quote("$id-${if (resolved) "resolve" else "reject"}")
            mainWebView.evaluateJavascript("window.dispatchEvent(new Event($event))", null)
        }
    }
}
