import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const utils = await readFile('src/renderer/helpers/utils.js', 'utf8')
const bridgeSource = await readFile('android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', 'utf8')
const activity = await readFile('android/app/src/main/java/io/freetubeapp/freetubeandroid/MainActivity.kt', 'utf8')
const mainActivity = activity
const smokeScript = await readFile('_scripts/android-smoke-test.sh', 'utf8')
const externalPlayerCase = section(smokeScript, 'external_player_case() {', 'external_player_single() {')
const bridge = section(bridgeSource, '    @JavascriptInterface\n    fun openExternalPlayer(', '    @JavascriptInterface\n    fun shareText(')
const picker = section(bridge, '    private fun showExternalPlayerPicker(', '    private fun launchExternalPlayer(')
const launch = section(bridge, '    private fun launchExternalPlayer(', '    @JavascriptInterface\n    fun setSmokeExternalPlayerPackage(')
const update = section(bridge, '    @JavascriptInterface\n    fun updateExternalPlayer(', '    private fun registerExternalStream(')
const video = await readFile('src/renderer/components/FtListVideo/FtListVideo.vue', 'utf8')
const playlist = await readFile('src/renderer/components/FtListPlaylist/FtListPlaylist.vue', 'utf8')
const watchInfo = await readFile('src/renderer/components/WatchVideoInfo/WatchVideoInfo.vue', 'utf8')
const smokeTest = await readFile('_scripts/android-smoke-test.sh', 'utf8')

assert.match(activity, /action != "external_player_enable"/)
assert.match(activity, /if \('\$action' === 'external_player_enable'\)[\s\S]*?if \(!toggle\.checked\) toggle\.click\(\)[\s\S]*?SMOKE_EXTERNAL_PLAYER_ENABLE_TEST:.*PASS:enabled/)
assert.match(smokeScript, /run_web_smoke_action external_player_enable/)
assert.equal((externalPlayerCase.match(/open_search_results \|\| return 1/g) || []).length, 2)

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
assert.match(bridge, /if \(pending\) \{\s+showExternalPlayerPicker\(relayUrl, title, requestId\)/)
assert.match(update, /externalStreams\[token\] = manifestStream/)
assert.match(update, /externalStreams\[token\] = ExternalStream\(streamUrl, headers, isManifest, maxQuality\)/)
assert.doesNotMatch(update, /startActivity|launchExternalPlayer|showExternalPlayerPicker/)
assert.match(bridge, /for \(attempt in 0 until 150\) \{[\s\S]*?Thread\.sleep\(100\)[\s\S]*?stream = externalStreams\[token\] \?: return/)
for (const helper of [picker, launch]) {
  assert.match(helper, /activity\.runOnUiThread/)
  assert.match(helper, /Intent\.ACTION_VIEW/)
  assert.match(helper, /activity\.startActivity\(/)
  assert.match(helper, /ActivityNotFoundException/)
  assert.match(helper, /external_player_unavailable/)
  assert.match(helper, /putExtra\("title", title\)/)
}
assert.match(bridge, /mediaMimeType: String\?/)
assert.match(bridge, /@JavascriptInterface\s+fun updateExternalPlayer\(/)
assert.match(bridge, /Intent\.ACTION_VIEW/)
assert.match(bridge, /else -> "\.mp4"/)
assert.match(bridge, /activity\.startActivity\(intent\)/)
assert.match(bridge, /setDataAndType\(Uri\.parse\(intentUrl\), mimeType\)/)
assert.match(bridge, /if \(stream\.isManifest\) "application\/dash\+xml" else connection\.contentType/)
assert.match(bridge, /removeSuffix\("\.mpd"\)\?\.removeSuffix\("\.mp4"\)/)
assert.match(bridge, /launchExternalPlayer\(/)
assert.match(smokeTest, /selectedHeight/)
assert.doesNotMatch(smokeTest, /selectedAdaptiveHeight/)
assert.match(smokeTest, /run_web_smoke_action external_player_enable/)
assert.match(mainActivity, /action != "external_player_enable"/)
assert.match(mainActivity, /if \(changed\) toggle\.click\(\)/)
assert.match(mainActivity, /SMOKE_EXTERNAL_PLAYER_ENABLE_TEST:PASS:/)
assert.match(bridge, /ActivityNotFoundException/)
assert.match(bridge, /external_player_unavailable/)
assert.match(bridge, /ServerSocket\(0, 16, InetAddress\.getByName\("127\.0\.0\.1"\)\)/)
assert.match(bridge, /return "http:\/\/127\.0\.0\.1:\$\{externalRelayServer\?\.localPort\}\/\$token"/)
assert.match(bridge, /setRequestProperty\("Range", it\)/)
assert.match(bridge, /setRequestProperty\("Cookie", it\)/)
assert.match(bridge, /Content-Type: \$\{if \(stream\.isManifest\) "application\/dash\+xml" else connection\.contentType \?: "video\/mp4"\}/)
assert.match(bridge, /Content-Range:/)
assert.match(bridge, /Accept-Ranges: bytes/)
assert.match(bridge, /profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"/)
assert.match(bridge, /rewriteDashManifest\(/)
assert.match(bridge, /maxHeight\?\.let/)
assert.match(bridge, /registerExternalStreamsManifest\(/)
assert.match(bridge, /val useDirectUrl = !pending && streamsJson == null && !useManifest && !isYoutubeWatchUrl && headers\.isEmpty\(\)/)
assert.match(bridge, /val relayUrl = if \(useDirectUrl\)/)
assert.match(bridge, /usePendingRelay -> ""/)

for (const component of [video, watchInfo]) {
  assert.match(component, /await openAndroidExternalPlayer\(payload\)|await openAndroidExternalPlayer\(\{/)
}
assert.match(bridge, /else if \(useManifest \|\| streamsJson != null\) "video\/\*"/)
assert.match(launch, /smokeExternalPlayerPackage\?\.takeIf/)

assert.match(bridge, /requestMethod = "GET"/)
assert.match(bridge, /range\?\.let \{ setRequestProperty\("Range", it\) \}/)
assert.doesNotMatch(bridge, /appendQueryParameter\("alr", "yes"\)/)
assert.doesNotMatch(bridge, /requestMethod = "POST"/)
assert.doesNotMatch(bridge, /byteArrayOf\(0x78, 0x00\)/)

for (const component of [video, playlist, watchInfo]) {
  assert.match(component, /openExternalPlayer\(/)
}

function section(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Missing source boundaries: ${start} / ${end}`)
  return source.slice(startIndex, endIndex)
}

const helpers = section(utils, 'export function openExternalPlayer(payload)', '/**\n * Opens native Android sharesheet')
const calls = []
const context = {
  process: { env: { IS_ANDROID: true, IS_ELECTRON: false } },
  window: {
    Android: {
      openExternalPlayer: (...args) => {
        calls.push(args)
        return 'relay-result'
      },
      updateExternalPlayer: (...args) => calls.push(args)
    },
    ftElectron: { openInExternalPlayer: payload => calls.push(payload) }
  },
  console: { warn() {} }
}
runInNewContext(helpers.replaceAll('export function ', 'function '), context)

const payload = { videoId: 'a&b', playlistId: 'list/?', startTime: 12.9, pending: true }
const original = structuredClone(payload)
assert.equal(context.openExternalPlayer(payload), 'relay-result')
assert.deepEqual(calls.pop(), ['https://www.youtube.com/watch?v=a%26b&list=list%2F%3F&t=12', null, null, null, null, null, null, true])
assert.deepEqual(payload, original, 'opening must not change the caller payload')
context.openExternalPlayer({ playlistId: 'list/?' })
assert.deepEqual(calls.pop(), ['https://www.youtube.com/playlist?list=list%2F%3F', null, null, null, null, null, null, false])

const headers = { 'X-YouTube-Client-Name': '1' }
const streams = { videoUrl: 'https://media.example/video', audioUrl: 'https://media.example/audio' }
const media = {
  ...payload,
  mediaUrl: 'https://media.example/file',
  externalHeaders: headers,
  externalStreams: streams,
  manifestUrl: 'https://media.example/manifest.mpd',
  maxQuality: 720,
  mediaMimeType: 'video/mp4',
  title: 'Video title'
}
context.openExternalPlayer(media)
assert.deepEqual(calls.pop(), [media.mediaUrl, JSON.stringify(headers), media.manifestUrl, 720, JSON.stringify(streams), 'video/mp4', 'Video title', true])
for (const pending of [undefined, false, 'true', 1]) {
  context.openExternalPlayer({ videoId: 'id', pending })
  assert.equal(calls.pop()[7], false, 'pending requires boolean true')
}
context.openExternalPlayer({ videoId: 'id', mediaUrl: 'file:///private/video' })
assert.equal(calls.pop()[0], 'https://www.youtube.com/watch?v=id')
for (const empty of [{}, { mediaUrl: media.mediaUrl }, { videoId: 1, playlistId: null }]) {
  context.openExternalPlayer(empty)
  assert.equal(calls.length, 0, 'a video or playlist ID is required')
}

context.updateExternalPlayer('relay-result', media)
assert.deepEqual(calls.pop(), ['relay-result', media.mediaUrl, JSON.stringify(headers), media.manifestUrl, 720, JSON.stringify(streams)])
context.updateExternalPlayer('relay-result', {})
assert.deepEqual(calls.pop(), ['relay-result', null, null, null, null, null])
context.updateExternalPlayer('', media)
assert.equal(calls.length, 0)

context.process.env.IS_ANDROID = false
context.process.env.IS_ELECTRON = true
context.openExternalPlayer(payload)
assert.equal(calls.pop(), payload, 'Electron must receive the original payload')
context.updateExternalPlayer('relay-result', media)
assert.equal(calls.length, 0)
context.process.env.IS_ELECTRON = false
context.openExternalPlayer(payload)
context.updateExternalPlayer('relay-result', media)
assert.equal(calls.length, 0, 'web must not call the Android bridge')
context.process.env.IS_ANDROID = true
context.window.Android = {}
context.openExternalPlayer(payload)
context.updateExternalPlayer('relay-result', media)
assert.equal(calls.length, 0, 'an unavailable bridge must be a no-op')

console.log('external player contract: PASS')
