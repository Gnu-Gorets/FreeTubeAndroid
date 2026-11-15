import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const player = await readFile('src/renderer/components/FtShakaVideoPlayer/FtShakaVideoPlayer.vue', 'utf8')
const mediaSession = await readFile('src/renderer/helpers/android/media-session.js', 'utf8')
const bridge = await readFile('android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', 'utf8')
const mainActivity = await readFile('android/app/src/main/java/io/freetubeapp/freetubeandroid/MainActivity.kt', 'utf8')

assert.match(player, /updateMediaSessionState\(STATE_PLAYING\)/)
assert.match(player, /updateMediaSessionState\(STATE_PAUSED, Math\.floor\(video\.value\.currentTime \* 1000\)\)/)
assert.match(player, /updateMediaSessionState\(STATE_NONE, Math\.floor\(video\.value\.currentTime \* 1000\)\)/)
assert.match(player, /updateMediaSessionState\(STATE_BUFFERING, Math\.floor\(videoElement\.currentTime \* 1000\)\)/)
assert.match(mediaSession, /export const STATE_NONE = 0/)

for (const event of ['media-play', 'media-pause', 'media-seek', 'media-seek-forward', 'media-seek-backward', 'media-seek-forward-start', 'media-seek-backward-start', 'media-seek-stop', 'app-pause', 'app-resume']) {
  assert.match(player, new RegExp(`window\\.addEventListener\\('${event}'`))
  assert.match(player, new RegExp(`window\\.removeEventListener\\('${event}'`))
}

assert.match(player, /android\.enableKeepScreenOn\(\)/)
assert.match(player, /android\.disableKeepScreenOn\(\)/)
assert.match(bridge, /fun enableKeepScreenOn\(\) \{\s+activity\.runOnUiThread \{\s+activity\.window\.addFlags\(android\.view\.WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)/)
assert.match(bridge, /fun disableKeepScreenOn\(\) \{\s+activity\.runOnUiThread \{\s+activity\.window\.clearFlags\(android\.view\.WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)/)
assert.match(mainActivity, /ViewCompat\.setOnApplyWindowInsetsListener\(root\) \{ content, insets ->[\s\S]*?fullscreenView != null[\s\S]*?insetsController\.hide\(WindowInsetsCompat\.Type\.systemBars\(\)\)/)
assert.match(mainActivity, /ViewCompat\.setOnApplyWindowInsetsListener\(root, null\)/)
assert.match(await readFile('src/renderer/components/FtShakaVideoPlayer/FtShakaVideoPlayer.css', 'utf8'), /\.ftVideoPlayer:fullscreen > \.player \{[^}]*touch-action: none;/)
assert.match(player, /android\?\.enterPictureInPicture\?\./)
assert.match(player, /fitScreen: fitVideoToFullscreen && fullscreenLandscape/)
assert.match(player, /addAndroidPinchZoom\(container\.value, video\.value\)/)
assert.match(player, /return !process\.env\.IS_ANDROID && store\.getters\.getEnterFullscreenOnDisplayRotate/)
assert.match(player, /android\?\.setSwipeRefreshEnabled\?\.\(false\)/)
assert.match(player, /android\?\.setSwipeRefreshEnabled\?\.\(true\)/)
assert.doesNotMatch(player, /document\.exitFullscreen\(\)/)
assert.match(player, /if \(!process\.env\.IS_ANDROID\) \{\s+ui\.getControls\(\)\.toggleFullScreen\(\)/)
assert.match(await readFile('src/renderer/components/PlayerSettings/PlayerSettings.vue', 'utf8'), /v-if="!IS_ANDROID"\s+:label="t\('Settings\.Player Settings\.Enter Fullscreen on Display Rotate'\)"/)
assert.match(player, /getDefaultQualityForNetwork\(/)
assert.match(player, /props\.autoplayOnLoad && video\.value\.paused/)
assert.match(player, /emit\('play'\)/)

console.log('Android player integration: PASS')
