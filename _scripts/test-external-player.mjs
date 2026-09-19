import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const utils = await readFile('src/renderer/helpers/utils.js', 'utf8')
const bridge = await readFile('android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', 'utf8')
const manifest = await readFile('android/app/src/main/AndroidManifest.xml', 'utf8')
const video = await readFile('src/renderer/components/FtListVideo/FtListVideo.vue', 'utf8')
const playlist = await readFile('src/renderer/components/FtListPlaylist/FtListPlaylist.vue', 'utf8')
const watchInfo = await readFile('src/renderer/components/WatchVideoInfo/WatchVideoInfo.vue', 'utf8')

assert.match(utils, /export function openExternalPlayer\(payload\)/)
assert.match(utils, /window\.Android\.openExternalPlayer\(/)
assert.match(utils, /window\.ftElectron\.openInExternalPlayer\(payload\)/)
assert.match(utils, /payload\.manifestUrl/)
assert.match(utils, /url === manifestUrl/)
assert.match(utils, /https:\/\/www\.youtube\.com\/watch\?v=\$\{videoId\}/)
assert.match(utils, /https:\/\/www\.youtube\.com\/playlist\?list=\$\{playlistId\}/)

assert.match(bridge, /@JavascriptInterface\s+fun openExternalPlayer\(url: String, isManifest: Boolean, title: String\?\)/)
assert.match(bridge, /Intent\.ACTION_VIEW/)
assert.match(bridge, /Intent\.createChooser\(intent, null\)/)
assert.match(bridge, /application\/dash\+xml/)
assert.match(bridge, /ActivityNotFoundException/)
assert.doesNotMatch(bridge, /ExternalRelayService|startForegroundService|ServerSocket\(/)
assert.doesNotMatch(manifest, /ExternalRelayService|FOREGROUND_SERVICE/)

assert.match(video, /await getLocalVideoInfo\(id\.value\)/)
assert.match(video, /openExternalPlayer\(/)
assert.match(video, /mediaUrl,\n        manifestUrl/)
assert.doesNotMatch(video, /pending: true|updateExternalPlayer|relayUrl|externalStreams/)

assert.match(watchInfo, /await getLocalVideoInfo\(props\.id\)/)
assert.match(watchInfo, /openExternalPlayer\(\{ \.\.\.payload, mediaUrl, manifestUrl \}\)/)
assert.doesNotMatch(watchInfo, /pending: true|updateExternalPlayer|relayUrl/)

for (const component of [video, playlist, watchInfo]) {
  assert.match(component, /openExternalPlayer\(/)
}

console.log('external player contract: PASS')
