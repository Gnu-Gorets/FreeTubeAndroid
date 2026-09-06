package io.freetubeapp.freetubeandroid

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.Locale

/** Native storage primitives for download missions. Media bytes never cross the JS bridge. */
class DownloadStorage(
    private val context: Context
) {
    private val filesDirectory = context.filesDir
    private val contentResolver = context.contentResolver
    private val temporaryDirectory = File(filesDirectory, "downloads/tmp").apply { mkdirs() }
    private val metadataDirectory = File(filesDirectory, "downloads").apply { mkdirs() }
    private val metadataFile = File(metadataDirectory, "missions.json")

    fun createTemporaryFile(missionId: String, partId: String, extension: String): File {
        val safeMissionId = safePathComponent(missionId)
        val safePartId = safePathComponent(partId)
        val safeExtension = safePathComponent(extension.removePrefix(".")).lowercase(Locale.ROOT).ifBlank { "part" }
        return File.createTempFile("$safeMissionId-$safePartId-", ".$safeExtension", temporaryDirectory)
    }

    fun isTreeWritable(treeUri: String): Boolean {
        return try {
            val uri = Uri.parse(treeUri)
            val permission = contentResolver.persistedUriPermissions.any {
                it.uri == uri && it.isReadPermission && it.isWritePermission
            }
            permission && DocumentFile.fromTreeUri(context, uri)?.let {
                it.canRead() && it.canWrite()
            } == true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Publishes a completed temporary file through SAF. A provider-visible .part file is
     * renamed only after the copy succeeds, so interrupted copies are never presented as final.
     */
    fun publishTemporaryFile(
        temporaryFile: File,
        treeUri: String,
        requestedFileName: String,
        mimeType: String,
        onProgress: (copiedBytes: Long, totalBytes: Long) -> Unit = { _, _ -> }
    ): String {
        val directory = writableDirectory(treeUri)
        val finalName = nextAvailableName(directory, sanitizeFileName(requestedFileName))
        val partialName = ".$finalName.part"
        val partial = directory.createFile(mimeType, partialName)
            ?: throw IllegalStateException("Unable to create temporary output file")
        var published = false

        try {
            contentResolver.openOutputStream(partial.uri, "wt")?.use { output ->
                temporaryFile.inputStream().use { input ->
                    copy(input, output, temporaryFile.length(), onProgress)
                }
            } ?: throw IllegalStateException("Unable to open temporary output stream")

            if (!partial.renameTo(finalName)) {
                throw IllegalStateException("Unable to finalize output file")
            }
            published = true
            temporaryFile.delete()
            return directory.findFile(finalName)?.uri?.toString()
                ?: throw IllegalStateException("Final output file disappeared")
        } catch (error: Exception) {
            if (!published) partial.delete()
            throw error
        }
    }

    fun hasTemporarySpace(file: File, requiredBytes: Long): Boolean {
        if (requiredBytes < 0) return true
        return file.parentFile?.usableSpace?.let { it >= requiredBytes } == true
    }

    fun isNetworkAvailable(wifiOnly: Boolean = false): Boolean {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val network = connectivity.activeNetwork ?: return false
        val capabilities = connectivity.getNetworkCapabilities(network) ?: return false
        if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return false
        return !wifiOnly || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }

    fun outputExists(uri: String): Boolean = try {
        DocumentFile.fromSingleUri(context, Uri.parse(uri))?.exists() == true
    } catch (_: Exception) {
        false
    }

    fun deleteOutput(uri: String): Boolean = contentResolver.delete(Uri.parse(uri), null, null) > 0

    fun deleteTemporaryFile(file: File): Boolean = !file.exists() || file.delete()

    fun deleteOrphanTemporaryFiles(referencedPaths: Set<String>) {
        temporaryDirectory.listFiles()?.forEach { file ->
            if (file.absolutePath !in referencedPaths) file.delete()
        }
    }

    fun loadMetadata(): JSONArray {
        if (!metadataFile.isFile) return JSONArray()
        return try {
            JSONArray(metadataFile.readText())
        } catch (error: Exception) {
            throw IllegalStateException("Invalid downloads metadata", error)
        }
    }

    @Synchronized
    fun saveMetadata(metadata: JSONArray) {
        val temporaryMetadata = File(metadataDirectory, "missions.json.tmp")
        temporaryMetadata.writeText(metadata.toString())
        if (!temporaryMetadata.renameTo(metadataFile)) {
            temporaryMetadata.delete()
            throw IllegalStateException("Unable to commit downloads metadata")
        }
    }

    private fun writableDirectory(treeUri: String): DocumentFile {
        val uri = Uri.parse(treeUri)
        if (!isTreeWritable(treeUri)) throw SecurityException("Downloads directory is not writable")
        return DocumentFile.fromTreeUri(context, uri)
            ?: throw IllegalStateException("Unable to open downloads directory")
    }

    private fun nextAvailableName(directory: DocumentFile, requestedName: String): String {
        if (directory.findFile(requestedName) == null) return requestedName
        val dot = requestedName.lastIndexOf('.')
        val base = if (dot > 0) requestedName.substring(0, dot) else requestedName
        val extension = if (dot > 0) requestedName.substring(dot) else ""
        var index = 2
        while (directory.findFile("$base ($index)$extension") != null) index++
        return "$base ($index)$extension"
    }

    private fun copy(
        input: InputStream,
        output: OutputStream,
        totalBytes: Long,
        onProgress: (copiedBytes: Long, totalBytes: Long) -> Unit
    ) {
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var copiedBytes = 0L
        while (true) {
            val count = input.read(buffer)
            if (count == -1) break
            output.write(buffer, 0, count)
            copiedBytes += count
            onProgress(copiedBytes, totalBytes)
        }
        output.flush()
    }

    companion object {
        private fun safePathComponent(value: String): String = value
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .trim('_')
            .ifBlank { "download" }
            .take(64)

        fun sanitizeFileName(value: String): String {
            val sanitized = value
                .replace(Regex("[\\u0000-\\u001F\\\\/:*?\"<>|]"), "_")
                .trim()
                .trimEnd('.', ' ')
                .take(180)
            return sanitized.ifBlank { "download" }
        }
    }
}
