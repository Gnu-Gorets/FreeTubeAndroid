package io.freetubeapp.freetubeandroid

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer

internal class DownloadMission(
    private val storage: DownloadStorage,
    private val data: JSONObject,
    private val onChanged: (JSONObject) -> Unit
) {
    @Volatile private var pauseRequested = false
    @Volatile private var cancelRequested = false
    @Volatile private var connection: HttpURLConnection? = null
    private var progressStartedAt = 0L
    private var progressStartBytes = 0L

    val id: String get() = data.getString("id")
    val status: String get() = data.getString("status")

    fun run() {
        if (status != STATUS_QUEUED && status != STATUS_PAUSED) return
        pauseRequested = false
        cancelRequested = false
        updateStatus(STATUS_DOWNLOADING)

        val parts = data.getJSONArray("parts")
        val temporaryFiles = (0 until parts.length()).map { index ->
            File(parts.getJSONObject(index).getString("temporaryPath"))
        }
        var outputTemporaryFile: File? = null
        try {
            for (index in 0 until parts.length()) {
                val part = parts.getJSONObject(index)
                downloadWithRetries(temporaryFiles[index], part)
            }
            checkInterrupted()

            val fileToPublish = if (parts.length() == 1) {
                temporaryFiles[0]
            } else {
                updateStatus(STATUS_POST_PROCESSING)
                outputTemporaryFile = File.createTempFile("$id-output-", ".mp4", temporaryFiles[0].parentFile)
                muxParts(temporaryFiles, outputTemporaryFile)
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
                    }
                    data.put("error", error.message ?: error.javaClass.simpleName)
                    updateStatus(STATUS_FAILED)
                }
            }
        } finally {
            connection = null
        }
    }

    fun pause() {
        if (status == STATUS_DOWNLOADING) {
            pauseRequested = true
            connection?.disconnect()
        }
    }

    fun cancel() {
        cancelRequested = true
        connection?.disconnect()
        if (status == STATUS_QUEUED || status == STATUS_PAUSED) {
            deleteTemporaryParts()
            updateStatus(STATUS_CANCELED)
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
        connection = http
        http.instanceFollowRedirects = true
        http.connectTimeout = CONNECT_TIMEOUT_MS
        http.readTimeout = READ_TIMEOUT_MS
        if (offset > 0) http.setRequestProperty("Range", "bytes=$offset-")

        try {
            val responseCode = http.responseCode
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
            http.disconnect()
        }
    }

    private fun muxParts(files: List<File>, output: File) {
        val extractors = files.map { file -> MediaExtractor().also { it.setDataSource(file.absolutePath) } }
        val muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
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
        val downloaded = aggregateDownloaded()
        val total = (0 until data.getJSONArray("parts").length()).map {
            data.getJSONArray("parts").getJSONObject(it).optLong("totalBytes", -1L)
        }.takeIf { values -> values.all { it >= 0 } }?.sum() ?: -1L
        data.put("downloadedBytes", downloaded)
        data.put("totalBytes", total)
        val elapsedSeconds = (System.currentTimeMillis() - progressStartedAt) / 1000.0
        if (elapsedSeconds > 0) {
            val speed = (downloaded - progressStartBytes) / elapsedSeconds
            if (speed > 0) {
                data.put("speedBytesPerSecond", speed.toLong())
                if (total >= downloaded) data.put("etaSeconds", ((total - downloaded) / speed).toLong())
            }
        }
    }

    private fun updateStatus(value: String) {
        data.put("status", value)
        onChanged(data)
    }

    companion object {
        const val STATUS_QUEUED = "queued"
        const val STATUS_DOWNLOADING = "downloading"
        const val STATUS_POST_PROCESSING = "post-processing"
        const val STATUS_PAUSED = "paused"
        const val STATUS_COMPLETED = "completed"
        const val STATUS_FAILED = "failed"
        const val STATUS_CANCELED = "canceled"
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 30_000
        private const val MAX_RETRIES = 3
        private const val RETRY_DELAY_MS = 1_000L
        const val ERROR_NEEDS_REFRESH = "needs-refresh"
        private val SUPPORTED_MIME_TYPES = setOf("video/mp4", "video/webm", "audio/mp4", "audio/webm")

        fun validateRequest(request: JSONObject) {
            val parts = request.optJSONArray("parts")
            require(parts != null && parts.length() in 1..2) { "Invalid download parts" }
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
                require(mimeType == "video/mp4") { "Adaptive output must be video/mp4" }
                require(parts.getJSONObject(0).optString("kind") == "video") { "Video part must come first" }
                require(parts.getJSONObject(1).optString("kind") == "audio") { "Audio part is missing" }
            }
        }
    }

    private class DownloadException(
        message: String,
        val retryable: Boolean,
        val needsRefresh: Boolean = false
    ) : IOException(message)
}
