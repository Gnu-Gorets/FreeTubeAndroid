import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { selectExternalStreams } from '../src/renderer/helpers/player/external-streams.mjs'
import { getDefaultQualityForNetwork } from '../src/renderer/helpers/player/network-quality.mjs'

const video = height => ({
  height,
  width: height * 16 / 9,
  mime_type: 'video/mp4; codecs="avc1.640028"',
  url: `https://media.example/video${height}`,
  bitrate: 1000,
  init_range: { start: 0, end: 100 },
  index_range: { start: 101, end: 200 }
})
const audio = {
  mime_type: 'audio/mp4; codecs="mp4a.40.2"',
  url: 'https://media.example/audio',
  bitrate: 128000,
  is_original: true,
  language: 'ru',
  audio_channels: 2,
  audio_sample_rate: 44100,
  init_range: { start: 0, end: 100 },
  index_range: { start: 101, end: 200 }
}
const progressive = { ...video(360), has_audio: true }
const info = {
  basic_info: { duration: 785 },
  streaming_data: {
    formats: [progressive],
    adaptive_formats: [video(2160), video(1080), video(720), video(480), audio]
  }
}
const original = structuredClone(info)
for (const [target, expected] of [[1080, 1080], [480, 480], [900, 720], [144, 480]]) {
  const selected = selectExternalStreams(info, target, 'ru')
  assert.equal(selected.externalStreams.videoHeight, expected)
  assert.equal(selected.externalStreams.audioUrl, audio.url)
  assert.equal(selected.externalStreams.durationSeconds, 785)
  assert.deepEqual(selected.externalStreams.videoIndexRange, { start: 101, end: 200 })
  assert.equal(selected.maxQuality, expected)
}
assert.deepEqual(info, original)
assert.equal(selectExternalStreams({ streaming_data: { formats: [progressive] } }, 480).mediaUrl, progressive.url)
assert.equal(selectExternalStreams({ streaming_data: { formats: [progressive], adaptive_formats: [video(480)] } }, 480).mediaUrl, progressive.url)
assert.throws(() => selectExternalStreams({ streaming_data: { adaptive_formats: [video(480)] } }, 480), /No playable video with audio/)
assert.throws(() => selectExternalStreams({}, 480), /No playable video with audio/)
assert.throws(() => selectExternalStreams({ streaming_data: { formats: [{ ...progressive, url: 'file:///private/video' }] } }, 480), /No playable video with audio/)

const alternateAudio = { ...audio, url: 'https://media.example/dub', is_original: false, language: 'en', bitrate: 256000 }
const multilingual = structuredClone(info)
multilingual.streaming_data.adaptive_formats.push(alternateAudio)
assert.equal(selectExternalStreams(multilingual, 1080, 'ru').externalStreams.audioUrl, audio.url)
multilingual.streaming_data.adaptive_formats = [video(480), { ...audio, mime_type: 'audio/webm', bitrate: 256000 }, { ...audio, url: 'https://media.example/mp4' }]
assert.equal(selectExternalStreams(multilingual, 480, 'ru').externalStreams.audioUrl, 'https://media.example/mp4')
const deciphered = structuredClone(info)
deciphered.streaming_data.adaptive_formats[1].freeTubeUrl = 'https://media.example/deciphered'
assert.equal(selectExternalStreams(deciphered, 1080, 'ru').externalStreams.videoUrl, 'https://media.example/deciphered')

const source = await readFile('src/renderer/helpers/android/external-player.js', 'utf8')
const calls = []
let network = 'wifi'
let resolveInfo
const context = {
  store: { getters: { getWifiDefaultQuality: '1080', getMobileDefaultQuality: '480' } },
  i18n: { global: { t: key => key } },
  getLocalVideoInfo: () => new Promise(resolve => { resolveInfo = resolve }),
  getOriginalVideoLanguage: () => 'ru',
  getNetworkType: () => network,
  getDefaultQualityForNetwork,
  selectExternalStreams,
  openExternalPlayer: payload => { calls.push(payload); return 'relay' },
  showToast: (...args) => calls.push({ error: args[0] }),
  copyToClipboard() {},
  console: { warn() {} }
}
runInNewContext(source.replace(/^import .*\n/gm, '').replace('export async function', 'async function'), context)
const payload = { videoId: 'id', title: 'Video', startTime: 12, playlistId: 'list' }
for (const [type, expected] of [['wifi', 1080], ['mobile', 480], ['unknown', 720]]) {
  network = type
  const opened = context.openAndroidExternalPlayer(payload)
  assert.equal(calls.length, 0, 'must not launch before extraction completes')
  resolveInfo({ info, clientInfo: { visitorData: 'visitor', clientName: 1, clientVersion: 'version' } })
  assert.equal(await opened, 'relay')
  const selected = calls.pop()
  assert.equal(selected.externalStreams.videoHeight, expected)
  assert.equal(selected.maxQuality, expected)
  assert.equal(selected.title, payload.title)
  assert.equal(selected.startTime, payload.startTime)
  assert.equal(selected.playlistId, payload.playlistId)
  assert.equal(selected.pending, undefined)
  assert.equal(selected.externalHeaders['X-YouTube-Client-Name'], '1')
}
network = 'wifi'
context.store.getters.getWifiDefaultQuality = 'invalid'
const invalidQuality = context.openAndroidExternalPlayer(payload)
resolveInfo({ info })
await invalidQuality
assert.equal(calls.pop().maxQuality, 720)
const unavailable = context.openAndroidExternalPlayer(payload)
resolveInfo({ info: {} })
await unavailable
assert.match(calls.pop().error, /No playable video with audio/)
assert.equal(calls.length, 0, 'unresolved media must not launch')
context.getLocalVideoInfo = async () => { throw new Error('extraction failed') }
await context.openAndroidExternalPlayer(payload)
assert.match(calls.pop().error, /extraction failed/)
assert.deepEqual(payload, { videoId: 'id', title: 'Video', startTime: 12, playlistId: 'list' })
for (const [path, end] of [
  ['src/renderer/components/FtListVideo/FtListVideo.vue', '\nfunction parseVideoData()'],
  ['src/renderer/components/WatchVideoInfo/WatchVideoInfo.vue', '\nonMounted(() =>']
]) {
  const component = await readFile(path, 'utf8')
  const start = component.indexOf('async function handleExternalPlayer()')
  const handler = component.slice(start, component.indexOf(end, start))
  const launched = []
  const caller = {
    process: { env: { IS_ANDROID: true } },
    emit: () => {},
    openAndroidExternalPlayer: async value => launched.push({ android: true, ...value }),
    openExternalPlayer: value => launched.push({ android: false, ...value }),
    id: { value: 'id' },
    displayTitle: { value: 'Video' },
    playlistIdFinal: { value: 'list' },
    watchProgress: { value: 12 },
    defaultPlayback: { value: 1.5 },
    inUserPlaylist: { value: false },
    rememberHistory: { value: false },
    props: {
      id: 'id',
      title: 'Video',
      playlistId: 'list',
      playlistIndex: 2,
      playlistReverse: false,
      playlistShuffle: false,
      playlistLoop: false,
      getMediaUrl: () => null,
      getTimestamp: () => 12,
      getPlaylistState: () => ({ index: 2, reverse: false, shuffle: false, loop: false })
    }
  }
  runInNewContext(handler, caller)
  await caller.handleExternalPlayer()
  const android = launched.pop()
  assert.equal(android.android, true, path)
  assert.equal(android.videoId, 'id')
  assert.equal(android.title, 'Video')
  assert.equal(android.startTime, 12)
  caller.process.env.IS_ANDROID = false
  await caller.handleExternalPlayer()
  const electron = launched.pop()
  assert.equal(electron.android, false, path)
  assert.equal(electron.playbackRate, 1.5)
  assert.equal(electron.playlistId, 'list')
  assert.equal(electron.playlistIndex, 2)
}
console.log('external stream selection, ready launch and callers: PASS')
