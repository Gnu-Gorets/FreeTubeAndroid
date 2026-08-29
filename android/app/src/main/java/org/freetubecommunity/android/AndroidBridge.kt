package org.freetubecommunity.android

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.app.PendingIntent
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
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
    private val notificationManager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val mediaSession = MediaSession(activity, "FreeTubeAndroid").apply {
        isActive = true
    }
    private var mediaTitle = "FreeTube Android"
    private var mediaArtist = ""
    private var mediaDuration = 0L

    init {
        mediaSession.setCallback(object : MediaSession.Callback() {
            override fun onPlay() = dispatchMediaEvent("play")
            override fun onPause() = dispatchMediaEvent("pause")
            override fun onSeekTo(pos: Long) {
                activity.runOnUiThread {
                    mainWebView.evaluateJavascript("document.querySelector('video')?.fastSeek($pos / 1000)", null)
                }
            }
        })
    }

    private fun dispatchMediaEvent(action: String) {
        activity.runOnUiThread {
            val script = if (action == "play") {
                "document.querySelector('video')?.play()"
            } else {
                "document.querySelector('video')?.pause()"
            }
            mainWebView.evaluateJavascript(script, null)
        }
    }

    private fun mediaAction(icon: Int, label: String, action: String): Notification.Action {
        val intent = Intent(activity, MainActivity::class.java)
            .setAction(action)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pendingIntent = PendingIntent.getActivity(
            activity,
            action.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Action.Builder(icon, label, pendingIntent).build()
    }

    @JavascriptInterface
    fun getSyncMessage(id: String): String? = messages.remove(id)

    @JavascriptInterface
    fun createMediaSession(title: String, artist: String, duration: Long) {
        mediaTitle = title
        mediaArtist = artist
        mediaDuration = duration
        mediaSession.isActive = true
        activity.runOnUiThread {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                notificationManager.createNotificationChannel(
                    NotificationChannel("media_controls", "Media controls", NotificationManager.IMPORTANCE_LOW)
                )
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED
            ) {
                activity.requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), 100)
            }
            updateMediaState(PlaybackState.STATE_PAUSED, 0)
        }
    }

    @JavascriptInterface
    fun updateMediaSessionState(state: Int, position: Long) {
        activity.runOnUiThread { updateMediaState(state, position) }
    }

    @JavascriptInterface
    fun cancelMediaSession() {
        notificationManager.cancel(1001)
        mediaSession.isActive = false
    }

    private fun updateMediaState(state: Int, position: Long) {
        mediaSession.setMetadata(
            android.media.MediaMetadata.Builder()
                .putString(android.media.MediaMetadata.METADATA_KEY_TITLE, mediaTitle)
                .putString(android.media.MediaMetadata.METADATA_KEY_ARTIST, mediaArtist)
                .putLong(android.media.MediaMetadata.METADATA_KEY_DURATION, mediaDuration)
                .build()
        )
        mediaSession.setPlaybackState(
            PlaybackState.Builder()
                .setState(state, position, if (state == PlaybackState.STATE_PLAYING) 1f else 0f)
                .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SEEK_TO)
                .build()
        )
        val notification = Notification.Builder(activity, "media_controls")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(mediaTitle)
            .setContentText(mediaArtist)
            .setOngoing(state == PlaybackState.STATE_PLAYING)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(
                if (state == PlaybackState.STATE_PLAYING) {
                    mediaAction(android.R.drawable.ic_media_pause, "Pause", "MEDIA_PAUSE")
                } else {
                    mediaAction(android.R.drawable.ic_media_play, "Play", "MEDIA_PLAY")
                }
            )
            .setStyle(Notification.MediaStyle().setMediaSession(mediaSession.sessionToken))
            .build()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            notificationManager.notify(1001, notification)
        }
    }

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
                                connection.setRequestProperty("Sec-Fetch-Site", "same-origin")
                                connection.setRequestProperty("Sec-Fetch-Mode", "same-origin")
                                connection.setRequestProperty("X-Youtube-Bootstrap-Logged-In", "false")
                            }
                            if (url.startsWith("https://www.google.com/js/")) {
                                connection.setRequestProperty("Referer", "https://www.google.com/")
                                connection.setRequestProperty("Origin", "https://www.google.com")
                                connection.setRequestProperty("Sec-Fetch-Dest", "script")
                                connection.setRequestProperty("Sec-Fetch-Site", "cross-site")
                                connection.setRequestProperty("Accept-Language", "*")
                            }
                            if (url.startsWith("https://www.google.com/js/")) {
                                WebResourceResponse(
                                    connection.contentType,
                                    connection.contentEncoding,
                                    connection.responseCode,
                                    connection.responseMessage,
                                    mapOf(
                                        "Access-Control-Allow-Origin" to "https://www.youtube.com",
                                        "Access-Control-Allow-Methods" to "GET, OPTIONS",
                                        "Access-Control-Allow-Headers" to "*"
                                    ),
                                    connection.inputStream
                                )
                            } else {
                                WebResourceResponse(connection.contentType, connection.contentEncoding, connection.inputStream)
                            }
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
