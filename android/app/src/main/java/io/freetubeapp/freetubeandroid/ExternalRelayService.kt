package io.freetubeapp.freetubeandroid

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.webkit.CookieManager
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class ExternalRelayService : Service() {
    companion object {
        private const val CHANNEL_ID = "external_relay"
        private const val NOTIFICATION_ID = 1002
        private val relay = Relay()

        fun register(context: Context, userAgent: String, url: String, headers: Map<String, String>, manifest: Boolean, maxQuality: Int?, streamsJson: String?): String {
            start(context)
            relay.userAgent = userAgent
            return streamsJson?.let { relay.registerExternalStreamsManifest(it, headers, maxQuality) }
                ?: relay.registerExternalStream(url, headers, manifest, maxQuality)
        }

        fun update(context: Context, userAgent: String, relayUrl: String, mediaUrl: String?, headersJson: String?, manifestUrl: String?, maxQuality: Int?, streamsJson: String?) {
            start(context)
            relay.userAgent = userAgent
            relay.update(relayUrl, mediaUrl, headersJson, manifestUrl, maxQuality, streamsJson)
        }

        private fun start(context: Context) {
            val intent = Intent(context, ExternalRelayService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ContextCompat.startForegroundService(context, intent) else context.startService(intent)
        }
    }

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "External player", NotificationManager.IMPORTANCE_MIN))
        startForeground(NOTIFICATION_ID, Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("FreeTube external player")
            .setCategory(Notification.CATEGORY_SERVICE)
            .setSmallIcon(R.drawable.ic_media_notification_icon)
            .build())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
    override fun onBind(intent: Intent?): IBinder? = null

    private class Relay {
        private data class ExternalStream(
            val url: String,
            val headers: Map<String, String>,
            val isManifest: Boolean = false,
            val maxHeight: Int? = null,
            val manifestBody: ByteArray? = null
        )

        @Volatile var userAgent = ""
        private val executor = Executors.newFixedThreadPool(4)
        private val streams = ConcurrentHashMap<String, ExternalStream>()
        private var server: ServerSocket? = null

        fun update(relayUrl: String, mediaUrl: String?, headersJson: String?, manifestUrl: String?, maxQuality: Int?, streamsJson: String?) {
            val token = Uri.parse(relayUrl).path?.substringAfterLast('/') ?: return
            val headers = try {
                val json = headersJson?.let(::JSONObject)
                json?.keys()?.asSequence()?.associateWith { json.getString(it) } ?: emptyMap()
            } catch (_: Exception) {
                emptyMap()
            }
            streamsJson?.let { jsonText ->
                val manifestRelayUrl = registerExternalStreamsManifest(jsonText, headers, maxQuality)
                val manifestToken = Uri.parse(manifestRelayUrl).path?.substringAfterLast('/')
                val manifestStream = manifestToken?.let(streams::get)
                if (manifestStream != null) {
                    streams[token] = manifestStream
                    Log.d("FreeTubeExternal", "relay-updated token=${token.take(8)} isManifest=true hasStreams=true")
                }
                return
            }
            val streamUrl = mediaUrl?.takeIf { it.startsWith("http") }
                ?: manifestUrl?.takeIf { it.startsWith("http") }
                ?: return
            val isManifest = mediaUrl == null && manifestUrl != null
            streams[token] = ExternalStream(streamUrl, headers, isManifest, maxQuality)
            Log.d("FreeTubeExternal", "relay-updated token=${token.take(8)} isManifest=$isManifest")
        }
        

        fun registerExternalStream(
            url: String,
            headers: Map<String, String>,
            isManifest: Boolean = false,
            maxHeight: Int? = null,
            manifestBody: ByteArray? = null
        ): String {
            val token = UUID.randomUUID().toString()
            streams[token] = ExternalStream(url, headers, isManifest, maxHeight, manifestBody)
            Log.d("FreeTubeExternal", "relay-register token=${token.take(8)} isManifest=$isManifest hasBody=${manifestBody != null}")
        
            synchronized(streams) {
                if (server == null) {
                    server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
                    val server = server ?: error("Unable to start external player relay")
                    executor.execute {
                        while (!server.isClosed) {
                            try {
                                val client = server.accept()
                                executor.execute { relayExternalStream(client) }
                            } catch (_: Exception) {
                                if (!server.isClosed) Log.w("FreeTubeWebView", "External player relay stopped")
                            }
                        }
                    }
                }
            }
        
            return "http://127.0.0.1:${server?.localPort}/$token"
        }
        
        fun registerExternalStreamsManifest(jsonText: String, headers: Map<String, String>, maxHeight: Int?): String {
            val json = try { JSONObject(jsonText) } catch (_: Exception) { return registerExternalStream("", headers) }
            val videoUrl = json.optString("videoUrl")
            val audioUrl = json.optString("audioUrl")
            if (!videoUrl.startsWith("http") || !audioUrl.startsWith("http")) return registerExternalStream("", headers)
            val videoRelay = registerExternalStream(videoUrl, headers)
            val audioRelay = registerExternalStream(audioUrl, headers)
            val videoWidth = json.optInt("videoWidth")
            val videoHeight = json.optInt("videoHeight")
            fun mimeType(name: String, fallback: String): String {
                return json.optString(name).substringBefore(';').ifBlank { fallback }
            }
            fun codecs(name: String): String? {
                val mimeType = json.optString(name)
                return Regex("""codecs="([^"]+)"""").find(mimeType)?.groupValues?.get(1)
            }
            val videoMimeType = mimeType("videoMimeType", "video/mp4")
            val audioMimeType = mimeType("audioMimeType", "audio/mp4")
            val videoCodecs = codecs("videoMimeType")
            val audioCodecs = codecs("audioMimeType")
            Log.d("FreeTubeExternal", "relay-manifest-types video=$videoMimeType/$videoCodecs audio=$audioMimeType/$audioCodecs")
            fun readRange(name: String): Pair<Long, Long>? {
                val range = json.optJSONObject(name) ?: return null
                return range.optLong("start") to range.optLong("end")
            }
            fun rangeValue(range: Pair<Long, Long>?): String? = range?.let { "${it.first}-${it.second}" }
            val videoBandwidth = json.optLong("videoBandwidth")
            val videoInitRange = rangeValue(readRange("videoInitRange"))
            val videoIndexRange = rangeValue(readRange("videoIndexRange"))
            val audioBandwidth = json.optLong("audioBandwidth")
            val audioInitRange = rangeValue(readRange("audioInitRange"))
            val audioIndexRange = rangeValue(readRange("audioIndexRange"))
            val sampleRate = json.optInt("audioSampleRate")
            val channels = json.optInt("audioChannels")
            val durationSeconds = json.optDouble("durationSeconds", 0.0)
            val duration = if (durationSeconds > 0) "PT${durationSeconds.toLong()}S" else "PT0S"
            Log.d("FreeTubeExternal", "relay-manifest-duration seconds=$durationSeconds value=$duration")
            val manifest = """<?xml version="1.0" encoding="UTF-8"?>
        <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="$duration" minBufferTime="PT1.5S">
          <Period>
        <AdaptationSet mimeType="$videoMimeType" contentType="video"${videoCodecs?.let { " codecs=\"$it\"" } ?: ""} maxWidth="$videoWidth" maxHeight="${maxHeight ?: videoHeight}">
          <Representation id="video" bandwidth="$videoBandwidth" width="$videoWidth" height="$videoHeight"${videoCodecs?.let { " codecs=\"$it\"" } ?: ""}>
            <BaseURL>$videoRelay</BaseURL>
            <SegmentBase${videoIndexRange?.let { " indexRange=\"$it\"" } ?: ""}>
              ${videoInitRange?.let { "<Initialization range=\"$it\"/>" } ?: ""}
            </SegmentBase>
          </Representation>
        </AdaptationSet>
        <AdaptationSet mimeType="$audioMimeType" contentType="audio"${audioCodecs?.let { " codecs=\"$it\"" } ?: ""} audioSamplingRate="$sampleRate">
          <Representation id="audio" bandwidth="$audioBandwidth" audioSamplingRate="$sampleRate"${audioCodecs?.let { " codecs=\"$it\"" } ?: ""}>
            <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="$channels"/>
            <BaseURL>$audioRelay</BaseURL>
            <SegmentBase${audioIndexRange?.let { " indexRange=\"$it\"" } ?: ""}>
              ${audioInitRange?.let { "<Initialization range=\"$it\"/>" } ?: ""}
            </SegmentBase>
          </Representation>
        </AdaptationSet>
          </Period>
        </MPD>""".toByteArray(Charsets.UTF_8)
            return registerExternalStream("", headers, true, maxHeight, manifest)
        }
        
        private fun rewriteDashManifest(body: ByteArray, stream: ExternalStream): ByteArray {
            var manifest = body.toString(Charsets.UTF_8)
            stream.maxHeight?.let { maxHeight ->
                val representation = Regex(
                    """<Representation\b[^>]*height="(\d+)"[^>]*>.*?</Representation>""",
                    setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)
                )
                manifest = representation.replace(manifest) { match ->
                    if (match.groupValues[1].toInt() > maxHeight) "" else match.value
                }
                val selfClosingRepresentation = Regex(
                    """<Representation\b[^>]*height="(\d+)"[^>]*/>""",
                    RegexOption.IGNORE_CASE
                )
                manifest = selfClosingRepresentation.replace(manifest) { match ->
                    if (match.groupValues[1].toInt() > maxHeight) "" else match.value
                }
            }
        
            val mediaUrl = Regex("""https://[^<>"']+\.googlevideo\.com[^<>"']+""")
            manifest = mediaUrl.replace(manifest) { match ->
                registerExternalStream(
                    match.value.replace("&amp;", "&"),
                    stream.headers
                )
            }
            return manifest.toByteArray(Charsets.UTF_8)
        }
        
        private fun relayExternalStream(socket: Socket) {
            val startedAt = System.nanoTime()
            socket.use { client ->
                client.soTimeout = 30_000
                val reader = client.getInputStream().bufferedReader()
                val requestLine = reader.readLine() ?: return
                val requestHeaders = mutableMapOf<String, String>()
                while (true) {
                    val line = reader.readLine()
                    if (line.isNullOrEmpty()) break
                    val separator = line.indexOf(':')
                    if (separator > 0) {
                        requestHeaders[line.substring(0, separator).lowercase()] = line.substring(separator + 1).trim()
                    }
                }
        
                val token = requestLine.split(' ').getOrNull(1)?.substringAfterLast('/') ?: return
                var stream = streams[token] ?: run {
                    Log.w("FreeTubeExternal", "relay-missing-token token=${token.take(8)}")
                    return
                }
                for (attempt in 0 until 150) {
                    if (stream.url.isNotBlank() || stream.manifestBody != null) break
                    Thread.sleep(100)
                    stream = streams[token] ?: return
                }
                if (stream.url.isBlank() && stream.manifestBody == null) {
                    Log.w("FreeTubeExternal", "relay-pending-timeout token=${token.take(8)}")
                    client.getOutputStream().bufferedWriter().use { output ->
                        output.write("HTTP/1.1 504 Gateway Timeout\\r\\nConnection: close\\r\\n\\r\\n")
                    }
                    return
                }
                Log.d("FreeTubeExternal", "relay-request token=${token.take(8)} request=${requestLine.substringBefore(' ')} range=${requestHeaders["range"]}")
                stream.manifestBody?.let { body ->
                    val response = "HTTP/1.1 200 OK\r\nContent-Type: application/dash+xml\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.UTF_8)
                    client.getOutputStream().use { output ->
                        output.write(response)
                        output.write(body)
                    }
                    Log.d("FreeTubeExternal", "relay-manifest-response token=${token.take(8)} bytes=${body.size}")
                    return
                }
                val upstreamUrl = stream.url
                val range = requestHeaders["range"]
                val isGoogleVideo = Uri.parse(upstreamUrl).host?.endsWith(".googlevideo.com") == true
                val useYouTubeSegmentRequest = isGoogleVideo && range != null
                val upstreamRequestUrl = if (useYouTubeSegmentRequest) {
                    Uri.parse(upstreamUrl).buildUpon()
                        .appendQueryParameter("range", range?.substringAfter('=') ?: "")
                        .appendQueryParameter("alr", "yes")
                        .build()
                        .toString()
                } else {
                    upstreamUrl
                }
                val connection = (URL(upstreamRequestUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 30_000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", userAgent)
                    setRequestProperty("Accept-Language", "en-US,en;q=0.9")
                    setRequestProperty("Referer", "https://www.youtube.com/")
                    setRequestProperty("Origin", "https://www.youtube.com")
                    stream.headers.forEach { (name, value) -> setRequestProperty(name, value) }
                    CookieManager.getInstance().getCookie(upstreamUrl)?.let { setRequestProperty("Cookie", it) }
                    setRequestProperty("Accept-Encoding", "identity")
                    setRequestProperty("Connection", "close")
                    useCaches = false
                    if (useYouTubeSegmentRequest) {
                        requestMethod = "POST"
                        doOutput = true
                        setFixedLengthStreamingMode(2)
                    } else {
                        range?.let { setRequestProperty("Range", it) }
                    }
                }
                if (useYouTubeSegmentRequest) {
                    connection.outputStream.use { it.write(byteArrayOf(0x78, 0x00)) }
                } else {
                    connection.connect()
                }
        
                try {
                    val output = client.getOutputStream().bufferedWriter()
                    val upstreamStatus = connection.responseCode
                    val rangeStart = range?.substringAfter("bytes=")?.substringBefore('-')?.toLongOrNull()
                    Log.d("FreeTubeExternal", "relay-upstream token=${token.take(8)} status=$upstreamStatus contentType=${connection.contentType} length=${connection.contentLengthLong} elapsedMs=${(System.nanoTime() - startedAt) / 1_000_000}")
                    val contentLength = connection.contentLengthLong
                    val isPartialResponse = useYouTubeSegmentRequest && upstreamStatus < 400 && rangeStart != null && contentLength >= 0
                    val status = if (isPartialResponse) 206 else upstreamStatus
                    val totalLength = if (isPartialResponse) rangeStart!! + contentLength else null
                    output.write("HTTP/1.1 $status ${if (status == 206) "Partial Content" else connection.responseMessage ?: "OK"}\r\n")
                    val manifestBody = if (stream.isManifest && upstreamStatus < 400) {
                        rewriteDashManifest(connection.inputStream.use { it.readBytes() }, stream)
                    } else {
                        null
                    }
                    output.write("Content-Type: ${if (stream.isManifest) "application/dash+xml" else connection.contentType ?: "video/mp4"}\r\n")
                    if (manifestBody != null) {
                        output.write("Content-Length: ${manifestBody.size}\r\n")
                    } else {
                        connection.getHeaderField("Content-Length")?.let { length -> output.write("Content-Length: $length\r\n") }
                    }
                    if (isPartialResponse) {
                        output.write("Content-Range: bytes $rangeStart-${totalLength!! - 1}/$totalLength\r\n")
                    } else {
                        connection.getHeaderField("Content-Range")?.let { upstreamRange -> output.write("Content-Range: $upstreamRange\r\n") }
                    }
                    output.write("Accept-Ranges: bytes\r\nConnection: close\r\n\r\n")
                    output.flush()
        
                    if (!requestLine.startsWith("HEAD ") && upstreamStatus < 400) {
                        try {
                            if (manifestBody != null) {
                                client.getOutputStream().write(manifestBody)
                            } else {
                                connection.inputStream.use { input -> input.copyTo(client.getOutputStream(), 64 * 1024) }
                            }
                        } catch (error: java.io.IOException) {
                            Log.d("FreeTubeExternal", "relay-client-closed token=${token.take(8)} message=${error.message}")
                            // VLC may close a range request after receiving enough data.
                        }
                    }
                } finally {
                    connection.disconnect()
                }
            }
        }
            }
}
