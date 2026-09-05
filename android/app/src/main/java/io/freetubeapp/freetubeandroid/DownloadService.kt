package io.freetubeapp.freetubeandroid

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.graphics.drawable.Icon
import android.content.Context
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.IBinder
import android.provider.MediaStore
import android.util.Log
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFmpegSession
import com.arthenica.ffmpegkit.ReturnCode
import androidx.documentfile.provider.DocumentFile
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

class DownloadService : Service() {
    companion object {
        const val ACTION_ENQUEUE = "io.freetubeapp.freetubeandroid.download.ENQUEUE"
        const val ACTION_PAUSE = "io.freetubeapp.freetubeandroid.download.PAUSE"
        const val ACTION_RESUME = "io.freetubeapp.freetubeandroid.download.RESUME"
        const val ACTION_CANCEL = "io.freetubeapp.freetubeandroid.download.CANCEL"
        const val ACTION_RETRY = "io.freetubeapp.freetubeandroid.download.RETRY"
        const val ACTION_STATE = "io.freetubeapp.freetubeandroid.download.STATE"
        const val EXTRA_ITEM = "item"
        const val EXTRA_ID = "id"
        private const val CHANNEL = "downloads"
        private const val NOTIFICATION_ID = 2001
        private const val PREFS = "downloads"
        private const val QUEUE = "queue"
        private const val MAX_RETRIES = 4
        private const val TAG = "FreeTubeDownload"

        fun start(context: Context, intent: Intent) {
            androidx.core.content.ContextCompat.startForegroundService(context, intent.setClass(context, DownloadService::class.java))
        }

        fun resumeIfNeeded(context: Context) {
            val queue = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(QUEUE, "[]") ?: "[]"
            if (runCatching {
                val items = JSONArray(queue)
                (0 until items.length()).any { items.getJSONObject(it).optString("status") == "queued" || items.getJSONObject(it).optString("status") == "downloading" }
            }.getOrDefault(false)) start(context, Intent())
        }
    }

    private val executor = Executors.newFixedThreadPool(5)
    private val stopped = AtomicBoolean(false)
    private val activeDownloads = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val connections = java.util.concurrent.ConcurrentHashMap<String, HttpURLConnection>()
    private val ffmpegSessions = java.util.concurrent.ConcurrentHashMap<String, Long>()

    override fun onCreate() {
        super.onCreate()
        createChannel()
        recoverInterruptedDownloads()
        startForeground(NOTIFICATION_ID, notification(null, "Downloads", "Preparing queue", null, false))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_ENQUEUE -> intent.getStringExtra(EXTRA_ITEM)?.let { enqueue(JSONObject(it)) }
            ACTION_PAUSE -> update(intent.getStringExtra(EXTRA_ID), "paused")
            ACTION_RESUME, ACTION_RETRY -> update(intent.getStringExtra(EXTRA_ID), "queued")
            ACTION_CANCEL -> cancel(intent.getStringExtra(EXTRA_ID))
        }
        if (intent?.action != ACTION_ENQUEUE) executor.execute { process() }
        return START_STICKY
    }

    override fun onDestroy() {
        stopped.set(true)
        connections.values.forEach { it.disconnect() }
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

    private fun recoverInterruptedDownloads() {
        val queue = readQueue()
        var changed = false
        for (index in 0 until queue.length()) {
            val item = queue.getJSONObject(index)
            if (item.optString("status") == "downloading") {
                item.put("status", "queued")
                changed = true
            }
            if (item.optString("status") in setOf("queued", "paused") &&
                !targetExists(item.optString("targetUri"))) {
                item.put("status", "failed").put("error", "Download target is unavailable")
                changed = true
            }
        }
        if (changed) writeQueue(queue)
    }

    private fun readQueue(): JSONArray = try {
        JSONArray(prefs().getString(QUEUE, "[]"))
    } catch (_: Exception) {
        JSONArray()
    }

    private fun writeQueue(queue: JSONArray) {
        prefs().edit().putString(QUEUE, queue.toString()).apply()
    }

    private fun broadcast(item: JSONObject) {
        sendBroadcast(Intent(ACTION_STATE).setPackage(packageName)
            .putExtra("id", item.optString("id"))
            .putExtra("title", item.optString("title"))
            .putExtra("status", item.optString("status"))
            .putExtra("phase", item.optString("phase"))
            .putExtra("progress", item.optDouble("progress", 0.0))
            .putExtra("received", item.optLong("received", 0))
            .putExtra("total", item.optLong("total", 0))
            .putExtra("totalExact", item.optBoolean("totalExact", false))
            .putExtra("fileSize", item.optLong("fileSize", 0))
            .putExtra("speedBps", item.optLong("speedBps", 0))
            .putExtra("etaSeconds", item.optLong("etaSeconds", 0))
            .putExtra("error", item.optString("error", "")))
    }

    private fun enqueue(item: JSONObject) {
        val queue = readQueue()
        if ((0 until queue.length()).any { queue.getJSONObject(it).optString("id") == item.optString("id") }) {
            Log.w(TAG, "enqueue ignored duplicate id=${item.optString("id")}")
            return
        }
        item.put("status", "queued").put("progress", JSONObject.NULL).put("totalExact", item.optBoolean("totalExact", false))
        Log.i(TAG, "queue status id=${item.optString("id")} null->queued")
        queue.put(item)
        writeQueue(queue)
        broadcast(item)
        executor.execute { process() }
    }

    private fun update(id: String?, status: String) {
        if (id == null) return
        val queue = readQueue()
        for (index in 0 until queue.length()) {
            val item = queue.getJSONObject(index)
            if (item.optString("id") == id) {
                Log.i(TAG, "queue status id=$id ${item.optString("status")}->$status")
                item.put("status", status).put("error", JSONObject.NULL)
            }
        }
        writeQueue(queue)
        queue.let { q -> (0 until q.length()).map { q.getJSONObject(it) }.firstOrNull { it.optString("id") == id } }?.let(::broadcast)
        if (status == "paused") {
            connections[id]?.disconnect()
            cancelFfmpeg(id)
        }
        executor.execute { process() }
    }

    private fun cancel(id: String?) {
        if (id == null) return
        connections[id]?.disconnect()
        cancelFfmpeg(id)
        val queue = readQueue()
        for (index in 0 until queue.length()) {
            val item = queue.getJSONObject(index)
            if (item.optString("id") == id) {
                Log.i(TAG, "queue status id=$id ${item.optString("status")}->canceled")
                item.put("status", "canceled")
                delete(item.optString("targetUri"))
            }
        }
        writeQueue(queue)
        queue.let { q -> (0 until q.length()).map { q.getJSONObject(it) }.firstOrNull { it.optString("id") == id } }?.let(::broadcast)
        executor.execute { process() }
    }

    private fun process() {
        val items = mutableListOf<JSONObject>()
        synchronized(this) {
            val queue = readQueue()
            for (index in 0 until queue.length()) {
                if (activeDownloads.size + items.size >= prefs().getInt("maxConcurrent", 5).coerceIn(1, 5)) break
                val item = queue.getJSONObject(index)
                val id = item.optString("id")
                if (item.optString("status") == "queued" && activeDownloads.add(id)) {
                    Log.i(TAG, "queue status id=$id queued->downloading active=${activeDownloads.size}")
                    item.put("status", "downloading")
                    items += item
                }
            }
            if (items.isNotEmpty()) {
                writeQueue(queue)
                items.forEach(::broadcast)
            }
        }
        items.forEach { item ->
            executor.execute {
                try {
                    download(item)
                    verifyCompletedTarget(item)
                    Log.i(TAG, "queue status id=${item.optString("id")} downloading->completed received=${item.optLong("received", 0)} total=${item.optLong("total", 0)}")
                    item.put("status", "completed").put("phase", "completed").put("progress", 1).put("speedBps", 0).put("etaSeconds", 0)
                    item.put("targetUri", rename(item.optString("targetUri"), item.optString("finalName")))
                    publish(item.optString("targetUri"))
                    item.put("fileSize", length(Uri.parse(item.optString("targetUri"))))
                    notify(item.optString("id"), item.optString("title"), "Download complete", null, false)
                } catch (error: Exception) {
                    val currentState = readQueue().let { q ->
                        (0 until q.length()).map { q.getJSONObject(it) }
                            .firstOrNull { it.optString("id") == item.optString("id") }?.optString("status")
                    }
                    val status = if (currentState == "paused" || currentState == "canceled") currentState else "failed"
                    Log.e(TAG, "queue status id=${item.optString("id")} $currentState->$status error=${error.message}", error)
                    item.put("status", status).put("phase", status).put("error", if (status == "failed") error.message ?: "Download failed" else JSONObject.NULL)
                    notify(item.optString("id"), item.optString("title"), item.optString("error"), null, false)
                } finally {
                    connections.remove(item.optString("id"))?.disconnect()
                    activeDownloads.remove(item.optString("id"))
                    saveItem(item)
                    process()
                }
            }
        }
        if (items.isEmpty() && activeDownloads.isEmpty() && readQueue().let { q -> (0 until q.length()).none { q.getJSONObject(it).optString("status") == "queued" } }) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun targetFile(uri: String): java.io.File? = uri.takeIf { it.startsWith("data://") }
        ?.let { java.io.File(filesDir, "data/${it.removePrefix("data://")}") }

    private fun targetExists(uriString: String): Boolean = targetFile(uriString)?.exists()
        ?: DocumentFile.fromSingleUri(this, Uri.parse(uriString))?.exists() == true

    private fun publish(uri: String) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q &&
            Uri.parse(uri).authority == MediaStore.AUTHORITY) {
            contentResolver.update(Uri.parse(uri), ContentValues().apply {
                put(MediaStore.MediaColumns.IS_PENDING, 0)
            }, null, null)
        }
    }

    private fun openTarget(uri: String, mode: String): OutputStream = targetFile(uri)?.let {
        it.parentFile?.mkdirs()
        java.io.FileOutputStream(it, mode == "wa")
    } ?: contentResolver.openOutputStream(Uri.parse(uri), mode)
        ?: throw IllegalStateException("Unable to open download target")

    private fun download(item: JSONObject) {
        val url = item.getString("videoUrl")
        require(url.startsWith("https://")) { "Invalid download URL" }
        val audioUrl = item.optString("audioUrl")
        if (audioUrl.isNotBlank()) {
            val videoFile = java.io.File(cacheDir, "${item.optString("id")}-video.mp4")
            val audioFile = java.io.File(cacheDir, "${item.optString("id")}-audio.mp4")
            val outputFile = java.io.File(cacheDir, "${item.optString("id")}-output.mp4")
            val videoTotal = item.optLong("videoTotal", 0)
            val audioTotal = item.optLong("audioTotal", 0)
            val expectedTotal = if (videoTotal > 0 && audioTotal > 0) videoTotal + audioTotal else 0
            try {
                withRetries { downloadToFile(url, videoFile, item, 0, expectedTotal, "video") }
                val completedVideoBytes = videoFile.length()
                withRetries { downloadToFile(audioUrl, audioFile, item, completedVideoBytes, expectedTotal, "audio") }
                val received = videoFile.length() + audioFile.length()
                val total = item.optLong("total", 0).takeIf { it > 0 } ?: received
                item.put("phase", "processing").put("progress", 0).put("received", received).put("total", total).put("speedBps", 0).put("etaSeconds", 0)
                saveItem(item)
                notify(item.optString("id"), item.optString("title"), "Processing", 0.0, true)
                muxMp4(item, videoFile, audioFile, outputFile)
                openTarget(item.getString("targetUri"), "wt").use { stream -> outputFile.inputStream().use { input -> input.copyTo(stream) } }
            } finally {
                videoFile.delete()
                audioFile.delete()
                outputFile.delete()
            }
            return
        }
        item.put("phase", "video")
        withRetries { downloadSingleFile(url, Uri.parse(item.getString("targetUri")), item) }
    }

    private fun <T> withRetries(action: () -> T): T {
        var attempt = 0
        while (true) {
            try {
                return action()
            } catch (error: Exception) {
                val retryable = isRetryable(error)
                if (error is java.net.SocketTimeoutException) Log.w(TAG, "no progress timeout attempt=${attempt + 1}")
                Log.w(TAG, "download attempt=${attempt + 1} failed retryable=$retryable error=${error.message}", error)
                if (error is InterruptedException || !retryable || attempt++ >= MAX_RETRIES) throw error
                Log.i(TAG, "download retry attempt=${attempt + 1} delayMs=${1000L shl (attempt - 1)}")
                Thread.sleep(1000L shl (attempt - 1))
            }
        }
    }

    private fun isRetryable(error: Exception): Boolean = when (error) {
        is IOException -> true
        else -> error.message?.matches(Regex("HTTP (408|429|5\\d{2})")) == true
    }

    private fun downloadSingleFile(url: String, target: Uri, item: JSONObject) {
        val existing = length(target)
        val request = URL(url).openConnection() as HttpURLConnection
        connections[item.optString("id")] = request
        try {
            request.connectTimeout = 15_000
            request.readTimeout = 30_000
            request.instanceFollowRedirects = true
            if (existing > 0) request.setRequestProperty("Range", "bytes=$existing-")
            request.connect()
            val response = request.responseCode
            Log.i(TAG, "HTTP response id=${item.optString("id")} code=$response existing=$existing requestedRange=${existing > 0} contentLength=${request.contentLengthLong}")
            if (response !in 200..299) throw IllegalStateException("HTTP $response")
            val append = existing > 0 && response == HttpURLConnection.HTTP_PARTIAL
            if (existing > 0 && !append) Log.w(TAG, "resume rejected id=${item.optString("id")} existing=$existing code=$response; restarting")
            val receivedStart = if (append) existing else 0L
            val total = if (request.contentLengthLong > 0) receivedStart + request.contentLengthLong else 0L
            item.put("total", total)
                .put("totalExact", total > 0)
                .put("progress", if (total > 0) receivedStart.toDouble() / total else JSONObject.NULL)
                .put("received", receivedStart)
                .put("speedBps", 0)
                .put("etaSeconds", 0)
            saveItem(item)
            openTarget(target.toString(), if (append) "wa" else "wt").use { output ->
                request.inputStream.use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var received = receivedStart
                    var lastBytes = received
                    var lastTime = System.nanoTime()
                    var lastProgressTime = lastTime
                    var lastLoggedSpeed = 0L
                    var lastPublishedAt = lastTime
                    while (true) {
                        checkDownloadState(item)
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        received += count
                        val now = System.nanoTime()
                        val elapsed = (now - lastTime) / 1_000_000_000.0
                        val speed = if (elapsed > 0) ((received - lastBytes) / elapsed).toLong() else 0L
                        val progress = total.takeIf { it > 0 }?.let { (received.toDouble() / it).coerceIn(0.0, 1.0) }
                        if (speed > 0 && lastLoggedSpeed > 0 && (speed > lastLoggedSpeed * 2 || speed * 2 < lastLoggedSpeed)) Log.w(TAG, "speed jump id=${item.optString("id")} $lastLoggedSpeed->$speed received=$received")
                        if (received == lastBytes && now - lastProgressTime > 5_000_000_000L) Log.w(TAG, "no progress id=${item.optString("id")} received=$received total=$total")
                        if (received > lastBytes) lastProgressTime = now
                        lastLoggedSpeed = speed
                        item.put("progress", progress ?: JSONObject.NULL).put("received", received).put("total", total).put("totalExact", total > 0).put("speedBps", speed)
                        if (speed > 0 && total > 0) item.put("etaSeconds", ((total - received) / speed).toLong())
                        lastBytes = received
                        lastTime = now
                        if (now - lastPublishedAt >= 250_000_000L) {
                            lastPublishedAt = now
                            saveItem(item)
                            notify(item.optString("id"), item.optString("title"), progress?.let { "Downloading ${"%.0f".format(it * 100)}%" } ?: "Downloading", progress, true)
                        }
                    }
                    saveItem(item)
                    notify(item.optString("id"), item.optString("title"), "Downloading", 1.0, true)
                    if (total > 0 && received != total) throw IOException("Incomplete download: $received/$total")
                }
            }
        } finally {
            request.disconnect()
            connections.remove(item.optString("id"))
        }
    }

    private fun downloadToFile(url: String, target: java.io.File, item: JSONObject, completedBytes: Long, expectedTotal: Long, phase: String) {
        val existing = target.length()
        val request = URL(url).openConnection() as HttpURLConnection
        connections[item.optString("id")] = request
        try {
            request.connectTimeout = 15_000
            request.readTimeout = 30_000
            request.instanceFollowRedirects = true
            if (existing > 0) request.setRequestProperty("Range", "bytes=$existing-")
            request.connect()
            val response = request.responseCode
            Log.i(TAG, "HTTP response id=${item.optString("id")} code=$response existing=$existing requestedRange=${existing > 0} contentLength=${request.contentLengthLong}")
            if (response !in 200..299) throw IllegalStateException("HTTP $response")
            val append = existing > 0 && response == HttpURLConnection.HTTP_PARTIAL
            if (existing > 0 && !append) Log.w(TAG, "resume rejected id=${item.optString("id")} existing=$existing code=$response; restarting")
            val receivedStart = if (append) existing else 0L
            val aggregateStart = completedBytes + receivedStart
            val componentTotal = if (request.contentLengthLong > 0) receivedStart + request.contentLengthLong else -1L
            val total = when {
                expectedTotal > 0 -> expectedTotal
                phase == "audio" && componentTotal > 0 -> completedBytes + componentTotal
                else -> 0L
            }
            item.put("phase", phase)
                .put("total", total)
                .put("totalExact", total > 0)
                .put("progress", if (total > 0) aggregateStart.toDouble() / total else JSONObject.NULL)
                .put("received", aggregateStart)
                .put("speedBps", 0)
                .put("etaSeconds", 0)
            saveItem(item)
            java.io.FileOutputStream(target, append).use { output ->
                request.inputStream.use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var received = receivedStart
                    var lastBytes = received
                    var lastTime = System.nanoTime()
                    var lastProgressTime = lastTime
                    var lastLoggedSpeed = 0L
                    var lastPublishedAt = lastTime
                    while (true) {
                        checkDownloadState(item)
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        received += count
                        val now = System.nanoTime()
                        val elapsed = (now - lastTime) / 1_000_000_000.0
                        val speed = if (elapsed > 0) ((received - lastBytes) / elapsed).toLong() else 0L
                        val aggregateReceived = completedBytes + received
                        val progress = total.takeIf { it > 0 }?.let { (aggregateReceived.toDouble() / it).coerceIn(0.0, 1.0) }
                        if (speed > 0 && lastLoggedSpeed > 0 && (speed > lastLoggedSpeed * 2 || speed * 2 < lastLoggedSpeed)) Log.w(TAG, "speed jump id=${item.optString("id")} $lastLoggedSpeed->$speed received=$aggregateReceived")
                        if (received == lastBytes && now - lastProgressTime > 5_000_000_000L) Log.w(TAG, "no progress id=${item.optString("id")} received=$aggregateReceived total=$total")
                        if (received > lastBytes) lastProgressTime = now
                        lastLoggedSpeed = speed
                        item.put("progress", progress ?: JSONObject.NULL).put("received", aggregateReceived).put("total", total).put("totalExact", total > 0).put("speedBps", speed)
                        if (speed > 0 && total > 0) item.put("etaSeconds", ((total - aggregateReceived).coerceAtLeast(0) / speed).toLong())
                        lastBytes = received
                        lastTime = now
                        if (now - lastPublishedAt >= 250_000_000L) {
                            lastPublishedAt = now
                            saveItem(item)
                            notify(item.optString("id"), item.optString("title"), progress?.let { "Downloading ${"%.0f".format(it * 100)}%" } ?: "Downloading", progress, true)
                        }
                    }
                    saveItem(item)
                    notify(item.optString("id"), item.optString("title"), "Downloading", 1.0, true)
                    if (componentTotal > 0 && received != componentTotal) throw IOException("Incomplete download: $received/$componentTotal")
                }
            }
        } finally {
            request.disconnect()
            connections.remove(item.optString("id"))
        }
    }

    private fun verifyCompletedTarget(item: JSONObject) {
        val uri = item.optString("targetUri")
        val actual = length(Uri.parse(uri))
        Log.i(TAG, "completed target id=${item.optString("id")} exists=${targetExists(uri)} actual=$actual received=${item.optLong("received", 0)} total=${item.optLong("total", 0)} progress=${item.optDouble("progress", 0.0)}")
        if (!targetExists(uri) || actual <= 0) throw IOException("Completed download target is empty")
    }

    private fun checkDownloadState(item: JSONObject) {
        if (stopped.get()) throw InterruptedException("Download stopped")
        val state = readQueue().let { queue ->
            (0 until queue.length()).map { queue.getJSONObject(it) }
                .firstOrNull { it.optString("id") == item.optString("id") }?.optString("status")
        }
        if (state == "paused" || state == "canceled") throw InterruptedException("Download $state")
    }

    @Synchronized
    private fun saveItem(item: JSONObject) {
        val queue = readQueue()
        for (index in 0 until queue.length()) if (queue.getJSONObject(index).optString("id") == item.optString("id")) queue.put(index, item)
        writeQueue(queue)
        broadcast(item)
    }

    private fun muxMp4(item: JSONObject, videoFile: java.io.File, audioFile: java.io.File, outputFile: java.io.File) {
        val downloadId = item.optString("id")
        val completed = CountDownLatch(1)
        val result = AtomicReference<FFmpegSession>()
        val durationMs = item.optLong("durationMs", 0)
        val session = FFmpegKit.executeAsync(
            "-y -i ${ffmpegArg(videoFile)} -i ${ffmpegArg(audioFile)} " +
                "-map 0:v:0 -map 1:a:0 -c copy ${ffmpegArg(outputFile)}",
            { finished ->
                result.set(finished)
                completed.countDown()
            },
            null,
            { statistics ->
                if (durationMs > 0) {
                    val progress = (statistics.time / durationMs.toDouble()).coerceIn(0.0, 0.99)
                    item.put("progress", progress).put("speedBps", 0).put("etaSeconds", 0)
                    saveItem(item)
                    notify(downloadId, item.optString("title"), "Processing ${"%.0f".format(progress * 100)}%", progress, true)
                }
            }
        )
        ffmpegSessions[downloadId] = session.sessionId
        try {
            completed.await()
        } finally {
            ffmpegSessions.remove(downloadId, session.sessionId)
        }
        val finished = result.get() ?: throw IOException("FFmpeg mux returned no session")
        if (!ReturnCode.isSuccess(finished.returnCode)) {
            val details = finished.failStackTrace ?: finished.allLogsAsString
            throw if (ReturnCode.isCancel(finished.returnCode)) {
                InterruptedException("FFmpeg mux canceled")
            } else {
                IOException("FFmpeg mux failed: ${details?.takeLast(2000) ?: "unknown error"}")
            }
        }
    }

    private fun cancelFfmpeg(downloadId: String) {
        ffmpegSessions.remove(downloadId)?.let(FFmpegKit::cancel)
    }

    private fun ffmpegArg(file: java.io.File): String =
        "'${file.absolutePath.replace("'", "'\\\"'\\\"'")}'"

    private fun length(uri: Uri): Long = try {
        targetFile(uri.toString())?.length() ?: contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length.coerceAtLeast(0) } ?: 0
    } catch (_: Exception) { 0 }

    private fun rename(uriString: String, finalName: String): String {
        if (finalName.isBlank()) return uriString
        targetFile(uriString)?.let { source ->
            val target = java.io.File(source.parentFile, finalName)
            if (!source.renameTo(target) && source.name != finalName) throw IOException("Unable to rename download target")
            return "data://${target.relativeTo(java.io.File(filesDir, "data")).path}"
        }
        val uri = Uri.parse(uriString)
        if (uri.authority == MediaStore.AUTHORITY) {
            if (contentResolver.update(uri, ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, finalName)
                }, null, null) == 0) throw IOException("Unable to rename download target")
            return uriString
        }
        val target = DocumentFile.fromSingleUri(this, uri)
        if (target?.name != finalName && target?.renameTo(finalName) != true) throw IOException("Unable to rename download target")
        return target.uri.toString()
    }

    private fun delete(uriString: String) {
        runCatching { targetFile(uriString)?.delete() ?: DocumentFile.fromSingleUri(this, Uri.parse(uriString))?.delete() }
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW)
        )
    }

    private fun notification(id: String?, title: String, text: String, progress: Double?, ongoing: Boolean): Notification {
        val current = currentItem(id)
        val activeCount = readQueue().let { queue -> (0 until queue.length()).count { queue.getJSONObject(it).optString("status") == "downloading" } }
        val speed = current?.optLong("speedBps", 0) ?: 0
        val received = current?.optLong("received", 0) ?: 0
        val total = current?.optLong("total", 0) ?: 0
        val details = buildString {
            append(text)
            if (total > 0) append(" · ${formatSize(received)} / ${formatSize(total)}")
            if (speed > 0) append(" · ${formatRate(speed)}/s")
            if (activeCount > 1) append(" · $activeCount active")
        }
        val builder = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_media_notification_icon)
            .setContentTitle(title)
            .setContentText(details)
            .setOnlyAlertOnce(true)
            .setOngoing(ongoing)
        if (progress != null) builder.setProgress(100, (progress * 100).toInt().coerceIn(0, 100), false)
        else if (ongoing && current != null) builder.setProgress(0, 0, true)
        if (current == null) return builder.build()
        if (current.optString("status") == "downloading") builder.addAction(action("Pause", ACTION_PAUSE, current.optString("id")))
        if (current.optString("status") == "paused") builder.addAction(action("Resume", ACTION_RESUME, current.optString("id")))
        if (current.optString("status") in setOf("downloading", "paused")) {
            builder.addAction(action("Cancel", ACTION_CANCEL, current.optString("id")))
        }
        return builder.build()
    }

    private fun action(label: String, action: String, id: String): Notification.Action {
        val intent = Intent(this, DownloadService::class.java).setAction(action).putExtra(EXTRA_ID, id)
        val pending = PendingIntent.getService(this, "$id:$action".hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_media_notification_icon), label, pending).build()
    }

    private fun formatSize(bytes: Long): String = when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> "${bytes / 1024} KB"
        else -> "${bytes / (1024 * 1024)} MB"
    }

    private fun formatRate(bytesPerSecond: Long): String {
        if (bytesPerSecond < 1024) return "$bytesPerSecond B"
        if (bytesPerSecond < 1024 * 1024) return "${bytesPerSecond / 1024} KB"
        return "${bytesPerSecond / (1024 * 1024)} MB"
    }

    private fun currentItem(id: String?): JSONObject? = readQueue().let { queue ->
        (0 until queue.length()).map { queue.getJSONObject(it) }
            .firstOrNull { item ->
                if (id != null) item.optString("id") == id
                else item.optString("status") == "downloading" || item.optString("status") == "paused"
            }
    }

    private fun notificationId(id: String): Int = 3000 + (id.hashCode() and 0x7fffffff) % 100000

    private fun notify(id: String, title: String, text: String, progress: Double?, ongoing: Boolean) {
        val manager = getSystemService(NotificationManager::class.java)
        if (!ongoing) {
            Log.i(TAG, "notification terminal id=$id text=$text")
            manager.cancel(notificationId(id))
            return
        }
        Log.d(TAG, "notification progress id=$id progress=${progress ?: -1.0} text=$text")
        manager.notify(notificationId(id), notification(id, title, text, progress, true))
    }
}
