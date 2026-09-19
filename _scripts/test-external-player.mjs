import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const utils = await readFile('src/renderer/helpers/utils.js', 'utf8')
const bridge = await readFile('android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', 'utf8')
const video = await readFile('src/renderer/components/FtListVideo/FtListVideo.vue', 'utf8')
const playlist = await readFile('src/renderer/components/FtListPlaylist/FtListPlaylist.vue', 'utf8')
const watchInfo = await readFile('src/renderer/components/WatchVideoInfo/WatchVideoInfo.vue', 'utf8')

assert.match(utils, /export function openExternalPlayer\(payload\)/)
assert.match(utils, /window\.Android\.openExternalPlayer\(/)
assert.match(utils, /window\.ftElectron\.openInExternalPlayer\(payload\)/)
assert.match(utils, /https:\/\/www\.youtube\.com\/watch\?v=\$\{videoId\}/)
assert.match(utils, /https:\/\/www\.youtube\.com\/playlist\?list=\$\{playlistId\}/)
assert.match(utils, /&t=\$\{Math\.floor\(payload\.startTime\)\}/)
assert.match(utils, /JSON\.stringify\(payload\.externalHeaders\)/)
assert.match(utils, /JSON\.stringify\(payload\.externalStreams\)/)
assert.match(utils, /payload\.mediaMimeType \?\? null/)
assert.match(utils, /payload\.manifestUrl \?\? null/)
assert.match(utils, /payload\.maxQuality \?\? null/)
assert.match(utils, /if \(!videoId && !playlistId\) return/)

assert.match(bridge, /@JavascriptInterface\s+fun openExternalPlayer\(/)
assert.match(bridge, /pending: Boolean\): String/)
assert.match(bridge, /mediaMimeType: String\?/)
assert.match(bridge, /@JavascriptInterface\s+fun updateExternalPlayer\(/)
assert.match(bridge, /Intent\.ACTION_VIEW/)
assert.match(bridge, /Intent\.createChooser\(intent, null\)/)
assert.match(bridge, /ActivityNotFoundException/)
assert.match(bridge, /external_player_unavailable/)
assert.match(bridge, /ServerSocket\(0, 16, InetAddress\.getByName\("127\.0\.0\.1"\)\)/)
assert.match(bridge, /setRequestProperty\("Range", it\)/)
assert.match(bridge, /setRequestProperty\("Cookie", it\)/)
assert.match(bridge, /rewriteDashManifest\(/)
assert.match(bridge, /maxHeight\?\.let/)
assert.match(bridge, /registerExternalStreamsManifest\(/)
assert.match(bridge, /val useDirectUrl = !pending && streamsJson == null && !useManifest && !isYoutubeWatchUrl/)
assert.match(bridge, /val relayUrl = if \(useDirectUrl\)/)
assert.match(bridge, /Intent\.EXTRA_TITLE/)
assert.match(bridge, /usePendingRelay -> ""/)

assert.match(video, /await getLocalVideoInfo\(id\.value\)/)
assert.match(video, /mediaMimeType = selectedFormat\.mime_type/)
assert.match(video, /hasAudio = format =>/)
assert.match(video, /if \(!selectedFormat && selectedAdaptiveVideo && selectedAdaptiveAudio\)/)
assert.match(video, /pending: !mediaUrl && !externalStreams/)

for (const component of [video, playlist, watchInfo]) {
  assert.match(component, /openExternalPlayer\(/)
}

console.log('external player contract: PASS')
