package io.freetubeapp.freetubeandroid;

import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;

public final class CaptionTransportCheck {
    private static final String VTT = "WEBVTT\n\n00:00.000 --> 00:10.000\nCaption fixture\n";

    public static void main(String[] args) throws Exception {
        System.setProperty("sun.net.http.allowRestrictedHeaders", "true");
        check(CaptionTransport.matches("GET", "https://www.youtube.com/api/timedtext?v=test&fmt=vtt"));
        check(CaptionTransport.matches("GET", "https://www.youtube.com:443/api/timedtext?fmt=srt&tlang=de"));
        for (String url : new String[]{
                "http://www.youtube.com/api/timedtext", "https://www.youtube.com:444/api/timedtext",
                "https://www.youtube.com.evil/api/timedtext", "https://evil@www.youtube.com/api/timedtext",
                "https://www.youtube.com/api/timedtext/", "https://www.youtube.com/api/%74imedtext",
                "https://www.youtube.com/watch?v=test", "https://www.youtube.com/api/timedtext#fragment",
                "https://m.youtube.com/api/timedtext", "not a URL"}) {
            check(!CaptionTransport.matches("GET", url));
        }
        check(!CaptionTransport.matches("POST", "https://www.youtube.com/api/timedtext"));

        AtomicInteger requests = new AtomicInteger();
        AtomicInteger redirects = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/timedtext", exchange -> {
            requests.incrementAndGet();
            var headers = exchange.getRequestHeaders();
            boolean correct = "GET".equals(exchange.getRequestMethod())
                && "https://www.youtube.com/sw.js".equals(headers.getFirst("Referer"))
                && "same-origin".equals(headers.getFirst("Sec-Fetch-Site"))
                && "same-origin".equals(headers.getFirst("Sec-Fetch-Mode"))
                && "fixture-agent".equals(headers.getFirst("User-Agent"))
                && headers.getFirst("Cookie") == null && headers.getFirst("Authorization") == null;
            String query = exchange.getRequestURI().getRawQuery();
            if (!correct) System.out.println("Unexpected fixture headers: " + headers.entrySet());
            int status = !correct ? 400 : "limited".equals(query) ? 429 : "redirect".equals(query) ? 302 : 200;
            byte[] body = (status == 200 ? VTT : "fixture error").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/vtt; charset=utf-8");
            exchange.getResponseHeaders().set("Retry-After", "60");
            exchange.getResponseHeaders().set("Set-Cookie", "tracking=fixture");
            exchange.getResponseHeaders().set("Location", "/redirect-target");
            exchange.sendResponseHeaders(status, body.length);
            try (var output = exchange.getResponseBody()) { output.write(body); }
        });
        server.createContext("/redirect-target", exchange -> {
            redirects.incrementAndGet();
            exchange.sendResponseHeaders(500, -1);
            exchange.close();
        });
        server.start();
        String url = "http://127.0.0.1:" + server.getAddress().getPort() + "/api/timedtext";
        Map<String, String> headers = Map.of("User-Agent", "fixture-agent", "Cookie", "private=secret",
            "Authorization", "secret", "Referer", "file:///android_asset/index.html");
        try (CaptionTransport transport = new CaptionTransport()) {
            check(transport.fetch("GET", url, headers) == null);
            check(requests.get() == 0);
            var response = transport.execute(connection(url), headers);
            check(response.status == 200);
            try (var body = response.body) {
                check(new String(body.readAllBytes(), StandardCharsets.UTF_8).equals(VTT));
            }
            check(response.headers.get("Access-Control-Allow-Origin").equals("*"));
            check(!response.headers.containsKey("Set-Cookie"));
            check(!response.headers.containsKey("Location"));

            var limited = transport.execute(connection(url + "?limited"), headers);
            check(limited.status == 429 && "60".equals(limited.headers.get("Retry-After")));
            try (var body = limited.body) {
                check(new String(body.readAllBytes(), StandardCharsets.UTF_8).equals("fixture error"));
            }
            check(requests.get() == 2);
            try {
                transport.execute(connection(url + "?redirect"), headers);
                throw new AssertionError("Redirect accepted");
            } catch (java.io.IOException expected) {
                check(redirects.get() == 0 && requests.get() == 3);
            }
            long clearing = transport.beginProxyChange();
            transport.cancelActive();
            transport.beginProxyChange();
            transport.finishProxyClear(clearing);
            check(transport.execute(connection(url), headers) == null);
            check(requests.get() == 3);
            transport.finishProxyClear(transport.beginProxyChange());
            var resumed = transport.execute(connection(url), headers);
            resumed.body.close();
            check(requests.get() == 4);
            long failedChange = transport.beginProxyChange();
            transport.cancelProxyChange(failedChange);
            var afterFailedChange = transport.execute(connection(url), headers);
            afterFailedChange.body.close();
            check(requests.get() == 5);
        } finally {
            server.stop(0);
        }

        StubConnection stub = new StubConnection();
        CaptionTransport transport = new CaptionTransport();
        var response = transport.execute(stub, Map.of());
        check(stub.getConnectTimeout() == 15_000 && stub.getReadTimeout() == 15_000);
        check(!stub.getInstanceFollowRedirects() && !stub.getUseCaches());
        response.body.close();
        check(stub.disconnected);
        stub.disconnected = false;
        transport.execute(stub, Map.of());
        transport.beginProxyChange();
        transport.cancelActive();
        check(stub.disconnected);
        transport.close();
        try {
            transport.execute(stub, Map.of());
            throw new AssertionError("Closed transport accepted request");
        } catch (java.io.IOException expected) {}
        checkCancellation(false);
        checkCancellation(true);
        checkBlockedHeaderCancellation();
        System.out.println("Caption transport: PASS (local fixtures only)");
    }

    private static void checkBlockedHeaderCancellation() throws Exception {
        CaptionTransport transport = new CaptionTransport();
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch cancelled = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        StubConnection stub = new StubConnection() {
            @Override public int getResponseCode() {
                started.countDown();
                try {
                    if (!cancelled.await(5, TimeUnit.SECONDS)) throw new AssertionError("Header I/O not cancelled");
                } catch (InterruptedException error) { throw new AssertionError(error); }
                return 200;
            }
            @Override public void disconnect() { cancelled.countDown(); }
        };
        Thread worker = new Thread(() -> {
            try {
                transport.execute(stub, Map.of());
                failure.set(new AssertionError("Cancelled response delivered"));
            } catch (java.io.IOException expected) {
                // Cancelled response must not reach WebView.
            } catch (Throwable error) { failure.set(error); }
        });
        worker.start();
        check(started.await(5, TimeUnit.SECONDS));
        transport.close();
        worker.join(5000);
        check(!worker.isAlive() && failure.get() == null);
    }

    private static void checkCancellation(boolean close) throws Exception {
        CaptionTransport transport = new CaptionTransport();
        CountDownLatch admitted = new CountDownLatch(1);
        CountDownLatch proceed = new CountDownLatch(1);
        StubConnection stub = new StubConnection() {
            @Override public void setRequestMethod(String method) {
                admitted.countDown();
                try {
                    if (!proceed.await(5, TimeUnit.SECONDS)) throw new AssertionError("Fixture timed out");
                } catch (InterruptedException error) { throw new AssertionError(error); }
            }
            @Override public int getResponseCode() {
                throw new AssertionError("Cancelled request started I/O");
            }
        };
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                transport.execute(stub, Map.of());
                failure.set(new AssertionError("Cancelled request accepted"));
            } catch (java.io.IOException expected) {
                // Cancellation must fail, never fall back to WebView.
            } catch (Throwable error) { failure.set(error); }
        });
        worker.start();
        check(admitted.await(5, TimeUnit.SECONDS));
        if (close) transport.close();
        else {
            long generation = transport.beginProxyChange();
            transport.cancelActive();
            transport.finishProxyClear(generation);
        }
        proceed.countDown();
        worker.join(5000);
        check(!worker.isAlive() && failure.get() == null && stub.disconnected);
        transport.close();
    }

    private static HttpURLConnection connection(String url) throws Exception {
        return (HttpURLConnection) new URL(url).openConnection();
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Caption transport check failed");
    }

    private static class StubConnection extends HttpURLConnection {
        boolean disconnected;
        StubConnection() throws Exception { super(new URL("https://www.youtube.com/api/timedtext")); }
        @Override public void connect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public void disconnect() { disconnected = true; }
        @Override public int getResponseCode() { return 200; }
        @Override public String getResponseMessage() { return "OK"; }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(new byte[0]); }
    }
}
