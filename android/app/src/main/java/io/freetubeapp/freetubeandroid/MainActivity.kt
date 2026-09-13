package io.freetubeapp.freetubeandroid

import android.app.Activity
import android.graphics.Color
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.webkit.WebSettings
import android.webkit.WebViewClient
import androidx.core.view.ViewCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject

class MainActivity : Activity() {
    companion object {
        val consoleMessages = java.util.concurrent.CopyOnWriteArrayList<String>()
        const val CREATE_FILE_REQUEST = 1001
        const val OPEN_FILE_REQUEST = 1002
        const val DIRECTORY_REQUEST = 1003
    }

    private lateinit var webView: WebView
    private lateinit var androidBridge: AndroidBridge
    private var pendingDeepLink: Intent? = null

    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        val swipeRefresh = findViewById<SwipeRefreshLayout>(R.id.swipeRefresh)
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
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                swipeRefresh.isRefreshing = false
                pendingDeepLink?.let {
                    dispatchDeepLink(it)
                    pendingDeepLink = null
                }
            }
        }
        var fullscreenView: View? = null
        val root = webView.parent as ViewGroup
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
                insetsController.hide(WindowInsetsCompat.Type.systemBars())
                insetsController.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }

            override fun onHideCustomView() {
                fullscreenView?.let(root::removeView)
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
        webView.settings.userAgentString = webView.settings.userAgentString
            .replace(Regex("Mozilla/5.0 \\([^)]*\\)"), "Mozilla/5.0 (X11; Linux x86_64)")
            .replace("Mobile Safari", "Safari")
        webView.settings.domStorageEnabled = true
        @Suppress("DEPRECATION")
        webView.settings.allowUniversalAccessFromFileURLs = true
        @Suppress("DEPRECATION")
        webView.settings.allowFileAccessFromFileURLs = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        androidBridge = AndroidBridge(this, webView, webView.parent as ViewGroup)
        webView.addJavascriptInterface(androidBridge, "Android")
        webView.settings.cacheMode = WebSettings.LOAD_NO_CACHE
        webView.loadUrl("file:///android_asset/index.html")
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
        Log.i("FreeTubeLifecycle", "onResume")
        webView.evaluateJavascript("window.dispatchEvent(new Event('app-resume'))", null)
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
            Intent.ACTION_VIEW -> dispatchDeepLink(intent)
        }
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
