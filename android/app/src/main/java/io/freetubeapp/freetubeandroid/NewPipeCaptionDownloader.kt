package io.freetubeapp.freetubeandroid

import okhttp3.OkHttpClient
import okhttp3.Request as HttpRequest
import okhttp3.RequestBody.Companion.toRequestBody
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

internal class NewPipeCaptionDownloader : Downloader() {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    private val calls = ConcurrentHashMap.newKeySet<okhttp3.Call>()
    @Volatile private var suspended = false
    @Volatile private var closed = false

    override fun execute(request: Request): Response {
        val uri = try {
            java.net.URI(request.url())
        } catch (error: Exception) {
            throw IOException("Invalid NewPipe URL", error)
        }
        val host = uri.host?.lowercase()
        if (uri.scheme != "https" || uri.rawUserInfo != null || host == null ||
            !(host == "youtube.com" || host.endsWith(".youtube.com") || host == "youtubei.googleapis.com")) {
            throw IOException("NewPipe URL refused")
        }
        if (closed) throw IOException("NewPipe downloader closed")
        if (suspended) throw IOException("NewPipe downloader suspended")

        val body = request.dataToSend()?.toRequestBody()
        val builder = HttpRequest.Builder().url(request.url()).header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0"
        )
        request.headers().forEach { (name, values) ->
            if (!name.equals("cookie", true) && !name.equals("authorization", true) &&
                !name.equals("proxy-authorization", true)) {
                builder.removeHeader(name)
                values.forEach { value -> builder.addHeader(name, value) }
            }
        }
        builder.method(request.httpMethod(), body)

        val call = client.newCall(builder.build())
        synchronized(calls) {
            if (closed || suspended) {
                call.cancel()
                throw IOException("NewPipe downloader unavailable")
            }
            calls.add(call)
        }
        try {
            call.execute().use { response ->
                if (response.code in 300..399) throw IOException("NewPipe redirect refused")
                return Response(
                    response.code,
                    response.message,
                    response.headers.toMultimap(),
                    (response.body ?: throw IOException("Empty NewPipe response body")).string(),
                    response.request.url.toString()
                )
            }
        } finally {
            calls.remove(call)
        }
    }

    fun cancelActive() {
        calls.forEach { it.cancel() }
    }

    fun suspendForProxy() {
        synchronized(calls) { suspended = true }
        cancelActive()
    }

    fun resumeAfterProxyClear() {
        synchronized(calls) { suspended = false }
    }

    fun close() {
        closed = true
        cancelActive()
        client.dispatcher.cancelAll()
        client.connectionPool.evictAll()
    }

    companion object {
        private val lock = Any()
        @Volatile private var instance: NewPipeCaptionDownloader? = null

        fun get(): NewPipeCaptionDownloader = instance ?: synchronized(lock) {
            instance ?: NewPipeCaptionDownloader().also {
                NewPipe.init(it)
                instance = it
            }
        }

        fun cancelActiveIfCreated() {
            instance?.cancelActive()
        }

        fun suspendForProxyIfCreated() {
            instance?.suspendForProxy()
        }

        fun resumeAfterProxyClearIfCreated() {
            instance?.resumeAfterProxyClear()
        }
    }
}
