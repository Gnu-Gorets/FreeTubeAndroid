import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const player = await readFile('src/renderer/components/ft-shaka-video-player/ft-shaka-video-player.js', 'utf8')
const template = await readFile('src/renderer/components/ft-shaka-video-player/ft-shaka-video-player.vue', 'utf8')
const mediaSession = await readFile('src/renderer/helpers/android/media-session.js', 'utf8')

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
assert.match(player, /android\?\.enterPictureInPicture\?\./)
assert.match(template, /fitScreen: fitVideoToFullscreen && fullscreenLandscape/)
assert.match(player, /getDefaultQualityForNetwork\(/)
assert.match(player, /android\?\.setSwipeRefreshEnabled\?\.\(true\)/)
assert.match(player, /props\.autoplayOnLoad && video\.value\.paused/)
assert.match(player, /emit\('play'\)/)

assert.match(player, /registerFitScreenButton\(\)/)
assert.match(player, /registerPictureInPictureButton\(\)/)
assert.match(player, /const pictureInPictureButton = process\.env\.IS_ANDROID \? 'ft_picture_in_picture' : 'picture_in_picture'/)
assert.match(player, /playerMenuObserver\?\.disconnect\(\)/)

console.log('Android player integration: PASS')
