package io.freetubeapp.freetubeandroid

import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

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

        val temporaryFile = File(data.getString("temporaryPath"))
        try {
            downloadWithRetries(temporaryFile)
            if (cancelRequested) {
                updateStatus(STATUS_CANCELED)
                storage.deleteTemporaryFile(temporaryFile)
                return
            }
            updateStatus(STATUS_POST_PROCESSING)
            val outputUri = storage.publishTemporaryFile(
                temporaryFile,
                data.getString("directoryUri"),
                data.getString("fileName"),
                data.getString("mimeType")
            ) { copied, total ->
                if (cancelRequested) throw IOException("Download interrupted")
                data.put("publishedBytes", copied)
                data.put("publishedTotalBytes", total)
                onChanged(data)
            }
            if (cancelRequested) {
                storage.deleteOutput(outputUri)
                updateStatus(STATUS_CANCELED)
                return
            }
            data.put("outputUri", outputUri)
            data.put("completedAt", System.currentTimeMillis())
            updateStatus(STATUS_COMPLETED)
        } catch (error: Exception) {
            when {
                cancelRequested -> {
                    storage.deleteTemporaryFile(temporaryFile)
                    updateStatus(STATUS_CANCELED)
                }
                pauseRequested -> updateStatus(STATUS_PAUSED)
                else -> {
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
            storage.deleteTemporaryFile(File(data.getString("temporaryPath")))
            updateStatus(STATUS_CANCELED)
        }
    }

    private fun downloadWithRetries(temporaryFile: File) {
        var attempt = 0
        while (true) {
            try {
                download(temporaryFile)
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

    private fun download(temporaryFile: File) {
        val offset = temporaryFile.length()
        val url = URL(data.getString("url"))
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
            if (total >= 0 && !storage.hasTemporarySpace(temporaryFile, total - start)) {
                throw DownloadException("Not enough storage space", retryable = false)
            }
            progressStartedAt = System.currentTimeMillis()
            progressStartBytes = start
            java.io.FileOutputStream(temporaryFile, append).use { output ->
                http.inputStream.use { input ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var downloaded = start
                    while (true) {
                        if (pauseRequested || cancelRequested) throw IOException("Download interrupted")
                        val count = input.read(buffer)
                        if (count == -1) break
                        output.write(buffer, 0, count)
                        downloaded += count
                        data.put("downloadedBytes", downloaded)
                        data.put("totalBytes", total)
                        updateProgressMetrics(downloaded, total)
                        onChanged(data)
                    }
                }
            }
        } finally {
            http.disconnect()
        }
    }

    private fun updateProgressMetrics(downloaded: Long, total: Long) {
        val elapsedSeconds = (System.currentTimeMillis() - progressStartedAt) / 1000.0
        if (elapsedSeconds <= 0) return
        val speed = (downloaded - progressStartBytes) / elapsedSeconds
        if (speed > 0) {
            data.put("speedBytesPerSecond", speed.toLong())
            if (total >= downloaded) data.put("etaSeconds", ((total - downloaded) / speed).toLong())
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
            val url = Uri.parse(request.optString("url"))
            require(url.scheme == "http" || url.scheme == "https") { "Unsupported download URL" }
            require(request.optString("directoryUri").isNotBlank()) { "Missing downloads directory" }
            require(request.optString("fileName").isNotBlank()) { "Missing output filename" }
            val mimeType = request.optString("mimeType")
            require(mimeType in SUPPORTED_MIME_TYPES) { "Unsupported output MIME type" }
            require(request.optJSONArray("parts")?.length() == 1) { "Adaptive downloads are not available yet" }
        }
    }

    private class DownloadException(
        message: String,
        val retryable: Boolean,
        val needsRefresh: Boolean = false
    ) : IOException(message)
}
