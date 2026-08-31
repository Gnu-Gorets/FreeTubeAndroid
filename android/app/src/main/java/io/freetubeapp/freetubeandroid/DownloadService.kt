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

        fun start(context: Context, intent: Intent) {
            androidx.core.content.ContextCompat.startForegroundService(context, intent.setClass(context, DownloadService::class.java))
        }
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val stopped = AtomicBoolean(false)
    private var connection: HttpURLConnection? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        recoverInterruptedDownloads()
        startForeground(NOTIFICATION_ID, notification("Downloads", "Preparing queue", null, false))
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
        connection?.disconnect()
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
        if (status == "paused") connection?.disconnect()
        executor.execute { process() }
    }

    private fun cancel(id: String?) {
        if (id == null) return
        connection?.disconnect()
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
        synchronized(this) {
            val queue = readQueue()
            val item = (0 until queue.length()).map { queue.getJSONObject(it) }
                .firstOrNull { it.optString("status") == "queued" } ?: run {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                    return
                }
            item.put("status", "downloading")
            writeQueue(queue)
            try {
                download(item)
                item.put("status", "completed").put("progress", 1)
                rename(item.optString("targetUri"), item.optString("finalName"))
                notify(item.optString("title"), "Download complete", null, false)
            } catch (error: Exception) {
                val currentState = readQueue().let { q ->
                    (0 until q.length()).map { q.getJSONObject(it) }
                        .firstOrNull { it.optString("id") == item.optString("id") }?.optString("status")
                }
                val status = if (currentState == "paused" || currentState == "canceled") currentState else "failed"
                item.put("status", status).put("error", error.message ?: "Download failed")
                notify(item.optString("title"), item.optString("error"), null, false)
            } finally {
                connection?.disconnect()
                connection = null
                writeQueue(queue)
            }
            process()
        }
    }

    private fun download(item: JSONObject) {
        val url = item.getString("videoUrl")
        require(url.startsWith("https://")) { "Invalid download URL" }
        val audioUrl = item.optString("audioUrl")
        if (audioUrl.isNotBlank()) {
            val videoFile = java.io.File(cacheDir, "${item.optString("id")}-video.mp4")
            val audioFile = java.io.File(cacheDir, "${item.optString("id")}-audio.mp4")
            val outputFile = java.io.File(cacheDir, "${item.optString("id")}-output.mp4")
            try {
                downloadToFile(url, videoFile, item, 0.0, 0.5)
                downloadToFile(audioUrl, audioFile, item, 0.5, 0.5)
                muxMp4(videoFile, audioFile, outputFile)
                val output = contentResolver.openOutputStream(Uri.parse(item.getString("targetUri")), "wt")
                    ?: throw IllegalStateException("Unable to open download target")
                output.use { stream ->
                    outputFile.inputStream().use { input -> input.copyTo(stream) }
                }
            } finally {
                videoFile.delete()
                audioFile.delete()
                outputFile.delete()
            }
            return
        }
        val target = Uri.parse(item.getString("targetUri"))
        val existing = length(target)
        connection = URL(url).openConnection() as HttpURLConnection
        connection!!.apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            if (existing > 0) setRequestProperty("Range", "bytes=$existing-")
            connect()
        }
        val response = connection!!.responseCode
        val append = existing > 0 && response == HttpURLConnection.HTTP_PARTIAL
        if (response !in 200..299) throw IllegalStateException("HTTP $response")
        val receivedStart = if (append) existing else 0L
        val total = if (connection!!.contentLengthLong > 0) receivedStart + connection!!.contentLengthLong else -1L
        contentResolver.openOutputStream(target, if (append) "wa" else "wt")?.use { output ->
            connection!!.inputStream.use { input ->
                val buffer = ByteArray(64 * 1024)
                var received = receivedStart
                while (true) {
                    if (stopped.get()) throw InterruptedException("Download stopped")
                    val state = readQueue().let { q -> (0 until q.length()).map { q.getJSONObject(it) }.firstOrNull { it.optString("id") == item.optString("id") }?.optString("status") }
                    if (state == "paused") throw InterruptedException("Download paused")
                    if (state == "canceled") throw InterruptedException("Download canceled")
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                    received += count
                    val progress = if (total > 0) received.toDouble() / total else 0.0
                    item.put("progress", progress).put("received", received).put("total", total)
                    val queue = readQueue()
                    for (index in 0 until queue.length()) if (queue.getJSONObject(index).optString("id") == item.optString("id")) queue.put(index, item)
                    writeQueue(queue)
                    notify(item.optString("title"), "Downloading ${"%.0f".format(progress * 100)}%", progress, true)
                }
            }
        } ?: throw IllegalStateException("Unable to open download target")
    }

    private fun downloadToFile(url: String, target: java.io.File, item: JSONObject, base: Double, weight: Double) {
        connection = URL(url).openConnection() as HttpURLConnection
        connection!!.apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            connect()
        }
        if (connection!!.responseCode !in 200..299) throw IllegalStateException("HTTP ${connection!!.responseCode}")
        val total = connection!!.contentLengthLong
        var received = 0L
        target.outputStream().use { output ->
            connection!!.inputStream.use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val state = readQueue().let { q -> (0 until q.length()).map { q.getJSONObject(it) }.firstOrNull { it.optString("id") == item.optString("id") }?.optString("status") }
                    if (state == "paused" || state == "canceled") throw InterruptedException("Download $state")
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                    received += count
                    val progress = if (total > 0) received.toDouble() / total else 0.0
                    item.put("progress", base + progress * weight)
                    writeQueue(readQueue().also { queue -> for (index in 0 until queue.length()) if (queue.getJSONObject(index).optString("id") == item.optString("id")) queue.put(index, item) })
                    notify(item.optString("title"), "Downloading ${"%.0f".format(item.optDouble("progress") * 100)}%", item.optDouble("progress"), true)
                }
            }
        }
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
        contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length.coerceAtLeast(0) } ?: 0
    } catch (_: Exception) { 0 }

    private fun rename(uriString: String, finalName: String) {
        if (finalName.isBlank()) return
        val uri = Uri.parse(uriString)
        val file = DocumentFile.fromSingleUri(this, uri) ?: return
        file.renameTo(finalName)
    }

    private fun delete(uriString: String) {
        runCatching { DocumentFile.fromSingleUri(this, Uri.parse(uriString))?.delete() }
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW)
        )
    }

    private fun notification(title: String, text: String, progress: Double?, ongoing: Boolean): Notification {
        val builder = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_media_notification_icon)
            .setContentTitle(title)
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(ongoing)
        if (progress != null) builder.setProgress(100, (progress * 100).toInt().coerceIn(0, 100), false)
        val current = currentItem() ?: return builder.build()
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

    private fun currentItem(): JSONObject? = readQueue().let { queue ->
        (0 until queue.length()).map { queue.getJSONObject(it) }
            .firstOrNull { it.optString("status") == "downloading" || it.optString("status") == "paused" }
    }

    private fun notify(title: String, text: String, progress: Double?, ongoing: Boolean) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(title, text, progress, ongoing))
    }
}
