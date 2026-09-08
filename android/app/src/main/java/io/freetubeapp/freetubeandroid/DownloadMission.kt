package io.freetubeapp.freetubeandroid

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

internal class DownloadMission(
    private val storage: DownloadStorage,
    private val data: JSONObject,
    private val onChanged: (JSONObject) -> Unit
) {
    @Volatile private var pauseRequested = false
    @Volatile private var cancelRequested = false
    private val connections = ConcurrentHashMap.newKeySet<HttpURLConnection>()
    private var progressStartedAt = 0L
    private var progressStartBytes = 0L

    val id: String get() = data.getString("id")
    val status: String get() = data.getString("status")

    fun run() {
        if (status != STATUS_QUEUED && status != STATUS_PAUSED) return
        pauseRequested = false
        cancelRequested = false
        progressStartedAt = System.currentTimeMillis()
        progressStartBytes = aggregateDownloaded()
        clearRateMetrics()
        updateStatus(STATUS_DOWNLOADING)
        updateProgressMetrics()

        val parts = data.getJSONArray("parts")
        val temporaryFiles = (0 until parts.length()).map { index ->
            File(parts.getJSONObject(index).getString("temporaryPath"))
        }
        var outputTemporaryFile: File? = null
        try {
            for (index in 0 until parts.length()) {
                val part = parts.getJSONObject(index)
                downloadPart(temporaryFiles[index], part)
            }
            checkInterrupted()

            val fileToPublish = if (parts.length() == 1) {
                temporaryFiles[0]
            } else {
                updateStatus(STATUS_POST_PROCESSING)
                val outputExtension = if (data.optString("mimeType") == "video/webm") ".webm" else ".mp4"
                outputTemporaryFile = File.createTempFile("$id-output-", outputExtension, temporaryFiles[0].parentFile)
                muxParts(temporaryFiles, outputTemporaryFile, data.optString("mimeType"))
                outputTemporaryFile
            }

            val outputUri = storage.publishTemporaryFile(
                fileToPublish,
                data.getString("directoryUri"),
                data.getString("fileName"),
                data.getString("mimeType")
            ) { copied, total ->
                checkInterrupted()
                data.put("publishedBytes", copied)
                data.put("publishedTotalBytes", total)
                onChanged(data)
            }
            checkInterrupted()
            temporaryFiles.forEach(storage::deleteTemporaryFile)
            outputTemporaryFile?.let(storage::deleteTemporaryFile)
            data.put("outputUri", outputUri)
            data.put("completedAt", System.currentTimeMillis())
            updateStatus(STATUS_COMPLETED)
        } catch (error: Exception) {
            when {
                cancelRequested -> {
                    temporaryFiles.forEach(storage::deleteTemporaryFile)
                    outputTemporaryFile?.let(storage::deleteTemporaryFile)
                    updateStatus(STATUS_CANCELED)
                }
                pauseRequested -> {
                    outputTemporaryFile?.let(storage::deleteTemporaryFile)
                    updateStatus(STATUS_PAUSED)
                }
                else -> {
                    outputTemporaryFile?.let(storage::deleteTemporaryFile)
                    if (error is DownloadException && error.needsRefresh) {
                        data.put("needsRefresh", true)
                        data.put("errorCode", ERROR_NEEDS_REFRESH)
                        data.put("errorClass", ERROR_CLASS_RESUMABLE)
                    } else if (error is IOException && !storage.isNetworkAvailable()) {
                        data.put("errorCode", ERROR_NETWORK_UNAVAILABLE)
                        data.put("errorClass", ERROR_CLASS_RESUMABLE)
                    } else {
                        data.put("errorClass", if (error is DownloadException && error.retryable) {
                            ERROR_CLASS_RETRYABLE
                        } else {
                            ERROR_CLASS_TERMINAL
                        })
                    }
                    data.put("error", error.message ?: error.javaClass.simpleName)
                    updateStatus(STATUS_FAILED)
                }
            }
        } finally {
            connections.clear()
        }
    }

    fun pause() {
        if (status == STATUS_DOWNLOADING) {
            pauseRequested = true
            connections.forEach(HttpURLConnection::disconnect)
        }
    }

    fun cancel() {
        cancelRequested = true
        connections.forEach(HttpURLConnection::disconnect)
        if (status == STATUS_QUEUED || status == STATUS_PAUSED) {
            deleteTemporaryParts()
            updateStatus(STATUS_CANCELED)
        }
    }

    private fun downloadPart(temporaryFile: File, part: JSONObject) {
        val threads = data.optInt("threads", 1).coerceIn(1, MAX_THREADS)
        if (threads == 1) return downloadWithRetries(temporaryFile, part)
        val size = probeSize(part)
        if (size <= 0) return downloadWithRetries(temporaryFile, part)
        val ranges = (0 until threads).map { index ->
            val start = size * index / threads
            val end = size * (index + 1) / threads - 1
            start..end
        }
        val segments = ranges.mapIndexed { index, _ -> File("${temporaryFile.absolutePath}.range-$index") }
        synchronized(data) {
            part.put("downloadedBytes", segments.sumOf(File::length))
            part.put("totalBytes", size)
            updateProgressMetrics()
            onChanged(data)
        }
        val executor = Executors.newFixedThreadPool(threads)
        try {
            val futures = ranges.mapIndexed { index, range ->
                executor.submit { downloadRangeWithRetries(segments[index], part, range.first.toLong(), range.last.toLong()) }
            }
            try {
                futures.forEach { it.get() }
            } catch (error: Exception) {
                futures.forEach { it.cancel(true) }
                if (error.cause is RangeUnsupported) {
                    segments.forEach(File::delete)
                    return downloadWithRetries(temporaryFile, part)
                }
                throw (error.cause ?: error)
            }
            FileOutputStream(temporaryFile, false).use { output ->
                segments.forEach { segment -> segment.inputStream().use { it.copyTo(output) } }
            }
            synchronized(data) {
                part.put("downloadedBytes", size)
                updateProgressMetrics()
                onChanged(data)
            }
        } finally {
            executor.shutdownNow()
            segments.forEach(File::delete)
        }
    }

    private fun probeSize(part: JSONObject): Long {
        val http = (URL(part.getString("url")).openConnection() as HttpURLConnection).apply {
            requestMethod = "HEAD"
            instanceFollowRedirects = true
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("User-Agent", ANDROID_VR_USER_AGENT)
            setRequestProperty("Referer", "https://www.youtube.com/")
        }
        try {
            if (http.responseCode !in 200..299) return -1
            return http.contentLengthLong
        } catch (_: Exception) {
            return -1
        } finally {
            http.disconnect()
        }
    }

    private fun downloadRangeWithRetries(file: File, part: JSONObject, start: Long, end: Long) {
        var attempt = 0
        while (true) {
            try {
                downloadRange(file, part, start, end)
                return
            } catch (error: DownloadException) {
                if (!error.retryable || attempt++ >= MAX_RETRIES || pauseRequested || cancelRequested) throw error
                Thread.sleep(RETRY_DELAY_MS * attempt)
            } catch (error: IOException) {
                if (error is RangeUnsupported || attempt++ >= MAX_RETRIES || pauseRequested || cancelRequested) throw error
                Thread.sleep(RETRY_DELAY_MS * attempt)
            }
        }
    }

    private fun downloadRange(file: File, part: JSONObject, start: Long, end: Long) {
        val offset = file.length()
        val rangeStart = start + offset
        if (rangeStart > end) return
        val http = (URL(part.getString("url")).openConnection() as? HttpURLConnection)
            ?: throw IOException("Unsupported download URL")
        connections.add(http)
        http.instanceFollowRedirects = true
        http.connectTimeout = CONNECT_TIMEOUT_MS
        http.readTimeout = READ_TIMEOUT_MS
        http.setRequestProperty("User-Agent", ANDROID_VR_USER_AGENT)
        http.setRequestProperty("Accept", "*/*")
        http.setRequestProperty("Referer", "https://www.youtube.com/")
        http.setRequestProperty("Range", "bytes=$rangeStart-$end")
        try {
            val responseCode = http.responseCode
            if (responseCode == 200) throw RangeUnsupported("Server does not support byte ranges")
            if (responseCode == HttpURLConnection.HTTP_FORBIDDEN || responseCode == HttpURLConnection.HTTP_GONE) {
                throw DownloadException("Stream URL expired", retryable = false, needsRefresh = true)
            }
            if (responseCode !in 200..299) throw DownloadException("HTTP $responseCode", retryable = responseCode >= 500)
            val contentRange = http.getHeaderField("Content-Range") ?: throw RangeUnsupported("Missing Content-Range")
            if (!contentRange.startsWith("bytes $rangeStart-$end/")) throw RangeUnsupported("Invalid Content-Range")
            FileOutputStream(file, offset > 0).use { output ->
                http.inputStream.use { input ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        checkInterrupted()
                        val count = input.read(buffer)
                        if (count == -1) break
                        output.write(buffer, 0, count)
                        synchronized(data) {
                            part.put("downloadedBytes", part.optLong("downloadedBytes", 0L) + count)
                            updateProgressMetrics()
                            onChanged(data)
                        }
                    }
                }
            }
        } finally {
            connections.remove(http)
            http.disconnect()
        }
    }

    private fun downloadWithRetries(temporaryFile: File, part: JSONObject) {
        var attempt = 0
        while (true) {
            try {
                download(temporaryFile, part)
                return
            } catch (error: DownloadException) {
                if (!error.retryable || attempt++ >= MAX_RETRIES || pauseRequested || cancelRequested) throw error
                Thread.sleep(RETRY_DELAY_MS * attempt)
            } catch (error: IOException) {
                if (attempt++ >= MAX_RETRIES || pauseRequested || cancelRequested) throw error
                Thread.sleep(RETRY_DELAY_MS * attempt)
            }
        }
    }

    private fun download(temporaryFile: File, part: JSONObject) {
        val offset = temporaryFile.length()
        val url = URL(part.getString("url"))
        val http = (url.openConnection() as? HttpURLConnection)
            ?: throw IOException("Unsupported download URL")
        connections.add(http)
        http.instanceFollowRedirects = true
        http.connectTimeout = CONNECT_TIMEOUT_MS
        http.readTimeout = READ_TIMEOUT_MS
        http.setRequestProperty("User-Agent", ANDROID_VR_USER_AGENT)
        http.setRequestProperty("Accept", "*/*")
        http.setRequestProperty("Accept-Encoding", "*")
        http.setRequestProperty("Referer", "https://www.youtube.com/")
        http.setRequestProperty("Range", "bytes=$offset-")

        try {
            val responseCode = http.responseCode
            Log.i("FreeTubeDownloads", "stream response=$responseCode message=${http.responseMessage} type=${http.contentType} host=${url.host} offset=$offset")
            if (responseCode == HttpURLConnection.HTTP_FORBIDDEN || responseCode == HttpURLConnection.HTTP_GONE) {
                throw DownloadException("Stream URL expired", retryable = false, needsRefresh = true)
            }
            if (responseCode == 408 || responseCode == 429 || responseCode >= 500) {
                throw DownloadException("HTTP $responseCode", retryable = true)
            }
            if (responseCode !in 200..299) throw DownloadException("HTTP $responseCode", retryable = false)
            val append = offset > 0 && responseCode == HttpURLConnection.HTTP_PARTIAL
            val start = if (append) offset else 0L
            if (!append && offset > 0) temporaryFile.delete()
            val total = if (http.contentLengthLong >= 0) start + http.contentLengthLong else -1L
            part.put("totalBytes", total)
            part.put("downloadedBytes", start)
            updateProgressMetrics()
            onChanged(data)
            if (total >= 0 && !storage.hasTemporarySpace(temporaryFile, total - start)) {
                throw DownloadException("Not enough storage space", retryable = false)
            }
            progressStartedAt = System.currentTimeMillis()
            progressStartBytes = aggregateDownloaded()
            FileOutputStream(temporaryFile, append).use { output ->
                http.inputStream.use { input ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var downloaded = start
                    while (true) {
                        checkInterrupted()
                        val count = input.read(buffer)
                        if (count == -1) break
                        output.write(buffer, 0, count)
                        downloaded += count
                        part.put("downloadedBytes", downloaded)
                        updateProgressMetrics()
                        onChanged(data)
                    }
                }
            }
        } finally {
            connections.remove(http)
            http.disconnect()
        }
    }

    private fun muxParts(files: List<File>, output: File, mimeType: String) {
        val extractors = files.map { file -> MediaExtractor().also { it.setDataSource(file.absolutePath) } }
        val outputFormat = if (mimeType == "video/webm") {
            MediaMuxer.OutputFormat.MUXER_OUTPUT_WEBM
        } else {
            MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4
        }
        val muxer = MediaMuxer(output.absolutePath, outputFormat)
        try {
            val videoExtractor = extractors[0]
            val videoTrack = (0 until videoExtractor.trackCount).firstOrNull {
                videoExtractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
            } ?: throw IOException("Adaptive video track is missing")
            videoExtractor.selectTrack(videoTrack)
            val muxVideoTrack = muxer.addTrack(videoExtractor.getTrackFormat(videoTrack))

            val audioExtractor = extractors[1]
            val audioTrack = (0 until audioExtractor.trackCount).firstOrNull {
                audioExtractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
            } ?: throw IOException("Adaptive audio track is missing")
            audioExtractor.selectTrack(audioTrack)
            val muxAudioTrack = muxer.addTrack(audioExtractor.getTrackFormat(audioTrack))
            muxer.start()
            writeSamples(videoExtractor, muxer, muxVideoTrack)
            writeSamples(audioExtractor, muxer, muxAudioTrack)
            muxer.stop()
        } finally {
            extractors.forEach(MediaExtractor::release)
            muxer.release()
        }
    }

    private fun writeSamples(extractor: MediaExtractor, muxer: MediaMuxer, targetTrack: Int) {
        val buffer = ByteBuffer.allocate(1024 * 1024)
        while (true) {
            checkInterrupted()
            val sampleSize = extractor.readSampleData(buffer, 0)
            if (sampleSize < 0) break
            muxer.writeSampleData(targetTrack, buffer, android.media.MediaCodec.BufferInfo().apply {
                offset = 0
                size = sampleSize
                presentationTimeUs = extractor.sampleTime
                flags = extractor.sampleFlags
            })
            extractor.advance()
        }
    }

    private fun checkInterrupted() {
        if (pauseRequested || cancelRequested) throw IOException("Download interrupted")
    }

    private fun deleteTemporaryParts() {
        val parts = data.optJSONArray("parts") ?: return
        for (index in 0 until parts.length()) {
            parts.optJSONObject(index)?.optString("temporaryPath")?.takeIf { it.isNotBlank() }?.let {
                storage.deleteTemporaryFile(File(it))
            }
        }
    }

    private fun aggregateDownloaded(): Long {
        val parts = data.getJSONArray("parts")
        return (0 until parts.length()).sumOf { parts.getJSONObject(it).optLong("downloadedBytes", 0L) }
    }

    private fun updateProgressMetrics() {
        val parts = data.getJSONArray("parts")
        val downloaded = aggregateDownloaded()
        val totals = (0 until parts.length()).map { parts.getJSONObject(it).optLong("totalBytes", -1L) }
        val total = totals.takeIf { values -> values.all { it >= 0L } }?.sum() ?: -1L
        data.put("downloadedBytes", downloaded)
        data.put("totalBytes", total)
        if (total > 0L) {
            data.put("progressPercentage", ((downloaded.toDouble() / total) * 100.0).toInt().coerceIn(0, 100))
        } else {
            data.remove("progressPercentage")
        }

        val elapsedSeconds = (System.currentTimeMillis() - progressStartedAt) / 1000.0
        val byteDelta = downloaded - progressStartBytes
        if (elapsedSeconds > 0.0 && byteDelta > 0L) {
            val speed = byteDelta / elapsedSeconds
            data.put("speedBytesPerSecond", speed.toLong())
            if (total >= downloaded) {
                data.put("etaSeconds", ((total - downloaded) / speed).toLong())
            } else {
                data.remove("etaSeconds")
            }
        } else {
            data.remove("speedBytesPerSecond")
            data.remove("etaSeconds")
        }
    }

    private fun clearRateMetrics() {
        data.remove("speedBytesPerSecond")
        data.remove("etaSeconds")
    }

    private fun updateStatus(value: String) {
        data.put("status", value)
        if (value != STATUS_DOWNLOADING) clearRateMetrics()
        onChanged(data)
    }

    companion object {
        const val STATUS_QUEUED = "queued"
        const val STATUS_DOWNLOADING = "downloading"
        const val STATUS_POST_PROCESSING = "post-processing"
        const val STATUS_PAUSED = "paused"
        const val STATUS_COMPLETED = "completed"
        const val STATUS_FAILED = "failed"
        const val STATUS_MISSING = "missing"
        const val STATUS_CANCELED = "canceled"
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 30_000
        private const val MAX_RETRIES = 3
        private const val ANDROID_VR_USER_AGENT = "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip"
        private const val RETRY_DELAY_MS = 1_000L
        const val MAX_THREADS = 32
        const val ERROR_NEEDS_REFRESH = "needs-refresh"
        const val ERROR_NETWORK_UNAVAILABLE = "network-unavailable"
        const val ERROR_CLASS_RESUMABLE = "resumable"
        const val ERROR_CLASS_RETRYABLE = "retryable"
        const val ERROR_CLASS_TERMINAL = "terminal"
        private val SUPPORTED_MIME_TYPES = setOf("video/mp4", "video/webm", "audio/mp4", "audio/webm", "text/vtt")

        fun validateRequest(request: JSONObject) {
            val parts = request.optJSONArray("parts")
            require(parts != null && parts.length() in 1..2) { "Invalid download parts" }
            require(request.optInt("threads", 1) in 1..MAX_THREADS) { "Invalid download threads" }
            require(request.optString("directoryUri").isNotBlank()) { "Missing downloads directory" }
            require(request.optString("fileName").isNotBlank()) { "Missing output filename" }
            val mimeType = request.optString("mimeType")
            require(mimeType in SUPPORTED_MIME_TYPES) { "Unsupported output MIME type" }
            for (index in 0 until parts.length()) {
                val part = parts.getJSONObject(index)
                val url = Uri.parse(part.optString("url"))
                require(url.scheme == "http" || url.scheme == "https") { "Unsupported download URL" }
                require(part.optString("mimeType") in SUPPORTED_MIME_TYPES) { "Unsupported part MIME type" }
            }
            if (parts.length() == 1) {
                require(Uri.parse(request.optString("url")).scheme in setOf("http", "https")) { "Unsupported download URL" }
            } else {
                require(mimeType in setOf("video/mp4", "video/webm")) { "Adaptive output must be video" }
                require(parts.getJSONObject(0).optString("kind") == "video") { "Video part must come first" }
                require(parts.getJSONObject(1).optString("kind") == "audio") { "Audio part is missing" }
                val expectedAudioMime = if (mimeType == "video/webm") "audio/webm" else "audio/mp4"
                require(parts.getJSONObject(1).optString("mimeType") == expectedAudioMime) { "Adaptive audio format does not match output" }
            }
            if (mimeType == "text/vtt") {
                require(parts.length() == 1 && parts.getJSONObject(0).optString("kind") == "subtitle") { "Invalid subtitle mission" }
                require(request.optInt("threads", 1) == 1) { "Subtitle threads are unsupported" }
            }
        }
    }

    private class RangeUnsupported(message: String) : IOException(message)

    private class DownloadException(
        message: String,
        val retryable: Boolean,
        val needsRefresh: Boolean = false
    ) : IOException(message)
}
