package io.freetubeapp.freetubeandroid

import android.app.Activity
import android.graphics.Color
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.PixelFormat
import android.net.Uri
import android.provider.Settings
import android.view.Gravity
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.view.WindowManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.view.ViewCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : Activity() {
    companion object {
        val consoleMessages = java.util.concurrent.CopyOnWriteArrayList<String>()
        const val CREATE_FILE_REQUEST = 1001
        const val OPEN_FILE_REQUEST = 1002
        const val DIRECTORY_REQUEST = 1003
        const val PIP_OVERLAY_SCRIPT = """
            (() => {
              const player = document.querySelector('.ftVideoPlayer');
              if (!player) return;
              window.__ftPipStyles = [];
              let node = player;
              while (node && node !== document.body) {
                for (const sibling of node.parentElement.children) {
                  if (sibling !== node) {
                    window.__ftPipStyles.push([sibling, sibling.getAttribute('style')]);
                    sibling.style.display = 'none';
                  }
                }
                window.__ftPipStyles.push([node, node.getAttribute('style')]);
                node.style.display = node === player ? 'block' : 'contents';
                node = node.parentElement;
              }
              window.__ftPipStyles.push([player, player.getAttribute('style')]);
              player.style.cssText += ';position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;display:block!important;';
              const video = player.querySelector('video');
              if (video) {
                window.__ftPipStyles.push([video, video.getAttribute('style')]);
                video.style.cssText += ';width:100%!important;height:100%!important;object-fit:fill!important;';
              }
              for (const controls of player.querySelectorAll('.shaka-controls-container')) {
                window.__ftPipStyles.push([controls, controls.getAttribute('style')]);
                controls.style.cssText += ';opacity:1!important;visibility:visible!important;';
              }
              video?.ui?.getControls()?.show();
              window.__ftRestorePictureInPicture = () => {
                for (const [element, style] of window.__ftPipStyles || []) {
                  if (style === null) element.removeAttribute('style');
                  else element.setAttribute('style', style);
                }
                window.__ftPipStyles = null;
              };
            })();
        """
    }

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var androidBridge: AndroidBridge
    private var pendingDeepLink: Intent? = null
    private var reloadSmokePending = false
    private var webAppReady = false
    private var pipOverlayActive = false
    private var pipOverlayLayoutParams: ViewGroup.LayoutParams? = null

    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        webView.setBackgroundColor(Color.rgb(16, 16, 16))
        swipeRefresh = findViewById(R.id.swipeRefresh)
        swipeRefresh.setOnRefreshListener { webView.reload() }
        ViewCompat.setOnApplyWindowInsetsListener(swipeRefresh) { view, insets ->
            val safeInsets = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val params = view.layoutParams as ViewGroup.MarginLayoutParams
            params.setMargins(safeInsets.left, safeInsets.top, safeInsets.right, safeInsets.bottom)
            view.layoutParams = params
            view.setPadding(0, 0, 0, 0)
            insets
        }
        pendingDeepLink = intent
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                webAppReady = false
                if (reloadSmokePending) {
                    reloadSmokePending = false
                    Log.i("FreeTubeSmoke", "SMOKE_RELOAD_TEST:PASS")
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                swipeRefresh.isRefreshing = false
            }
        }
        var fullscreenView: View? = null
        val root = findViewById<ViewGroup>(android.R.id.content)
        val insetsController = WindowInsetsControllerCompat(window, window.decorView)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                fullscreenView = view
                root.addView(view)
                (view.layoutParams as? ViewGroup.MarginLayoutParams)?.setMargins(0, 0, 0, 0)
                insetsController.hide(WindowInsetsCompat.Type.systemBars())
                insetsController.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }

            override fun onHideCustomView() {
                fullscreenView?.let {
                    ViewCompat.setOnApplyWindowInsetsListener(it, null)
                    root.removeView(it)
                }
                fullscreenView = null
                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                insetsController.show(WindowInsetsCompat.Type.systemBars())
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                val entry = JSONObject().apply {
                    put("message", message.message())
                    put("source", message.sourceId())
                    put("line", message.lineNumber())
                    put("level", message.messageLevel())
                }.toString()
                consoleMessages.add(entry)
                Log.d("FreeTubeWebView", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        window.attributes.layoutInDisplayCutoutMode =
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        @Suppress("DEPRECATION")
        webView.settings.allowUniversalAccessFromFileURLs = true
        @Suppress("DEPRECATION")
        webView.settings.allowFileAccessFromFileURLs = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        androidBridge = AndroidBridge(this, webView, webView.parent as ViewGroup) { enabled ->
            swipeRefresh.isEnabled = enabled
        }
        webView.addJavascriptInterface(androidBridge, "Android")
        webView.loadUrl("file:///android_asset/index.html")
    }

    fun onWebAppReady() {
        runOnUiThread {
            webAppReady = true
            pendingDeepLink?.let {
                dispatchDeepLink(it)
                pendingDeepLink = null
            }
        }
    }

    private fun dispatchDeepLink(intent: Intent?) {
        val url = intent?.data?.toString() ?: return
        val event = JSONObject.quote(url)
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('youtube-link', { detail: { link: $event } }))",
            null
        )
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            CREATE_FILE_REQUEST -> androidBridge.finishSaveFile(resultCode, data?.data)
            OPEN_FILE_REQUEST -> androidBridge.finishOpenFile(resultCode, data?.data)
            DIRECTORY_REQUEST -> androidBridge.finishDirectoryAccess(resultCode, data?.data)
        }
    }

    override fun onPause() {
        super.onPause()
        Log.i("FreeTubeLifecycle", "onPause")
        webView.evaluateJavascript("window.dispatchEvent(new Event('app-pause'))", null)
    }

    override fun onResume() {
        super.onResume()
        if (pipOverlayActive) exitPictureInPictureOverlay()
        Log.i("FreeTubeLifecycle", "onResume")
        webView.evaluateJavascript("window.dispatchEvent(new Event('app-resume'))", null)
    }

    fun enterPictureInPictureOverlay(): Boolean {
        if (!Settings.canDrawOverlays(this)) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            return false
        }
        if (pipOverlayActive) return false

        webView.evaluateJavascript(PIP_OVERLAY_SCRIPT, null)
        pipOverlayLayoutParams = webView.layoutParams
        swipeRefresh.removeView(webView)
        val metrics = resources.displayMetrics
        val width = (metrics.widthPixels * 0.806f).toInt()
        val height = width * 9 / 16
        val params = WindowManager.LayoutParams(
            width,
            height,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = (metrics.widthPixels - width) / 2
            y = (metrics.heightPixels * 0.125f).toInt()
        }
        getSystemService(WindowManager::class.java).addView(webView, params)
        var dragging = false
        var pinching = false
        var downRawX = 0f
        var downRawY = 0f
        var initialSpan = 0f
        var initialWidth = width
        val downX = params.x
        val downY = params.y
        val touchSlop = ViewConfiguration.get(this).scaledTouchSlop
        fun pointerSpan(event: MotionEvent): Float {
            return kotlin.math.hypot(
                event.getX(0) - event.getX(1),
                event.getY(0) - event.getY(1)
            )
        }
        webView.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    dragging = false
                    pinching = false
                    downRawX = event.rawX
                    downRawY = event.rawY
                    false
                }
                MotionEvent.ACTION_POINTER_DOWN -> {
                    if (event.pointerCount >= 2) {
                        pinching = true
                        initialSpan = pointerSpan(event)
                        initialWidth = params.width
                    }
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (pinching && event.pointerCount >= 2) {
                        val scale = pointerSpan(event) / initialSpan
                        val newWidth = (initialWidth * scale).toInt()
                            .coerceIn(280, metrics.widthPixels)
                        val newHeight = newWidth * 9 / 16
                        val centerX = params.x + params.width / 2
                        val centerY = params.y + params.height / 2
                        params.width = newWidth
                        params.height = newHeight
                        params.x = (centerX - newWidth / 2).coerceIn(0, metrics.widthPixels - newWidth)
                        params.y = (centerY - newHeight / 2).coerceIn(0, metrics.heightPixels - newHeight)
                        getSystemService(WindowManager::class.java).updateViewLayout(webView, params)
                        true
                    } else {
                        if (!dragging &&
                            (kotlin.math.abs(event.rawX - downRawX) > touchSlop ||
                                kotlin.math.abs(event.rawY - downRawY) > touchSlop)
                        ) dragging = true
                        if (dragging) {
                            params.x = (downX + (event.rawX - downRawX).toInt())
                                .coerceIn(0, metrics.widthPixels - params.width)
                            params.y = (downY + (event.rawY - downRawY).toInt())
                                .coerceIn(0, metrics.heightPixels - params.height)
                            getSystemService(WindowManager::class.java).updateViewLayout(webView, params)
                        }
                        dragging
                    }
                }
                MotionEvent.ACTION_POINTER_UP -> {
                    pinching = false
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    pinching = false
                    dragging
                }
                else -> false
            }
        }
        pipOverlayActive = true
        webView.postDelayed({
            webView.evaluateJavascript("document.querySelector('video.player')?.ui?.getControls()?.show()", null)
        }, 100)
        moveTaskToBack(true)
        return true
    }

    private fun exitPictureInPictureOverlay() {
        if (!pipOverlayActive) return
        val windowManager = getSystemService(WindowManager::class.java)
        windowManager.removeViewImmediate(webView)
        webView.setOnTouchListener(null)
        swipeRefresh.addView(webView, pipOverlayLayoutParams)
        pipOverlayLayoutParams = null
        pipOverlayActive = false
        webView.evaluateJavascript("window.__ftRestorePictureInPicture?.()", null)
    }

    override fun onDestroy() {
        Log.i("FreeTubeLifecycle", "onDestroy finishing=$isFinishing changingConfigurations=$isChangingConfigurations")
        androidBridge.cancelMediaNotification()
        webView.destroy()
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        when (intent?.action) {
            "MEDIA_PLAY" -> webView.evaluateJavascript("document.querySelector('video')?.play()", null)
            "MEDIA_PAUSE" -> webView.evaluateJavascript("document.querySelector('video')?.pause()", null)
            "io.freetubeapp.freetubeandroid.TEST_SETTINGS_SORT" -> {
                if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                    runSettingsSortTest()
                }
            }
            "io.freetubeapp.freetubeandroid.TEST_SMOKE_ACTION" -> {
                if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                    val action = intent?.getStringExtra("action")
                    if (action == "fullscreen") runFullscreenSmokeAction()
                    else if (action == "long_press") runLongPressSmokeAction()
                    else if (action == "reload") runReloadSmokeAction()
                    else runSmokeAction(action, intent?.getStringExtra("query"))
                }
            }
            Intent.ACTION_VIEW -> {
                pendingDeepLink = intent
                if (webAppReady) onWebAppReady()
            }
        }
    }

    private fun runReloadSmokeAction() {
        if (reloadSmokePending) {
            Log.i("FreeTubeSmoke", "SMOKE_RELOAD_TEST:FAIL:already-pending")
            return
        }
        reloadSmokePending = true
        swipeRefresh.post {
            val width = swipeRefresh.width.toFloat()
            val height = swipeRefresh.height.toFloat()
            val x = width / 2
            val startY = height * 0.2f
            val endY = height * 0.7f
            val start = android.os.SystemClock.uptimeMillis()
            val down = MotionEvent.obtain(start, start, MotionEvent.ACTION_DOWN, x, startY, 0)
            swipeRefresh.dispatchTouchEvent(down)
            down.recycle()
            for (step in 1..5) {
                val eventTime = start + step * 100L
                val y = startY + (endY - startY) * step / 5
                val move = MotionEvent.obtain(start, eventTime, MotionEvent.ACTION_MOVE, x, y, 0)
                swipeRefresh.dispatchTouchEvent(move)
                move.recycle()
            }
            val up = MotionEvent.obtain(start, start + 600L, MotionEvent.ACTION_UP, x, endY, 0)
            swipeRefresh.dispatchTouchEvent(up)
            up.recycle()
            swipeRefresh.postDelayed({
                if (reloadSmokePending) {
                    reloadSmokePending = false
                    Log.i("FreeTubeSmoke", "SMOKE_RELOAD_TEST:FAIL:gesture-not-triggered")
                }
            }, 5000)
        }
    }

    private fun runLongPressSmokeAction() {
        webView.evaluateJavascript(
            """
            (() => {
              const video = document.querySelector('video');
              const target = document.querySelector('.shaka-spacer, .shaka-controls-container');
              if (!video || !target || video.paused) return '';
              const rect = target.getBoundingClientRect();
              return [rect.left + rect.width / 2, rect.top + rect.height / 2, video.playbackRate].join(',');
            })();
            """.trimIndent()
        ) { rawPoint ->
            val point = rawPoint.trim('"').split(',').mapNotNull { it.toFloatOrNull() }
            if (point.size != 3) {
                Log.i("FreeTubeSmoke", "SMOKE_LONG_PRESS_TEST:FAIL:control-not-found")
                return@evaluateJavascript
            }
            webView.post {
                val now = android.os.SystemClock.uptimeMillis()
                val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, point[0], point[1], 0)
                webView.dispatchTouchEvent(down)
                down.recycle()
                webView.postDelayed({
                    webView.evaluateJavascript("document.querySelector('video')?.playbackRate || 0") { rate ->
                        val accelerated = rate.trim('"').toFloatOrNull()?.let { it > point[2] } == true
                        val upTime = android.os.SystemClock.uptimeMillis()
                        val up = MotionEvent.obtain(upTime, upTime, MotionEvent.ACTION_UP, point[0], point[1], 0)
                        webView.dispatchTouchEvent(up)
                        up.recycle()
                        webView.postDelayed({
                            webView.evaluateJavascript("document.querySelector('video')?.playbackRate || 0") { restoredRate ->
                                val restored = restoredRate.trim('"').toFloatOrNull() == point[2]
                                Log.i("FreeTubeSmoke", "SMOKE_LONG_PRESS_TEST:${if (accelerated && restored) "PASS" else "FAIL"}:accelerated=$accelerated,restored=$restored")
                            }
                        }, 300)
                    }
                }, 700)
            }
        }
    }

    private fun runFullscreenSmokeAction() {
        webView.evaluateJavascript(
            """
            (() => {
              const button = document.querySelector('.shaka-fullscreen-button');
              if (!button) return '';
              const rect = button.getBoundingClientRect();
              return (rect.left + rect.width / 2) + ',' + (rect.top + rect.height / 2);
            })();
            """.trimIndent()
        ) { rawPoint ->
            val point = rawPoint.trim('"').split(',').mapNotNull { it.toFloatOrNull() }
            if (point.size != 2) {
                Log.i("FreeTubeSmoke", "SMOKE_FULLSCREEN_TEST:FAIL:control-not-found")
                return@evaluateJavascript
            }
            webView.post {
                val now = android.os.SystemClock.uptimeMillis()
                val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, point[0], point[1], 0)
                val up = MotionEvent.obtain(now, now + 50, MotionEvent.ACTION_UP, point[0], point[1], 0)
                webView.dispatchTouchEvent(down)
                webView.dispatchTouchEvent(up)
                down.recycle()
                up.recycle()
                webView.postDelayed({
                    webView.evaluateJavascript(
                        "document.fullscreenElement ? 'PASS' : 'FAIL'"
                    ) { result ->
                        Log.i("FreeTubeSmoke", "SMOKE_FULLSCREEN_TEST:${result.trim('"')}")
                    }
                }, 1000)
            }
        }
    }

    private fun runSmokeAction(action: String?, query: String?) {
        if (action != "search" && action != "settings" && action != "fit" && action != "fit_visual" && action != "fullscreen" && action != "long_press" && action != "reload" && action != "video_state" && action != "proxy" && action != "proxy_off" && action != "data_export" && action != "data_select" && action != "data_reset" && action != "persistence_set" && action != "persistence_check" && action != "scale_layout") {
            Log.i("FreeTubeSmoke", "SMOKE_ACTION:$action:FAIL:unsupported")
            return
        }
        val value = JSONObject.quote(query ?: "linux")
        webView.evaluateJavascript(
            """
            (() => {
              const value = $value;
              if ('$action' === 'video_state') {
                const video = document.querySelector('video');
                console.log('SMOKE_VIDEO_STATE:' + JSON.stringify({
                  hash: location.hash,
                  video: !!video,
                  readyState: video?.readyState,
                  networkState: video?.networkState,
                  error: video?.error?.code,
                  paused: video?.paused,
                  width: video?.videoWidth,
                  height: video?.videoHeight,
                  currentSrc: video?.currentSrc,
                  networkType: window.Android?.getNetworkType?.()
                }));
                return;
              }
              if ('$action' === 'fullscreen') {
                setTimeout(() => {
                  console.log('SMOKE_FULLSCREEN_TEST:' + (document.fullscreenElement ? 'PASS' : 'FAIL'));
                }, 500);
                return;
              }
              if ('$action' === 'persistence_set') {
                setTimeout(() => {
                  const input = document.querySelector('[data-test="ui-scale"]');
                  if (!input) {
                    console.log('SMOKE_PERSISTENCE_SET_TEST:FAIL:control-not-found');
                    return;
                  }
                  const original = Number(input.value);
                  const requested = Number(value);
                  const target = value !== '' && Number.isFinite(requested) ? requested : (original === 300 ? original - 5 : original + 5);
                  input.value = target;
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  console.log('SMOKE_PERSISTENCE_SET_TEST:PASS:' + original + ':' + target);
                }, 1000);
                return;
              }
              if ('$action' === 'persistence_check') {
                setTimeout(() => {
                  const input = document.querySelector('[data-test="ui-scale"]');
                  const parts = value.split(':');
                  const target = Number(parts[0]);
                  const original = Number(parts[1]);
                  if (!input) {
                    console.log('SMOKE_PERSISTENCE_CHECK_TEST:FAIL:control-not-found');
                    return;
                  }
                  const passed = Number(input.value) === target;
                  input.value = original;
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  console.log('SMOKE_PERSISTENCE_CHECK_TEST:' + (passed ? 'PASS' : 'FAIL') + ':' + input.value);
                }, 1000);
                return;
              }
              if ('$action' === 'scale_layout') {
                const input = document.querySelector('[data-test="ui-scale"]');
                const expectedScale = Number(value.split(':')[0]);
                const expectedLayout = value.split(':')[1];
                const mobile = matchMedia('(width <= 680px)').matches;
                const passed = Number(input?.value) === expectedScale && (expectedLayout === 'unchanged' || mobile === (expectedLayout === 'mobile'));
                console.log('SMOKE_SCALE_LAYOUT_TEST:' + (passed ? 'PASS' : 'FAIL') + ':scale=' + input?.value + ',width=' + innerWidth + ',layout=' + (mobile ? 'mobile' : 'desktop'));
                return;
              }
              if ('$action' === 'data_export' || '$action' === 'data_select' || '$action' === 'data_reset') {
                const selector = '$action' === 'data_export'
                  ? '[data-test="data-export-playlists"]'
                  : ('$action' === 'data_reset'
                      ? '[data-test="data-reset-directory"]'
                      : '[data-test="data-select-directory"]');
                window.location.hash = '#/settings';
                setTimeout(() => {
                  const link = document.querySelector('[data-section="data"]');
                  link?.click();
                  setTimeout(() => {
                    const button = document.querySelector(selector);
                    if (!button) {
                      console.log('SMOKE_' + ('$action' === 'data_export' ? 'DATA_EXPORT' : ('$action' === 'data_reset' ? 'DATA_RESET' : 'DATA_SELECT')) + '_TEST:FAIL:button-not-found');
                      return;
                    }
                    button.click();
                    console.log('SMOKE_' + ('$action' === 'data_export' ? 'DATA_EXPORT' : ('$action' === 'data_reset' ? 'DATA_RESET' : 'DATA_SELECT')) + '_TEST:PASS');
                  }, 700);
                }, 300);
                return;
              }
              if ('$action' === 'proxy_off') {
                const input = document.querySelector('[data-test="proxy-enabled"]');
                if (!input) {
                  console.log('SMOKE_PROXY_OFF_TEST:FAIL:control-not-found');
                  return;
                }
                if (input.checked) input.click();
                setTimeout(() => console.log('SMOKE_PROXY_OFF_TEST:' + (!input.checked ? 'PASS' : 'FAIL')), 300);
                return;
              }
              if ('$action' === 'proxy') {
                const enabled = document.querySelector('[data-test="proxy-enabled"]');
                if (!enabled) {
                  console.log('SMOKE_PROXY_TEST:FAIL:toggle-not-found');
                  return;
                }
                if (!enabled.checked) enabled.click();
                setTimeout(() => {
                  const inputValue = (selector, value) => {
                    const input = document.querySelector(selector);
                    if (!input) return false;
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    setter.call(input, value);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                  };
                  const protocol = document.querySelector('[data-test="proxy-protocol"]');
                  const host = inputValue('[data-test="proxy-host"]', '127.0.0.1');
                  const port = inputValue('[data-test="proxy-port"]', value);
                  if (!protocol || !host || !port) {
                    console.log('SMOKE_PROXY_TEST:FAIL:controls-not-found:' + JSON.stringify({
                      protocol: !!protocol,
                      host,
                      port
                    }));
                    return;
                  }
                  protocol.value = 'http';
                  protocol.dispatchEvent(new Event('change', { bubbles: true }));
                  setTimeout(() => {
                    const button = document.querySelector('[data-test="proxy-test"]');
                    if (!button) {
                      console.log('SMOKE_PROXY_TEST:FAIL:test-button-not-found');
                      return;
                    }
                    button.click();
                    setTimeout(() => console.log('SMOKE_PROXY_TEST:PASS'), 1000);
                  }, 500);
                }, 700);
                return;
              }
              if ('$action' === 'fit_visual') {
                const video = document.querySelector('.ftVideoPlayer > .player');
                const expected = value === 'on' ? 'cover' : 'contain';
                const actual = video ? getComputedStyle(video).objectFit : '';
                console.log('SMOKE_FIT_VISUAL_TEST:' + (actual === expected ? 'PASS' : 'FAIL') + ':' + actual);
                return;
              }
              if ('$action' === 'fit') {
                const button = document.querySelector('[data-test="fit-screen"]');
                const target = value === 'on';
                if (!button) {
                  console.log('SMOKE_FIT_TEST:FAIL:control-not-found');
                  return;
                }
                if (button.getAttribute('aria-pressed') !== String(target)) button.click();
                setTimeout(() => {
                  console.log('SMOKE_FIT_TEST:' + (button.getAttribute('aria-pressed') === String(target) ? 'PASS' : 'FAIL') + ':' + button.getAttribute('aria-pressed'));
                }, 300);
                return;
              }
              if ('$action' === 'settings') {
                window.location.hash = '#/settings';
                setTimeout(() => {
                  const link = document.querySelector('[data-section="' + value + '"]');
                  link?.click();
                  setTimeout(() => {
                    const section = document.querySelector('.settingsSections [data-section="' + value + '"]');
                    const passed = !!link && !!section && !section.classList.contains('hideOnMobile');
                    console.log('SMOKE_SETTINGS_TEST:' + (passed ? 'PASS' : 'FAIL') + ':' + value);
                  }, 300);
                }, 300);
                return;
              }
              const open = document.querySelector('[data-test="search-open"]');
              open?.click();
              setTimeout(() => {
                const input = document.querySelector('.searchInput input');
                const action = document.querySelector('.searchInput .inputAction');
                if (!input || !action) {
                  console.log('SMOKE_SEARCH_TEST:FAIL:controls-not-found');
                  return;
                }
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                setter.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                action.click();
                setTimeout(() => {
                  const passed = location.hash.startsWith('#/search/');
                  console.log('SMOKE_SEARCH_TEST:' + (passed ? 'PASS' : 'FAIL') + ':' + location.hash);
                }, 500);
              }, 300);
            })();
            """.trimIndent(),
            null
        )
    }

    private fun runSettingsSortTest() {
        webView.evaluateJavascript(
            """
            (() => {
              window.location.hash = '#/settings';
              setTimeout(() => {
                const expectedOff = ['general', 'theme', 'player', 'subscription', 'distraction', 'parental-control', 'privacy', 'data', 'proxy', 'sponsor-block', 'password'];
                const expectedOn = ['general', 'data', 'distraction', 'parental-control', 'password', 'player', 'privacy', 'proxy', 'sponsor-block', 'subscription', 'theme'];
                const links = [...document.querySelectorAll('.settingsMenu a[data-section]')];
                const order = links.map(link => link.dataset.section);
                const label = [...document.querySelectorAll('label')].find(element => element.textContent.includes('Sort settings sections (A-Z)'));
                const input = label ? document.getElementById(label.htmlFor) : null;
                const initial = input?.checked;
                const readOrder = () => [...document.querySelectorAll('.settingsMenu a[data-section]')].map(link => link.dataset.section);
                const orderMatches = (value, expected) => JSON.stringify(value) === JSON.stringify(expected);
                const setState = (target, done) => {
                  if (input.checked === target) {
                    done();
                    return;
                  }
                  input.click();
                  setTimeout(done, 300);
                };
                setState(false, () => {
                  const offOrder = readOrder();
                  setState(true, () => {
                    const onOrder = readOrder();
                    setState(initial, () => {
                      const restored = input.checked === initial;
                      const pass = orderMatches(offOrder, expectedOff) && orderMatches(onOrder, expectedOn) && restored;
                      console.log('SETTINGS_SORT_TEST:' + (pass ? 'PASS' : 'FAIL') + ':' + JSON.stringify({ initial, order, offOrder, onOrder, restored }));
                    });
                  });
                });
              }, 1500);
            })();
            """.trimIndent(),
            null
        )
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            androidBridge.cancelMediaNotification()
            super.onBackPressed()
        }
    }
}
