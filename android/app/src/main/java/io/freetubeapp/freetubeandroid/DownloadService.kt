package io.freetubeapp.freetubeandroid

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.graphics.drawable.Icon
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.IBinder
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaMuxer
import androidx.documentfile.provider.DocumentFile
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

class DownloadService : Service() {
    companion object {
        const val ACTION_ENQUEUE = "io.freetubeapp.freetubeandroid.download.ENQUEUE"
        const val ACTION_PAUSE = "io.freetubeapp.freetubeandroid.download.PAUSE"
        const val ACTION_RESUME = "io.freetubeapp.freetubeandroid.download.RESUME"
        const val ACTION_CANCEL = "io.freetubeapp.freetubeandroid.download.CANCEL"
        const val ACTION_RETRY = "io.freetubeapp.freetubeandroid.download.RETRY"
        const val EXTRA_ITEM = "item"
        const val EXTRA_ID = "id"
        private const val CHANNEL = "downloads"
        private const val NOTIFICATION_ID = 2001
        private const val PREFS = "downloads"
        private const val QUEUE = "queue"
        private const val MAX_RETRIES = 4

        fun start(context: Context, intent: Intent) {
            androidx.core.content.ContextCompat.startForegroundService(context, intent.setClass(context, DownloadService::class.java))
        }
    }

    private val executor = Executors.newFixedThreadPool(5)
    private val stopped = AtomicBoolean(false)
    private val activeDownloads = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val connections = java.util.concurrent.ConcurrentHashMap<String, HttpURLConnection>()

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
                DocumentFile.fromSingleUri(this, Uri.parse(item.optString("targetUri")))?.exists() != true) {
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

    private fun enqueue(item: JSONObject) {
        val queue = readQueue()
        if ((0 until queue.length()).any { queue.getJSONObject(it).optString("id") == item.optString("id") }) return
        item.put("status", "queued").put("progress", 0)
        queue.put(item)
        writeQueue(queue)
        executor.execute { process() }
    }

    private fun update(id: String?, status: String) {
        if (id == null) return
        val queue = readQueue()
        for (index in 0 until queue.length()) {
            val item = queue.getJSONObject(index)
            if (item.optString("id") == id) item.put("status", status).put("error", JSONObject.NULL)
        }
        writeQueue(queue)
        if (status == "paused") connections[id]?.disconnect()
        executor.execute { process() }
    }

    private fun cancel(id: String?) {
        if (id == null) return
        connections[id]?.disconnect()
        val queue = readQueue()
        for (index in 0 until queue.length()) {
            val item = queue.getJSONObject(index)
            if (item.optString("id") == id) {
                item.put("status", "canceled")
                delete(item.optString("targetUri"))
            }
        }
        writeQueue(queue)
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
                    item.put("status", "downloading")
                    items += item
                }
            }
            if (items.isNotEmpty()) writeQueue(queue)
        }
        items.forEach { item ->
            executor.execute {
                try {
                    download(item)
                    item.put("status", "completed").put("progress", 1)
                    rename(item.optString("targetUri"), item.optString("finalName"))
                    notify(item.optString("id"), item.optString("title"), "Download complete", null, false)
                } catch (error: Exception) {
                    val currentState = readQueue().let { q ->
                        (0 until q.length()).map { q.getJSONObject(it) }
                            .firstOrNull { it.optString("id") == item.optString("id") }?.optString("status")
                    }
                    val status = if (currentState == "paused" || currentState == "canceled") currentState else "failed"
                    item.put("status", status).put("error", error.message ?: "Download failed")
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
            try {
                withRetries { downloadToFile(url, videoFile, item, 0.0, 0.5) }
                withRetries { downloadToFile(audioUrl, audioFile, item, 0.5, 0.5) }
                muxMp4(videoFile, audioFile, outputFile)
                openTarget(item.getString("targetUri"), "wt").use { stream -> outputFile.inputStream().use { input -> input.copyTo(stream) } }
            } finally {
                videoFile.delete()
                audioFile.delete()
                outputFile.delete()
            }
            return
        }
        withRetries { downloadSingleFile(url, Uri.parse(item.getString("targetUri")), item) }
    }

    private fun <T> withRetries(action: () -> T): T {
        var attempt = 0
        while (true) {
            try {
                return action()
            } catch (error: Exception) {
                if (error is InterruptedException || !isRetryable(error) || attempt++ >= MAX_RETRIES) throw error
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
            if (response !in 200..299) throw IllegalStateException("HTTP $response")
            val append = existing > 0 && response == HttpURLConnection.HTTP_PARTIAL
            val receivedStart = if (append) existing else 0L
            val total = if (request.contentLengthLong > 0) receivedStart + request.contentLengthLong else -1L
            openTarget(target.toString(), if (append) "wa" else "wt").use { output ->
                request.inputStream.use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var received = receivedStart
                    var lastBytes = received
                    var lastTime = System.nanoTime()
                    while (true) {
                        checkDownloadState(item)
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        received += count
                        val now = System.nanoTime()
                        val elapsed = (now - lastTime) / 1_000_000_000.0
                        val speed = if (elapsed > 0) ((received - lastBytes) / elapsed).toLong() else 0L
                        val progress = if (total > 0) received.toDouble() / total else 0.0
                        item.put("progress", progress).put("received", received).put("total", total).put("speedBps", speed)
                        if (speed > 0 && total > 0) item.put("etaSeconds", ((total - received) / speed).toLong())
                        lastBytes = received
                        lastTime = now
                        saveItem(item)
                        notify(item.optString("id"), item.optString("title"), "Downloading ${"%.0f".format(progress * 100)}%", progress, true)
                    }
                    if (total > 0 && received != total) throw IOException("Incomplete download: $received/$total")
                }
            }
        } finally {
            request.disconnect()
            connections.remove(item.optString("id"))
        }
    }

    private fun downloadToFile(url: String, target: java.io.File, item: JSONObject, base: Double, weight: Double) {
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
            if (response !in 200..299) throw IllegalStateException("HTTP $response")
            val append = existing > 0 && response == HttpURLConnection.HTTP_PARTIAL
            val receivedStart = if (append) existing else 0L
            val total = if (request.contentLengthLong > 0) receivedStart + request.contentLengthLong else -1L
            java.io.FileOutputStream(target, append).use { output ->
                request.inputStream.use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var received = receivedStart
                    var lastBytes = received
                    var lastTime = System.nanoTime()
                    while (true) {
                        checkDownloadState(item)
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        received += count
                        val now = System.nanoTime()
                        val elapsed = (now - lastTime) / 1_000_000_000.0
                        val speed = if (elapsed > 0) ((received - lastBytes) / elapsed).toLong() else 0L
                        val progress = if (total > 0) received.toDouble() / total else 0.0
                        item.put("progress", base + progress * weight).put("received", received).put("total", total).put("speedBps", speed)
                        if (speed > 0 && total > 0) item.put("etaSeconds", ((total - received) / speed).toLong())
                        lastBytes = received
                        lastTime = now
                        saveItem(item)
                        notify(item.optString("id"), item.optString("title"), "Downloading ${"%.0f".format(item.optDouble("progress") * 100)}%", item.optDouble("progress"), true)
                    }
                    if (total > 0 && received != total) throw IOException("Incomplete download: $received/$total")
                }
            }
        } finally {
            request.disconnect()
            connections.remove(item.optString("id"))
        }
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
    }

    private fun muxMp4(videoFile: java.io.File, audioFile: java.io.File, outputFile: java.io.File) {
        val videoExtractor = MediaExtractor()
        val audioExtractor = MediaExtractor()
        val muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        try {
            videoExtractor.setDataSource(videoFile.absolutePath)
            audioExtractor.setDataSource(audioFile.absolutePath)
            val videoTrack = (0 until videoExtractor.trackCount).firstOrNull { videoExtractor.getTrackFormat(it).getString(android.media.MediaFormat.KEY_MIME)?.startsWith("video/") == true }
                ?: throw IllegalStateException("Video track not found")
            val audioTrack = (0 until audioExtractor.trackCount).firstOrNull { audioExtractor.getTrackFormat(it).getString(android.media.MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
                ?: throw IllegalStateException("Audio track not found")
            val muxVideoTrack = muxer.addTrack(videoExtractor.getTrackFormat(videoTrack))
            val muxAudioTrack = muxer.addTrack(audioExtractor.getTrackFormat(audioTrack))
            muxer.start()
            copySamples(videoExtractor, videoTrack, muxer, muxVideoTrack)
            copySamples(audioExtractor, audioTrack, muxer, muxAudioTrack)
        } finally {
            runCatching { muxer.stop() }
            videoExtractor.release()
            audioExtractor.release()
            muxer.release()
        }
    }

    private fun copySamples(extractor: MediaExtractor, sourceTrack: Int, muxer: MediaMuxer, targetTrack: Int) {
        extractor.selectTrack(sourceTrack)
        val buffer = java.nio.ByteBuffer.allocate(1024 * 1024)
        val info = MediaCodec.BufferInfo()
        while (true) {
            val size = extractor.readSampleData(buffer, 0)
            if (size < 0) break
            info.offset = 0
            info.size = size
            info.presentationTimeUs = extractor.sampleTime
            info.flags = extractor.sampleFlags
            muxer.writeSampleData(targetTrack, buffer, info)
            extractor.advance()
        }
    }

    private fun length(uri: Uri): Long = try {
        targetFile(uri.toString())?.length() ?: contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length.coerceAtLeast(0) } ?: 0
    } catch (_: Exception) { 0 }

    private fun rename(uriString: String, finalName: String) {
        if (finalName.isBlank()) return
        targetFile(uriString)?.let { it.renameTo(java.io.File(it.parentFile, finalName)); return }
        DocumentFile.fromSingleUri(this, Uri.parse(uriString))?.renameTo(finalName)
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
        if (current == null) return builder.build()
        if (current.optString("status") == "downloading") builder.addAction(action("Pause", ACTION_PAUSE, current.optString("id")))
        if (current.optString("status") == "paused") builder.addAction(action("Resume", ACTION_RESUME, current.optString("id")))
        builder.addAction(action("Cancel", ACTION_CANCEL, current.optString("id")))
        return builder.build()
    }

    private fun action(label: String, action: String, id: String): Notification.Action {
        val intent = Intent(this, DownloadService::class.java).setAction(action).putExtra(EXTRA_ID, id)
        val pending = PendingIntent.getService(this, action.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
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
        getSystemService(NotificationManager::class.java).notify(notificationId(id), notification(id, title, text, progress, ongoing))
    }
}
