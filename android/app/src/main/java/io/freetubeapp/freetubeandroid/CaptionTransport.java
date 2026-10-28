package io.freetubeapp.freetubeandroid;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

final class CaptionTransport implements AutoCloseable {
    private final Set<Request> active = ConcurrentHashMap.newKeySet();
    private volatile boolean proxyEnabled;
    private volatile boolean closed;
    private long proxyGeneration;

    static boolean matches(String method, String url) {
        try {
            URI uri = new URI(url);
            return method.equals("GET") && "https".equals(uri.getScheme())
                && "www.youtube.com".equals(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443)
                && uri.getRawUserInfo() == null && uri.getRawFragment() == null
                && "/api/timedtext".equals(uri.getRawPath());
        } catch (Exception error) {
            return false;
        }
    }

    Response fetch(String method, String url, Map<String, String> headers) throws IOException {
        if (!matches(method, url)) return null;
        if (closed) throw new IOException("Caption transport closed");
        if (proxyEnabled) return null;
        return NewPipeCaptionFetcher.INSTANCE.fetch(url);
    }

    // WebView proxy overrides do not apply to HttpURLConnection.
    synchronized long beginProxyChange() {
        proxyEnabled = true;
        NewPipeCaptionDownloader.Companion.suspendForProxyIfCreated();
        return ++proxyGeneration;
    }

    synchronized boolean isCurrentProxyChange(long generation) {
        return generation == proxyGeneration && !closed;
    }

    synchronized void finishProxyClear(long generation) {
        if (isCurrentProxyChange(generation)) {
            proxyEnabled = false;
            NewPipeCaptionDownloader.Companion.resumeAfterProxyClearIfCreated();
        }
    }

    synchronized void cancelProxyChange(long generation) {
        if (isCurrentProxyChange(generation)) {
            proxyEnabled = false;
            NewPipeCaptionDownloader.Companion.resumeAfterProxyClearIfCreated();
        }
    }

    void stop() {
        closed = true;
        NewPipeCaptionDownloader.Companion.cancelActiveIfCreated();
    }

    @Override
    public void close() {
        stop();
        cancelActive();
    }

    void cancelActive() {
        NewPipeCaptionDownloader.Companion.cancelActiveIfCreated();
        for (Request request : active) release(request);
    }

    private void release(Request request) {
        request.cancelled = true;
        // Interrupt header I/O before waiting for request start/handoff.
        request.connection.disconnect();
        synchronized (request) {
            request.connection.disconnect();
            active.remove(request);
        }
    }

    private static final class Request {
        final HttpURLConnection connection;
        volatile boolean cancelled;
        Request(HttpURLConnection connection) { this.connection = connection; }
    }

    // Package access allows local HTTP fixtures without widening production URL policy.
    Response execute(HttpURLConnection connection, Map<String, String> headers) throws IOException {
        if (closed) throw new IOException("Caption transport closed");
        // shortcut: configured proxies retain WebView path until native proxy parity exists.
        if (proxyEnabled) return null;
        Request request = new Request(connection);
        active.add(request);
        try {
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(15_000);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            for (Map.Entry<String, String> header : headers.entrySet()) {
                String name = header.getKey().toLowerCase(Locale.ROOT);
                if (name.equals("user-agent") || name.equals("accept")
                        || name.equals("accept-language") || name.equals("range")) {
                    connection.setRequestProperty(header.getKey(), header.getValue());
                }
            }
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Referer", "https://www.youtube.com/sw.js");
            connection.setRequestProperty("Sec-Fetch-Site", "same-origin");
            connection.setRequestProperty("Sec-Fetch-Mode", "same-origin");

            synchronized (request) {
                if (request.cancelled || closed || proxyEnabled) throw new IOException("Caption request cancelled");
                int status = connection.getResponseCode();
                if (request.cancelled) throw new IOException("Caption request cancelled");
                // WebResourceResponse cannot represent redirects; never follow them with signed URLs.
                if (status >= 300 && status < 400) throw new IOException("Caption redirect refused");
                if (status < 200 || status > 599) throw new IOException("Invalid caption HTTP status");
                Map<String, String> responseHeaders = new HashMap<>();
                for (String name : new String[]{"Content-Type", "Content-Length", "Content-Language",
                        "Content-Range", "Accept-Ranges", "Cache-Control", "Retry-After"}) {
                    String value = connection.getHeaderField(name);
                    if (value != null) responseHeaders.put(name, value);
                }
                responseHeaders.put("Access-Control-Allow-Origin", "*");
                InputStream body = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                if (body == null) body = new ByteArrayInputStream(new byte[0]);
                InputStream stream = new FilterInputStream(body) {
                    @Override
                    public void close() throws IOException {
                        try {
                            super.close();
                        } finally {
                            release(request);
                        }
                    }
                };
                String reason = connection.getResponseMessage();
                return new Response(status, reason == null || reason.trim().isEmpty() ? "HTTP response" : reason,
                    responseHeaders, stream);
            }
        } catch (IOException | RuntimeException error) {
            release(request);
            throw error;
        }
    }

    static final class Response {
        final int status;
        final String reason;
        final Map<String, String> headers;
        final InputStream body;

        Response(int status, String reason, Map<String, String> headers, InputStream body) {
            this.status = status;
            this.reason = reason;
            this.headers = headers;
            this.body = body;
        }
    }
}
