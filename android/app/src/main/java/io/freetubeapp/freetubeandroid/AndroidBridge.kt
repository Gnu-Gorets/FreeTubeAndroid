package io.freetubeapp.freetubeandroid

import android.app.Activity
import android.app.Notification
import android.graphics.drawable.Icon
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.res.Configuration
import android.content.Intent
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import android.provider.OpenableColumns
import android.app.PendingIntent
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
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
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class AndroidBridge(
    private val activity: Activity,
    private val mainWebView: WebView,
    private val parent: ViewGroup
) {
    private companion object {
        const val ANDROID_VR_USER_AGENT = "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip"
        const val DOWNLOAD_UPDATE_INTERVAL_MS = 1000L
    }
    private val messages = ConcurrentHashMap<String, String>()
    private val fileExecutor = Executors.newSingleThreadExecutor()
    private var pendingDirectoryRequest: String? = null
    private val dataDirectory: java.io.File
        get() = java.io.File(activity.filesDir, "data").also { it.mkdirs() }
    private val scripts = ConcurrentHashMap<String, String>()
    private var sigWebView: WebView? = null
    private var sigReady = false
    private val notificationManager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val mediaSession = MediaSession(activity, "FreeTubeAndroid")
    private var mediaTitle = "FreeTube Android"
    private var mediaArtist = ""
    private var mediaDuration = 0L
    private var mediaThumbnail: android.graphics.Bitmap? = null
    private var pendingFile: Triple<String, String, String>? = null
    private val downloadManager = DownloadRuntime.manager(activity)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val downloadUpdateLock = Any()
    private var pendingDownloadSnapshot: org.json.JSONArray? = null
    private var downloadUpdateScheduled = false
    private val downloadUpdateRunnable = Runnable(::dispatchDownloadUpdate)
    private val downloadListener: (org.json.JSONArray) -> Unit = { snapshot ->
        if (hasRunningDownload(snapshot)) DownloadService.start(activity)
        synchronized(downloadUpdateLock) {
            pendingDownloadSnapshot = snapshot
            if (downloadUpdateScheduled) return@synchronized
            downloadUpdateScheduled = true
        }
        mainHandler.postDelayed(downloadUpdateRunnable, DOWNLOAD_UPDATE_INTERVAL_MS)
    }

    init {
        downloadManager.addListener(downloadListener)
        if (hasRunningDownload(downloadManager.snapshot())) DownloadService.start(activity)
    }

    @JavascriptInterface
    fun enqueueDownload(requestJson: String): String {
        val request = JSONObject(requestJson)
        validateDownloadUrls(request)
        Log.i("FreeTubeDownloads", "enqueue kind=${request.optString("kind")} mime=${request.optString("mimeType")} parts=${request.optJSONArray("parts")?.length() ?: 0}")
        DownloadService.start(activity)
        return downloadManager.enqueue(request).toString()
    }

    private fun hasRunningDownload(snapshot: org.json.JSONArray): Boolean {
        for (index in 0 until snapshot.length()) {
            val status = snapshot.optJSONObject(index)?.optString("status")
            if (status == DownloadMission.STATUS_QUEUED ||
                status == DownloadMission.STATUS_DOWNLOADING ||
                status == DownloadMission.STATUS_POST_PROCESSING ||
                status == DownloadMission.STATUS_PAUSED
            ) return true
        }
        return false
    }

    private fun validateDownloadUrls(request: JSONObject) {
        val parts = request.getJSONArray("parts")
        for (index in 0 until parts.length()) {
            val part = parts.getJSONObject(index)
            val url = URL(part.getString("url"))
            val connection = (url.openConnection() as? HttpURLConnection)
                ?: throw IllegalStateException("Unsupported stream URL")
            try {
                connection.instanceFollowRedirects = true
                connection.connectTimeout = 15_000
                connection.readTimeout = 15_000
                connection.setRequestProperty("User-Agent", ANDROID_VR_USER_AGENT)
                connection.setRequestProperty("Accept", "*/*")
                connection.setRequestProperty("Accept-Encoding", "*")
                connection.setRequestProperty("Referer", "https://www.youtube.com/")
                connection.setRequestProperty("Range", "bytes=0-")
                val responseCode = connection.responseCode
                Log.i("FreeTubeDownloads", "validate source=${request.optString("sourceUrl").isNotEmpty()} part=${part.optString("id")} response=$responseCode type=${connection.contentType} length=${connection.contentLengthLong} range=${connection.getHeaderField("Content-Range")} etag=${connection.getHeaderField("ETag") != null} lastModified=${connection.getHeaderField("Last-Modified") != null} host=${url.host}")
                if (responseCode !in 200..299) {
                    throw IllegalStateException("Stream URL validation failed: HTTP $responseCode")
                }
            } finally {
                connection.disconnect()
            }
        }
    }

    @JavascriptInterface
    fun probeDownloadUrls(requestJson: String): String {
        val result = JSONArray()
        val parts = JSONObject(requestJson).getJSONArray("parts")
        for (index in 0 until parts.length()) {
            val part = parts.getJSONObject(index)
            val connection = (URL(part.getString("url")).openConnection() as HttpURLConnection).apply {
                requestMethod = "HEAD"
                instanceFollowRedirects = true
                connectTimeout = 15_000
                readTimeout = 15_000
                setRequestProperty("User-Agent", ANDROID_VR_USER_AGENT)
                setRequestProperty("Referer", "https://www.youtube.com/")
            }
            try {
                val status = connection.responseCode
                result.put(JSONObject().apply {
                    put("id", part.optString("id"))
                    put("status", status)
                    put("contentLength", connection.contentLengthLong)
                    put("contentRange", connection.getHeaderField("Content-Range") ?: JSONObject.NULL)
                    put("acceptRanges", connection.getHeaderField("Accept-Ranges") ?: JSONObject.NULL)
                    put("mimeType", connection.contentType ?: JSONObject.NULL)
                })
            } finally {
                connection.disconnect()
            }
        }
        return result.toString()
    }

    @JavascriptInterface
    fun validateDownloadUrls(requestJson: String): String {
        return try {
            validateDownloadUrls(JSONObject(requestJson))
            JSONObject().put("ok", true).toString()
        } catch (error: Exception) {
            JSONObject().put("ok", false).put("error", error.message ?: "Stream URL validation failed").toString()
        }
    }

    @JavascriptInterface
    fun getDownloads(): String {
        Log.i("FreeTubeDownloads", "bridge getDownloads")
        return downloadManager.snapshot().toString()
    }

    @JavascriptInterface
    fun getDownloadSettings(): String = downloadManager.settings().toString()

    @JavascriptInterface
    fun updateDownloadSettings(settingsJson: String): Boolean {
        downloadManager.updateSettings(JSONObject(settingsJson))
        return true
    }

    @JavascriptInterface
    fun refreshDownload(id: String, requestJson: String): Boolean {
        val result = downloadManager.replaceUrls(id, JSONObject(requestJson))
        if (result) DownloadService.start(activity)
        return result
    }

    @JavascriptInterface
    fun pauseDownload(id: String): Boolean = downloadManager.pause(id)

    @JavascriptInterface
    fun resumeDownload(id: String): Boolean {
        val result = downloadManager.resume(id)
        if (result) DownloadService.start(activity)
        return result
    }

    @JavascriptInterface
    fun cancelDownload(id: String): Boolean = downloadManager.cancel(id)

    @JavascriptInterface
    fun retryDownload(id: String): Boolean {
        val result = downloadManager.retry(id)
        if (result) DownloadService.start(activity)
        return result
    }

    @JavascriptInterface
    fun deleteDownload(id: String): Boolean = downloadManager.delete(id)

    private fun dispatchDownloadUpdate() {
        val snapshot = synchronized(downloadUpdateLock) {
            val next = pendingDownloadSnapshot
            pendingDownloadSnapshot = null
            next
        } ?: run {
            synchronized(downloadUpdateLock) { downloadUpdateScheduled = false }
            return
        }
        Log.i("FreeTubeDownloads", "dispatch download-update")
        mainWebView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('download-update', {detail: ${snapshot}}))",
            null
        )
        synchronized(downloadUpdateLock) {
            if (pendingDownloadSnapshot == null) {
                downloadUpdateScheduled = false
            } else {
                mainHandler.postDelayed(downloadUpdateRunnable, DOWNLOAD_UPDATE_INTERVAL_MS)
            }
        }
    }

    fun dispose() {
        downloadManager.removeListener(downloadListener)
        mainHandler.removeCallbacks(downloadUpdateRunnable)
        synchronized(downloadUpdateLock) {
            pendingDownloadSnapshot = null
            downloadUpdateScheduled = false
        }
    }

    @JavascriptInterface
    fun isLandscape(): Boolean {
        return activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    }

    @JavascriptInterface
    fun openFile(eventName: String, mimeTypes: String): Boolean {
        activity.runOnUiThread {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.split(',').toTypedArray())
            }
            pendingReadEvent = eventName
            activity.startActivityForResult(intent, MainActivity.OPEN_FILE_REQUEST)
        }
        return true
    }

    private var pendingReadEvent: String? = null

    private fun asyncFileOperation(operation: () -> String): String {
        val id = UUID.randomUUID().toString()
        fileExecutor.execute {
            try {
                messages[id] = operation()
                notifyMain(id, true)
            } catch (error: Exception) {
                messages[id] = error.stackTraceToString()
                notifyMain(id, false)
            }
        }
        return id
    }

    private fun resolveUri(uri: String): Uri = if (uri.startsWith("data://")) {
        Uri.fromFile(java.io.File(dataDirectory, uri.removePrefix("data://")))
    } else {
        Uri.parse(uri)
    }

    private fun content(uri: String): ByteArray = if (uri.startsWith("data://")) {
        java.io.FileInputStream(java.io.File(dataDirectory, uri.removePrefix("data://"))).use { it.readBytes() }
    } else {
        activity.contentResolver.openInputStream(resolveUri(uri))?.use { it.readBytes() }
            ?: throw IllegalStateException("File not found: $uri")
    }

    private fun write(uri: String, bytes: ByteArray, append: Boolean) {
        if (uri.startsWith("data://")) {
            java.io.FileOutputStream(java.io.File(dataDirectory, uri.removePrefix("data://")), append).use {
                it.write(bytes)
                it.flush()
            }
            return
        }
        val mode = if (append) "wa" else "wt"
        activity.contentResolver.openOutputStream(resolveUri(uri), mode)?.use {
            it.write(bytes)
            it.flush()
        } ?: throw IllegalStateException("Unable to open file: $uri")
    }

    @JavascriptInterface
    fun readFile(uri: String): String = asyncFileOperation {
        content(uri).toString(Charsets.UTF_8)
    }

    @JavascriptInterface
    fun writeFile(uri: String, value: String): String = asyncFileOperation {
        Log.i("FreeTubeWebView", "Writing file: $uri, ${value.length} chars")
        val bytes = if (value.startsWith("data:")) {
            android.util.Base64.decode(value.substringAfter("base64,"), android.util.Base64.DEFAULT)
        } else value.toByteArray()
        if (uri.startsWith("data://")) java.io.File(dataDirectory, uri.removePrefix("data://")).parentFile?.mkdirs()
        write(uri, bytes, false)
        ""
    }

    @JavascriptInterface
    fun appendFile(uri: String, value: String): String = asyncFileOperation {
        val bytes = if (value.startsWith("data:")) {
            android.util.Base64.decode(value.substringAfter("base64,"), android.util.Base64.DEFAULT)
        } else value.toByteArray()
        write(uri, bytes, true)
        ""
    }

    @JavascriptInterface
    fun getDirectory(directory: String): String = if (directory == "data://") dataDirectory.absolutePath else directory

    @JavascriptInterface
    fun listFilesInDataDir(): String = dataDirectory.listFiles().orEmpty().map { fileJson("data://${it.name}", it.name, it.isFile, it.isDirectory) }.joinToString(",", "[", "]")

    @JavascriptInterface
    fun isTreeAccessible(tree: String): Boolean {
        return try {
            val uri = Uri.parse(tree)
            val hasPersistedPermission = activity.contentResolver.persistedUriPermissions.any {
                it.uri == uri && it.isReadPermission && it.isWritePermission
            }
            hasPersistedPermission && DocumentFile.fromTreeUri(activity, uri)?.let {
                it.canRead() && it.canWrite()
            } == true
        } catch (error: Exception) {
            Log.w("FreeTubeWebView", "Unable to access persisted data directory: $tree", error)
            false
        }
    }

    @JavascriptInterface
    fun listFilesInTree(tree: String): String {
        val directory = DocumentFile.fromTreeUri(activity, Uri.parse(tree))
            ?: throw IllegalStateException("Unable to open tree: $tree")
        if (!directory.canRead()) throw SecurityException("Unable to read tree: $tree")
        return directory.listFiles()
            .map { fileJson(it.uri.toString(), it.name, it.isFile, it.isDirectory) }.joinToString(",", "[", "]")
    }

    @JavascriptInterface
    fun createFileInTree(tree: String, fileName: String): String {
        val directory = DocumentFile.fromTreeUri(activity, Uri.parse(tree))
            ?: throw IllegalStateException("Unable to open tree: $tree")
        if (!directory.canWrite()) throw SecurityException("Unable to write tree: $tree")
        return directory.createFile("application/octet-stream", fileName)?.uri?.toString()
            ?: throw IllegalStateException("Unable to create file: $fileName")
    }

    private fun fileJson(uri: String, name: String?, isFile: Boolean, isDirectory: Boolean): String = JSONObject().apply {
        put("uri", uri)
        put("fileName", name)
        put("isFile", isFile)
        put("isDirectory", isDirectory)
    }.toString()

    @JavascriptInterface
    fun revokePermissionForTree(tree: String) {
        activity.revokeUriPermission(Uri.parse(tree), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }

    @JavascriptInterface
    fun getDownloadDirectory(): String = DownloadStorage.DEFAULT_DIRECTORY

    @JavascriptInterface
    fun revokeDownloadDirectory(tree: String): Boolean {
        return try {
            revokePermissionForTree(tree)
            true
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun requestDirectoryAccessDialog(): String {
        val id = UUID.randomUUID().toString()
        pendingDirectoryRequest = id
        activity.runOnUiThread {
            activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), MainActivity.DIRECTORY_REQUEST)
        }
        return id
    }

    fun finishDirectoryAccess(resultCode: Int, uri: Uri?) {
        val id = pendingDirectoryRequest ?: return
        pendingDirectoryRequest = null
        if (resultCode != Activity.RESULT_OK || uri == null) {
            messages[id] = "USER_CANCELED"
            notifyMain(id, true)
            return
        }
        try {
            activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            messages[id] = uri.toString()
            notifyMain(id, true)
        } catch (error: Exception) {
            messages[id] = error.stackTraceToString()
            notifyMain(id, false)
        }
    }

    @JavascriptInterface
    fun requestSaveDialog(fileName: String, fileType: String): String {
        val id = UUID.randomUUID().toString()
        activity.runOnUiThread {
            pendingSaveRequest = id
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(fileType).putExtra(Intent.EXTRA_TITLE, fileName)
            activity.startActivityForResult(intent, MainActivity.CREATE_FILE_REQUEST)
        }
        return id
    }

    @JavascriptInterface
    fun requestOpenDialog(fileTypes: String): String {
        Log.i("FreeTubeWebView", "Opening import picker: $fileTypes")
        val id = UUID.randomUUID().toString()
        pendingOpenRequest = id
        activity.runOnUiThread {
            activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, fileTypes.split(',').toTypedArray())
            }, MainActivity.OPEN_FILE_REQUEST)
        }
        return id
    }

    private var pendingSaveRequest: String? = null
    private var pendingOpenRequest: String? = null

    private fun getFileName(uri: Uri): String {
        return activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0)?.takeIf { it.isNotBlank() } else null
            }
            ?: uri.toString().split(Regex("(/)|(%2F)")).last()
    }

    fun finishOpenFile(resultCode: Int, uri: Uri?) {
        Log.i("FreeTubeWebView", "Import picker result: code=$resultCode uri=$uri pending=$pendingOpenRequest")
        val openRequest = pendingOpenRequest
        if (openRequest != null) {
            pendingOpenRequest = null
            if (resultCode != Activity.RESULT_OK || uri == null) {
                messages[openRequest] = "USER_CANCELED"
                notifyMain(openRequest, true)
                return
            }
            try {
                val filename = getFileName(uri)
                val payload = JSONObject().apply {
                    put("uri", uri.toString())
                    put("type", activity.contentResolver.getType(uri))
                    put("fileName", filename)
                }
                messages[openRequest] = payload.toString()
                notifyMain(openRequest, true)
            } catch (error: Exception) {
                messages[openRequest] = error.stackTraceToString()
                notifyMain(openRequest, false)
            }
            return
        }
        val eventName = pendingReadEvent ?: return
        pendingReadEvent = null
        if (resultCode != Activity.RESULT_OK || uri == null) {
            val event = JSONObject.quote(eventName)
            activity.runOnUiThread {
                mainWebView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent($event, {detail: null}))",
                    null
                )
            }
            return
        }

        try {
            val filename = getFileName(uri)
            val content = activity.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
                ?: throw IllegalStateException("Unable to open input stream for $uri")
            val event = JSONObject.quote(eventName)
            val filenameJson = JSONObject.quote(filename)
            val contentJson = JSONObject.quote(content)
            activity.runOnUiThread {
                mainWebView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent($event, {detail: {filename: $filenameJson, content: $contentJson}}))",
                    null
                )
            }
        } catch (error: Exception) {
            Log.e("FreeTubeWebView", "Unable to read imported file", error)
        }
    }

    @JavascriptInterface
    fun saveFile(fileName: String, mimeType: String, content: String): Boolean {
        Log.d("FreeTubeWebView", "Opening save picker for $fileName")
        pendingFile = Triple(fileName, mimeType, content)
        activity.runOnUiThread {
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = mimeType
                putExtra(Intent.EXTRA_TITLE, fileName)
            }
            activity.startActivityForResult(intent, MainActivity.CREATE_FILE_REQUEST)
        }
        return true
    }

    fun finishSaveFile(resultCode: Int, uri: Uri?) {
        val saveRequest = pendingSaveRequest
        if (saveRequest != null) {
            pendingSaveRequest = null
            if (resultCode != Activity.RESULT_OK || uri == null) {
                messages[saveRequest] = "USER_CANCELED"
                notifyMain(saveRequest, true)
            } else {
                messages[saveRequest] = JSONObject().apply { put("uri", uri.toString()) }.toString()
                notifyMain(saveRequest, true)
            }
            return
        }
        val file = pendingFile ?: return
        pendingFile = null
        if (resultCode != Activity.RESULT_OK || uri == null) return

        try {
            activity.contentResolver.openOutputStream(uri)?.use { output ->
                output.write(file.third.toByteArray(Charsets.UTF_8))
            } ?: Log.e("FreeTubeWebView", "Unable to open output stream for $uri")
        } catch (error: Exception) {
            Log.e("FreeTubeWebView", "Unable to save ${file.first}", error)
        }
    }

    init {
        MediaControlsReceiver.onAction = { dispatchMediaEvent(it) }
        @Suppress("DEPRECATION")
        mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
        mediaSession.setCallback(object : MediaSession.Callback() {
            @Suppress("DEPRECATION")
            override fun onMediaButtonEvent(intent: Intent): Boolean {
                val keyEvent = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
                    ?: return super.onMediaButtonEvent(intent)
                if (keyEvent.action != KeyEvent.ACTION_DOWN) return true
                when (keyEvent.keyCode) {
                    KeyEvent.KEYCODE_MEDIA_PLAY -> dispatchMediaEvent("play")
                    KeyEvent.KEYCODE_MEDIA_PAUSE -> dispatchMediaEvent("pause")
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> dispatchMediaEvent(
                        if (mediaSession.controller.playbackState?.state == PlaybackState.STATE_PLAYING) "pause" else "play"
                    )
                    else -> return super.onMediaButtonEvent(intent)
                }
                return true
            }

            override fun onPlay() = dispatchMediaEvent("play")
            override fun onPause() = dispatchMediaEvent("pause")
            override fun onSkipToNext() = dispatchMediaEvent("next")
            override fun onSkipToPrevious() = dispatchMediaEvent("previous")
            override fun onSeekTo(pos: Long) = dispatchMediaEvent("seek", pos)
        })
    }

    private fun dispatchMediaEvent(action: String, position: Long? = null) {
        activity.runOnUiThread {
            val event = JSONObject.quote("media-$action")
            val detail = position?.let { ", { detail: { position: $it } }" } ?: ""
            mainWebView.evaluateJavascript("window.dispatchEvent(new CustomEvent($event$detail))", null)
        }
    }

    private fun mediaAction(icon: Int, label: String, action: String): Notification.Action {
        val pendingIntent = PendingIntent.getBroadcast(
            activity, action.hashCode(), Intent(activity, MediaControlsReceiver::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Action.Builder(Icon.createWithResource(activity, icon), label, pendingIntent).build()
    }

    @JavascriptInterface
    fun getSyncMessage(id: String): String? = messages.remove(id)

    @JavascriptInterface
    fun createMediaSession(title: String, artist: String, duration: Long, thumbnail: String? = null) {
        mediaTitle = title
        mediaArtist = artist
        mediaDuration = duration
        mediaSession.isActive = true
        if (!thumbnail.isNullOrBlank()) {
            fileExecutor.execute {
                try {
                    mediaThumbnail = java.net.URL(thumbnail).openStream().use(BitmapFactory::decodeStream)
                } catch (error: Exception) { Log.w("FreeTubeWebView", "Unable to load media thumbnail", error) }
                activity.runOnUiThread { updateMediaState(PlaybackState.STATE_PAUSED, 0) }
            }
        }
        activity.runOnUiThread {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) notificationManager.createNotificationChannel(
                NotificationChannel("media_controls", "Media controls", NotificationManager.IMPORTANCE_LOW)
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED
            ) activity.requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), 100)
            updateMediaState(PlaybackState.STATE_PAUSED, 0)
        }
    }

    @JavascriptInterface
    fun updateMediaSessionData(title: String, artist: String, duration: Long, thumbnail: String? = null) =
        createMediaSession(title, artist, duration, thumbnail)

    @JavascriptInterface
    fun updateMediaSessionState(state: String?, position: String?) {
        activity.runOnUiThread { updateMediaState(state?.toIntOrNull() ?: PlaybackState.STATE_PAUSED, position?.toLongOrNull() ?: 0) }
    }

    @JavascriptInterface
    fun cancelMediaNotification() {
        notificationManager.cancel(1001)
        mediaSession.isActive = false
    }

    @JavascriptInterface
    fun cancelMediaSession() = cancelMediaNotification()

    @JavascriptInterface
    fun enableKeepScreenOn() { activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }

    @JavascriptInterface
    fun disableKeepScreenOn() { activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }

    @JavascriptInterface
    fun restart() { activity.runOnUiThread { activity.recreate() } }

    @JavascriptInterface
    fun getLogs(): String = JSONArray(MainActivity.consoleMessages.toList()).toString()

    private var appliedScale: Int? = null

    @JavascriptInterface
    fun setScale(scale: Int) {
        activity.runOnUiThread {
            val initialScale = if (scale == 0) {
                0
            } else {
                (activity.resources.displayMetrics.density * scale).toInt()
            }
            val appliedValue = if (initialScale == 0) null else initialScale
            if (appliedScale != appliedValue) {
                mainWebView.setInitialScale(initialScale)
                appliedScale = appliedValue
                mainWebView.reload()
            }
        }
    }

    @JavascriptInterface
    @Suppress("DEPRECATION")
    fun themeSystemUi(navigationHex: String, statusHex: String, navigationDarkMode: Boolean, statusDarkMode: Boolean) {
        activity.runOnUiThread {
            activity.window.navigationBarColor = android.graphics.Color.parseColor(navigationHex)
            activity.window.statusBarColor = android.graphics.Color.parseColor(statusHex)
            androidx.core.view.WindowInsetsControllerCompat(activity.window, activity.window.decorView).apply {
                isAppearanceLightNavigationBars = !navigationDarkMode
                isAppearanceLightStatusBars = !statusDarkMode
            }
        }
    }

    @JavascriptInterface
    fun openExternalLink(url: String) {
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    @JavascriptInterface
    fun openDownloadFile(uri: String, mimeType: String): Boolean {
        return try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
                setDataAndType(Uri.parse(uri), mimeType.ifBlank { "application/octet-stream" })
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            })
            true
        } catch (_: android.content.ActivityNotFoundException) {
            false
        }
    }

    @JavascriptInterface
    fun shareText(text: String) {
        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }
        activity.startActivity(Intent.createChooser(sendIntent, null))
    }

    @JavascriptInterface
    fun shareFile(uri: String, mimeType: String) {
        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = mimeType.ifBlank { "application/octet-stream" }
            putExtra(Intent.EXTRA_STREAM, Uri.parse(uri))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivity(Intent.createChooser(sendIntent, null))
    }

    private fun updateMediaState(state: Int, position: Long) {
        if (!mediaSession.isActive) return
        mediaSession.setMetadata(MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, mediaTitle)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, mediaArtist)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, mediaDuration)
            .apply { mediaThumbnail?.let { putBitmap(MediaMetadata.METADATA_KEY_ART, it); putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) } }
            .build())
        mediaSession.setPlaybackState(PlaybackState.Builder()
            .setState(state, position, if (state == PlaybackState.STATE_PLAYING) 1f else 0f)
            .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO)
            .build())
        val notification = Notification.Builder(activity, "media_controls")
            .setSmallIcon(R.drawable.ic_media_notification_icon)
            .setContentTitle(mediaTitle).setContentText(mediaArtist)
            .setOngoing(state == PlaybackState.STATE_PLAYING).setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(mediaAction(android.R.drawable.ic_media_previous, "Previous", "previous"))
            .addAction(mediaAction(if (state == PlaybackState.STATE_PLAYING) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play, if (state == PlaybackState.STATE_PLAYING) "Pause" else "Play", if (state == PlaybackState.STATE_PLAYING) "pause" else "play"))
            .addAction(mediaAction(android.R.drawable.ic_popup_sync, "Reload", "reload"))
            .addAction(mediaAction(android.R.drawable.ic_media_next, "Next", "next"))
            .setStyle(Notification.MediaStyle().setMediaSession(mediaSession.sessionToken))
            .build()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == android.content.pm.PackageManager.PERMISSION_GRANTED) notificationManager.notify(1001, notification)
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
                webViewClient = WebViewClient()
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
            if (scripts.remove(id) != null) {
                messages[id] = "Decipher timed out after ${timeout}ms"
                notifyMain(id, false)
            }
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
            if (scripts.remove(id) == null) return
            Log.d("FreeTubeDecipher", "resolve $id: ${result.take(120)}")
            messages[id] = result
            notifyMain(id, true)
        }

        @JavascriptInterface
        fun reject(id: String, error: String) {
            if (scripts.remove(id) == null) return
            Log.e("FreeTubeDecipher", "reject $id: $error")
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
