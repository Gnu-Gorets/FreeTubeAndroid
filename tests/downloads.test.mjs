import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../src/renderer/helpers/android/downloads.js', import.meta.url), 'utf8')
  .replace(/^import \{ DEFAULT_DOWNLOAD_CONCURRENCY \} from .*$/m, 'const DEFAULT_DOWNLOAD_CONCURRENCY = 5')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  .replace(/const log = .*$/m, 'const log = (...args) => globalThis.downloadLogs?.push(args)')
  .replace(/const requestSaveDialog = .*$/m, 'const requestSaveDialog = () => {}')
  .replace(/const setupSabrScheme = .*$/m, 'const setupSabrScheme = () => {}')
const downloadServiceSource = fs.readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadService.kt', import.meta.url), 'utf8')
const mainActivitySource = fs.readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/MainActivity.kt', import.meta.url), 'utf8')
const androidBridgeSource = fs.readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', import.meta.url), 'utf8')
const downloadMetadataStoreSource = fs.readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadMetadataStore.kt', import.meta.url), 'utf8')
const watchSource = fs.readFileSync(new URL('../src/renderer/views/Watch/Watch.js', import.meta.url), 'utf8')
const watchViewSource = fs.readFileSync(new URL('../src/renderer/views/Watch/Watch.vue', import.meta.url), 'utf8')
const downloadsViewSource = fs.readFileSync(new URL('../src/renderer/views/Downloads/Downloads.vue', import.meta.url), 'utf8')
const watchVideoInfoSource = fs.readFileSync(new URL('../src/renderer/components/WatchVideoInfo/WatchVideoInfo.vue', import.meta.url), 'utf8')
const sabrSchemeSource = fs.readFileSync(new URL('../src/renderer/helpers/player/SabrSchemePlugin.js', import.meta.url), 'utf8')

const storage = new Map()
const downloadLogs = []
const context = vm.createContext({
  console,
  document: {},
  downloadLogs,
  localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value))
  },
  shaka: { offline: { Storage: true } },
  setupSabrScheme: () => {},
  android: {},
  process: { env: { IS_ANDROID: true } },
  setTimeout
})
vm.runInContext(source, context)

const { downloadProgressiveVideo, getDownloadFormats, getProgressSnapshot, getSabrDownloadFormats, mergeDownloadProgress, mergeNativeDownload, normalizeDownloadMetadata, preflightSabrDownload, readDownloadMetadata, recordDownloadMetadata, selectSabrDownloadTrack, selectSabrStorageTracks, storeSabrDownload, updateDownloadMetadata } = context

function sabrManifest(formats) {
  return `data:application/sabr+json,${encodeURIComponent(JSON.stringify({ formats }))}`
}

function sabrPlayer(track, streams = []) {
  return {
    getManifest: () => ({ variants: [{ video: streams[0], audio: streams[1] }] }),
    getVariantTracks: () => [track]
  }
}

test('SABR qualities deduplicate variants and use quality labels', () => {
  const manifest = `data:application/sabr+json,${encodeURIComponent(JSON.stringify({
    formats: [
      { mimeType: 'video/mp4', quality: 'hd1080', height: 960, width: 1920 },
      { mimeType: 'video/mp4', quality: 'hd1080', height: 960, width: 1920 },
      { mimeType: 'video/mp4', quality: 'hd720', height: 640, width: 1280 },
      { mimeType: 'video/webm', quality: 'hd2160', height: 2160, width: 3840 },
      { mimeType: 'audio/mp4', quality: 'AUDIO', height: null }
    ]
  }))}`
  assert.deepEqual(Array.from(getSabrDownloadFormats(manifest), format => format.label), ['1080p (SABR)', '720p (SABR)'])
})

test('download qualities filter invalid formats and sort highest first', () => {
  const formats = getDownloadFormats([
    { url: 'audio-as-video', mimeType: 'audio/mp4', height: 1080 },
    { url: 'video-360', mimeType: 'video/mp4', height: 360, bitrate: 1 },
    { url: 'video-720', mimeType: 'video/mp4', height: 720, bitrate: 1 },
    { url: '', mimeType: 'video/mp4', height: 144 }
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(formats.map(format => format.label))), ['720p', '360p'])
  assert.equal(formats.every(format => format.audio === null), true)
})

test('adaptive quality picker uses best audio and keeps video labels', () => {
  const formats = getDownloadFormats([
    { url: 'progressive', mimeType: 'video/mp4', height: 480 }
  ], [
    { url: 'audio-low', mimeType: 'audio/mp4', bitrate: 10 },
    { url: 'audio-high', mimeType: 'audio/mp4', bitrate: 20 },
    { url: 'video-720', mimeType: 'video/mp4', height: 720, bitrate: 100 }
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(formats.map(format => format.label))), ['720p (adaptive)', '480p'])
  assert.equal(formats[0].audio.url, 'audio-high')
})

test('adaptive formats share one best audio track', () => {
  const formats = getDownloadFormats([], [
    { url: 'audio-low', mimeType: 'audio/mp4', bitrate: 1 },
    { url: 'audio-high', mimeType: 'audio/mp4', bitrate: 2 },
    { url: 'video-720', mimeType: 'video/mp4', height: 720, bitrate: 3 }
  ])
  assert.equal(formats.length, 1)
  assert.equal(formats[0].audio.url, 'audio-high')
  assert.equal(formats[0].label, '720p (adaptive)')
})

test('SABR storage and size estimation select same highest-bandwidth track', () => {
  const low = { type: 'variant', height: 1080, bandwidth: 10, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4', originalVideoId: 'video-low', originalAudioId: 'audio' }
  const high = { type: 'variant', height: 1080, bandwidth: 20, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4', originalVideoId: 'video-high', originalAudioId: 'audio' }
  const tooLarge = { type: 'variant', height: 1440, bandwidth: 30, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4', originalVideoId: 'video-1440', originalAudioId: 'audio' }
  const text = { type: 'text', language: 'en' }
  assert.equal(selectSabrDownloadTrack([low, tooLarge, text, high], 1080), high)
  assert.equal(selectSabrDownloadTrack([low, tooLarge, text, high], 1440), tooLarge)
  assert.equal(selectSabrDownloadTrack([text], 1080), null)
})

test('SABR storage prefers MP4 audio for Android MP4 export', () => {
  const opus = { type: 'variant', height: 720, bandwidth: 30, videoMimeType: 'video/webm', audioMimeType: 'audio/webm' }
  const aac = { type: 'variant', height: 720, bandwidth: 20, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4' }
  assert.equal(selectSabrDownloadTrack([opus, aac], 720), aac)
  assert.equal(selectSabrDownloadTrack([opus], 720), null)
})

test('SABR storage uses nearest MP4 track above the requested height', () => {
  const medium = { type: 'variant', height: 480, bandwidth: 10, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4' }
  const high = { type: 'variant', height: 720, bandwidth: 20, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4' }
  assert.equal(selectSabrDownloadTrack([high, medium], 240), medium)
})

test('SABR storage callback rejects stale ids above selected height and never falls back to WebM', () => {
  const exact = { type: 'variant', height: 1080, bandwidth: 10, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4', originalVideoId: 'video-exact', originalAudioId: 'audio-exact' }
  const fallback = { type: 'variant', height: 720, bandwidth: 20, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4', originalVideoId: 'video-fallback', originalAudioId: 'audio-fallback' }
  const webm = { type: 'variant', height: 1080, bandwidth: 30, videoMimeType: 'video/webm', audioMimeType: 'audio/webm', originalVideoId: 'video-webm', originalAudioId: 'audio-webm' }
  assert.deepEqual(Array.from(selectSabrStorageTracks([fallback, exact], { videoTrackId: 'video-exact', audioTrackId: 'audio-exact', maxHeight: 720 })), [fallback])
  assert.deepEqual(Array.from(selectSabrStorageTracks([webm, fallback], { videoTrackId: 'video-webm', audioTrackId: 'audio-webm', maxHeight: 1080 })), [fallback])
  assert.throws(() => selectSabrStorageTracks([webm], { videoTrackId: 'video-webm', audioTrackId: 'audio-webm' }), /SABR download has no MP4 track/)
  assert.ok(source.includes('trackSelectionCallback: selectTracks'))
})

test('SABR store reuses one preflight selection and logs store timestamps', async () => {
  const fallback = { type: 'variant', height: 480, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4', originalVideoId: 'video-fallback', originalAudioId: 'audio-fallback' }
  const exact = { type: 'variant', height: 720, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4', originalVideoId: 'video-exact', originalAudioId: 'audio-exact' }
  let selected
  class Player {
    async load() {}
    getManifest() { return {} }
    getVariantTracks() { return [fallback, exact] }
    async destroy() {}
  }
  class Storage {
    configure(config) { this.offline = config.offline }
    store() {
      selected = this.offline.trackSelectionCallback([fallback, exact])[0]
      this.offline.progressCallback({ size: 63.9 }, 0.78)
      return { promise: Promise.resolve({ offlineUri: 'offline:test', size: 149.4 }) }
    }
    async destroy() {}
  }
  context.document.createElement = () => ({})
  context.shaka.Player = Player
  context.shaka.offline.Storage = Storage
  downloadLogs.length = 0
  let progress
  await storeSabrDownload({ downloadId: 'store-test', manifestSrc: 'manifest', manifestMimeType: 'mime', sabrData: {} }, (...args) => { progress = args }, {
    maxHeight: 480,
    videoTrackId: 'video-exact',
    audioTrackId: 'audio-exact',
    total: 149.4,
    totalExact: true
  })
  assert.equal(selected, fallback)
  assert.equal(progress.length, 4)
  assert.equal(Math.round(progress[1] * 100), 78)
  assert.equal(progress[2], 149.4)
  assert.equal(progress[3], true)
  assert.deepEqual(downloadLogs.filter(([message]) => message === 'SABR timestamp').map(([, detail]) => detail.event), [
    'slot-acquired',
    'player-created',
    'scheme-ready',
    'player-load-start',
    'player-load-complete',
    'offline-player-loaded',
    'storage-created',
    'store-started',
    'first-progress',
    'store-complete'
  ])
  assert.equal(downloadLogs.filter(([message]) => message === 'SABR timestamp').every(([, detail]) => Number.isFinite(detail.timestamp)), true)
  assert.equal(source.slice(source.indexOf('export async function storeSabrDownload'), source.indexOf('export async function recoverSabrDownload')).includes('estimateSabrSize('), false)
  assert.ok(source.includes('await player.load(manifestSrc, null, download.manifestMimeType)'))
})

test('Watch uses SABR for every download quality', () => {
  assert.ok(watchSource.includes('const options = getSabrDownloadFormats(this.manifestSrc)'))
  assert.equal(watchSource.includes('directOptions'), false)
  assert.equal(watchSource.includes('downloadSelected'), false)
})

test('Watch passes one complete SABR selection and logs its outer timestamps', () => {
  assert.ok(watchSource.includes('const selection = {'))
  for (const field of ['maxHeight', 'videoTrackId: preflight.videoId', 'audioTrackId: preflight.audioId', 'total: preflight.total', 'totalExact: preflight.totalExact']) assert.ok(watchSource.includes(field))
  assert.ok(watchSource.includes('}, selection)'))
  for (const event of ['quality-click', 'selection', 'preflight-complete', 'completed']) assert.ok(watchSource.includes(`logSabrTimestamp(downloadId, '${event}'`))
  assert.ok(watchSource.includes('qualityClickAt = Date.now()'))
  for (const event of ['player-created', 'scheme-ready', 'player-load-start', 'player-load-complete', 'storage-created']) assert.ok(source.includes(`'${event}'`))
  for (const event of ['sabr-request-start', 'sabr-response-headers', 'sabr-first-body', 'sabr-first-media-body']) assert.ok(sabrSchemeSource.includes(`'${event}'`))
})

test('SABR completes as offline-only download after storage', () => {
  const stored = watchSource.indexOf('content = await storeSabrDownload')
  const offlineUriChecked = watchSource.indexOf("if (!content?.offlineUri) throw new Error('Offline storage returned no URI')", stored)
  const completed = watchSource.indexOf("status: 'completed',\n          phase: 'completed'", offlineUriChecked)
  const completedLog = watchSource.indexOf("logSabrTimestamp(downloadId, 'completed'", completed)
  assert.ok(stored < offlineUriChecked && offlineUriChecked < completed && completed < completedLog)
  const completedBlock = watchSource.slice(completed, completedLog)
  for (const field of ['...finalSnapshot', 'offlineUri: content.offlineUri', 'speedBps: 0', 'error: null']) assert.ok(completedBlock.includes(field))
  assert.equal(watchSource.includes('exportSabrDownload'), false)
})

test('invalid SABR manifest returns no quality options', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(getSabrDownloadFormats('not-a-manifest'))), [])
  assert.deepEqual(JSON.parse(JSON.stringify(getSabrDownloadFormats('data:application/sabr+json,%7Bbad'))), [])
})

test('SABR manifest without MP4 audio returns no quality options', () => {
  const manifest = `data:application/sabr+json,${encodeURIComponent(JSON.stringify({ formats: [
    { mimeType: 'video/mp4', quality: 'hd720', height: 720 },
    { mimeType: 'audio/webm', quality: 'audio' }
  ] }))}`
  assert.deepEqual(JSON.parse(JSON.stringify(getSabrDownloadFormats(manifest))), [])
})

test('SABR quality labels deduplicate by quality and height', () => {
  const manifest = `data:application/sabr+json,${encodeURIComponent(JSON.stringify({ formats: [
    { mimeType: 'video/mp4', quality: 'hd720', height: 720 },
    { mimeType: 'video/mp4', quality: 'hd720', height: 640 },
    { mimeType: 'video/mp4', quality: 'large', height: 480 },
    { mimeType: 'audio/mp4', quality: 'audio', height: null }
  ] }))}`
  assert.deepEqual(Array.from(getSabrDownloadFormats(manifest), format => format.label), ['720p (SABR)', '480p (SABR)'])
})

test('SABR preflight uses exact source lengths matched by itag and lastModified', async () => {
  const track = {
    type: 'variant', height: 720, bandwidth: 1,
    videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4',
    originalVideoId: '137-111-video', originalAudioId: '140-333-en'
  }
  const result = await preflightSabrDownload(sabrPlayer(track), sabrManifest([
    { itag: 137, lastModified: '111', mimeType: 'video/mp4', height: 720, contentLength: '1000' },
    { itag: 140, lastModified: '222', mimeType: 'audio/mp4', contentLength: '200' },
    { itag: 140, lastModified: '333', mimeType: 'audio/mp4', contentLength: '300' }
  ]), 720)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    videoId: '137-111-video', audioId: '140-333-en', total: 1300, totalExact: true
  })
})

test('SABR preflight uses source format matching requested quality when player exposes only 1440p', async () => {
  const playerTrack = {
    type: 'variant', height: 1440, bandwidth: 1,
    videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4',
    originalVideoId: '400-444-video', originalAudioId: '140-999-audio'
  }
  const formats = [
    { itag: 400, lastModified: '444', mimeType: 'video/mp4', height: 1440, bitrate: 4, contentLength: '144000' },
    { itag: 397, lastModified: '480', mimeType: 'video/mp4', height: 480, bitrate: 3, contentLength: '48000' },
    { itag: 396, lastModified: '360', mimeType: 'video/mp4', height: 360, bitrate: 2, contentLength: '36000' },
    { itag: 140, lastModified: '999', mimeType: 'audio/mp4', bitrate: 1, contentLength: '1000' }
  ]
  const totals = await Promise.all([1440, 480, 360].map(async height => {
    const result = await preflightSabrDownload(sabrPlayer(playerTrack), sabrManifest(formats), height)
    return result.total
  }))
  assert.deepEqual(totals, [145000, 49000, 37000])
  assert.deepEqual(JSON.parse(JSON.stringify(await preflightSabrDownload(sabrPlayer(playerTrack), sabrManifest(formats), 360))), {
    videoId: '396-360-', audioId: '140-999-audio', total: 37000, totalExact: true
  })
})

test('SABR preflight marks segment fallback totals as inexact', async () => {
  const track = {
    type: 'variant', height: 720, bandwidth: 1,
    videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4',
    originalVideoId: '137-111-video', originalAudioId: '140-222-audio'
  }
  const stream = (originalId, initSize, start, end) => ({
    originalId,
    createSegmentIndex: async () => {},
    segmentIndex: {
      getNumReferences: () => 1,
      get: () => ({
        initSegmentReference: { getSize: () => initSize },
        getStartByte: () => start,
        getEndByte: () => end
      })
    }
  })
  const result = await preflightSabrDownload(sabrPlayer(track, [
    stream(track.originalVideoId, 10, 0, 99),
    stream(track.originalAudioId, 20, 0, 49)
  ]), sabrManifest([
    { itag: 137, lastModified: '111', contentLength: '1000' },
    { itag: 140, lastModified: '222', contentLength: '1.5' }
  ]), 720)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    videoId: track.originalVideoId, audioId: track.originalAudioId, total: 180, totalExact: false
  })
})

test('SABR preflight allows a zero inexact fallback total', async () => {
  const track = {
    type: 'variant', height: 720, bandwidth: 1,
    videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4',
    originalVideoId: '137-111-video', originalAudioId: '140-222-audio'
  }
  const result = await preflightSabrDownload(sabrPlayer(track), sabrManifest([
    { itag: 137, lastModified: '111', contentLength: 'Infinity' },
    { itag: 140, lastModified: '222', contentLength: '0' }
  ]), 720)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    videoId: track.originalVideoId, audioId: track.originalAudioId, total: 0, totalExact: false
  })
  assert.ok(watchSource.includes('preflightSabrDownload(this.$refs.player, this.manifestSrc, maxHeight)'))
  assert.ok(watchSource.includes('videoTrackId: preflight.videoId'))
  assert.ok(watchSource.includes('audioTrackId: preflight.audioId'))
})

test('download metadata preserves channel and playback details', () => {
  storage.delete('freetube-downloads')
  recordDownloadMetadata({
    downloadId: 'metadata',
    title: 'Title',
    channelName: 'Channel',
    channelThumbnail: 'avatar',
    published: 1700000000000,
    captions: [{ language: 'en' }],
    chapters: [{ title: 'Intro' }],
    status: 'downloading'
  })
  assert.deepEqual(JSON.parse(storage.get('freetube-downloads'))[0], {
    downloadId: 'metadata',
    title: 'Title',
    channelName: 'Channel',
    channelThumbnail: 'avatar',
    published: 1700000000000,
    captions: [{ language: 'en' }],
    chapters: [{ title: 'Intro' }],
    status: 'downloading'
  })
})

test('native metadata storage is authoritative and imports local legacy records', () => {
  const local = [{ downloadId: 'legacy', title: 'Legacy', status: 'completed' }]
  let native = '[]'
  context.android.getDownloadMetadata = () => native
  context.android.replaceDownloadMetadata = value => {
    native = value
    return true
  }
  try {
    storage.set('freetube-downloads', JSON.stringify(local))
    assert.equal(JSON.stringify(readDownloadMetadata()), JSON.stringify(local))
    const current = [{ downloadId: 'native', title: 'Native', status: 'completed' }]
    native = JSON.stringify(current)
    storage.set('freetube-downloads', JSON.stringify(local))
    assert.equal(JSON.stringify(readDownloadMetadata()), JSON.stringify(current))
  } finally {
    delete context.android.getDownloadMetadata
    delete context.android.replaceDownloadMetadata
    storage.delete('freetube-downloads')
  }
})

test('recording same downloadId upserts metadata instead of duplicating it', () => {
  storage.delete('freetube-downloads')
  recordDownloadMetadata({ downloadId: 'duplicate', title: 'Initial', status: 'queued' })
  recordDownloadMetadata({ downloadId: 'duplicate', title: 'Updated', status: 'downloading' })
  assert.deepEqual(JSON.parse(storage.get('freetube-downloads')), [{ downloadId: 'duplicate', title: 'Updated', status: 'downloading' }])
})

test('download records contain required identity and playback fields', () => {
  const sabrStart = watchSource.indexOf('recordDownloadMetadata({')
  const sabrEnd = watchSource.indexOf('let lastProgress', sabrStart)
  const sabrRecord = watchSource.slice(sabrStart, sabrEnd)
  const nativeStart = source.indexOf('const metadata = {')
  const nativeEnd = source.indexOf('const downloads = recordDownloadMetadata(metadata)', nativeStart)
  const nativeRecord = source.slice(nativeStart, nativeEnd)
  for (const field of ['downloadId', 'videoId', 'title', 'thumbnail', 'engine', 'status', 'createdAt']) {
    const fieldPattern = new RegExp(`\\b${field}(?:\\s*:|\\s*,)`)
    assert.match(sabrRecord, fieldPattern, `missing SABR field ${field}`)
    assert.match(nativeRecord, fieldPattern, `missing native field ${field}`)
  }
  assert.ok(sabrRecord.includes('manifestSrc:'))
  assert.ok(watchSource.includes('offlineUri: content.offlineUri'))
  assert.ok(nativeRecord.includes('localPath:'))
  assert.ok(source.includes('videoUrl: video.videoUrl'))
})

test('legacy download metadata gets stable playback fields', () => {
  const [legacy, current, malformed] = normalizeDownloadMetadata([
    { videoId: 'video-1', title: 'Legacy', localPath: 'data://legacy', createdAt: 42, status: 'completed' },
    { downloadId: 'current', videoId: 'video-2', engine: 'sabr', status: 'downloading' },
    null
  ])
  assert.equal(legacy.downloadId, 'legacy-video-1-42')
  assert.equal(legacy.engine, 'native')
  assert.equal(legacy.thumbnail, '')
  assert.equal(current.downloadId, 'current')
  assert.equal(current.engine, 'sabr')
  assert.equal(malformed, null)
})

test('download progress handles missing totals and clamps SABR snapshots', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(mergeDownloadProgress({ downloadId: 'one' }, {
    status: 'downloading', received: 5, total: 0, speedBps: 0
  }))), {
    downloadId: 'one', status: 'downloading', progress: null, received: 5, total: 0, totalExact: false, fileSize: 0, speedBps: 0, error: null
  })
  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 100 }, 2, 101, true))), {
    received: 100, total: 100, totalExact: true, progress: 1
  })
})

test('download events preserve completed SABR metadata', () => {
  const result = mergeDownloadProgress({ downloadId: 'one', title: 'Title' }, {
    status: 'completed', progress: 1, received: 100, total: 101, totalExact: true,
    offlineUri: 'offline:test', localPath: 'content://test', fileName: 'test.mp4', fileSize: 99, completedAt: 123
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    downloadId: 'one', title: 'Title', status: 'completed', progress: 1, received: 100, total: 100, totalExact: true,
    offlineUri: 'offline:test', localPath: 'content://test', fileName: 'test.mp4', fileSize: 99, completedAt: 123, error: null
  })
})

test('fallback save dialog requests final mp4 name', () => {
  assert.ok(source.includes("requestSaveDialog(fileName, 'video/mp4')"))
  assert.ok(!source.includes('requestSaveDialog(`${fileName}.part`'))
})

test('quality picker keeps multiple options and dispatches selected format', () => {
  assert.ok(watchSource.includes('if (options.length > 1)'))
  assert.ok(watchSource.includes('this.downloadOptions = options'))
  assert.ok(watchSource.includes('handleDownloadQuality(formats)'))
  assert.ok(watchSource.includes('this.downloadOptions = []'))
  assert.ok(watchSource.includes('this.downloadSabr(formats?.height, formats?.label, qualityClickAt)'))
})

test('Watch Download falls back to native MP4 when SABR has no options', () => {
  const start = watchSource.indexOf('async downloadVideo()')
  const end = watchSource.indexOf('getDownloadMetadata() {', start)
  const flow = watchSource.slice(start, end)
  assert.ok(flow.includes('getDownloadFormats([], this.downloadFormats)[0]'))
  assert.ok(flow.includes('return downloadProgressiveVideo({'))
  assert.ok(flow.includes('videoUrl: video.url'))
  assert.ok(flow.includes('audioUrl: audio?.url'))
})

test('Watch Download button routes through SABR download flow', () => {
  const start = watchSource.indexOf('async downloadVideo()')
  const end = watchSource.indexOf('getDownloadMetadata() {', start)
  assert.ok(start >= 0 && end > start)
  const downloadButtonFlow = watchSource.slice(start, end)
  assert.ok(downloadButtonFlow.includes('getSabrDownloadFormats(this.manifestSrc)'))
  assert.ok(downloadButtonFlow.includes('return this.downloadSabr(formats.height, formats.label, qualityClickAt)'))
})

test('download metadata uses only SABR and native engines', () => {
  assert.ok(watchSource.includes("engine: 'sabr'"))
  assert.ok(source.includes("engine: 'native'"))
  assert.equal((watchSource.match(/engine:\s*'/g) || []).length, 1)
  assert.equal((source.match(/engine:\s*'/g) || []).length, 1)
})

test('download contract separates status from processing phase', () => {
  const allSources = `${source}\n${watchSource}\n${downloadsViewSource}\n${downloadServiceSource}`
  for (const status of ['queued', 'downloading', 'paused', 'completed', 'failed', 'canceled']) {
    assert.match(allSources, new RegExp(`status[^\\n]*(?:'${status}'|"${status}")`), `missing status ${status}`)
  }
  assert.ok(downloadServiceSource.includes('put("phase", "processing")'))
  assert.equal(downloadServiceSource.includes('put("status", "processing")'), false)
})

test('native queue overlays metadata by downloadId only', () => {
  assert.ok(downloadsViewSource.includes('queue.find(item => item.id === download.downloadId)'))
  assert.equal(downloadsViewSource.includes('queue.find(item => item.videoId === download.videoId)'), false)
})

test('download events persist merged UI state atomically', () => {
  const start = downloadsViewSource.indexOf('function handleDownloadEvent(event)')
  const end = downloadsViewSource.indexOf('\nonMounted(() =>', start)
  const handler = downloadsViewSource.slice(start, end)
  const merged = handler.indexOf('Object.assign(download, mergeDownloadProgress(download, changes, native))')
  const persisted = handler.indexOf('writeDownloadMetadata(downloads.value)', merged)
  assert.ok(merged >= 0)
  assert.ok(persisted > merged)
})

test('Downloads view exposes Play selected for ordered completed records', () => {
  assert.ok(downloadsViewSource.includes('data-download-action="play-selected"'))
  assert.ok(downloadsViewSource.includes('selectedCompletedDownloads.length > 1'))
  assert.ok(downloadsViewSource.includes('getPlayableDownloadRecords'))
  assert.ok(downloadsViewSource.includes('getLocalPlaybackUrl'))
  assert.ok(downloadsViewSource.includes('createDownloadedPlaylistRoute(selected.map(download => download.downloadId))'))
  assert.ok(downloadsViewSource.includes("t('Downloads.Play selected')"))
})

test('Watch offline playlist resolves downloads in route order', () => {
  const start = watchSource.indexOf('getOfflinePlaylistDownloads: function ()')
  const end = watchSource.indexOf('\n    navigateOfflinePlaylist:', start)
  const method = watchSource.slice(start, end)
  assert.match(method, /return ids[\s\S]*?\.map\(id => stored\.find\(download => download\?\.downloadId === id/)
  assert.match(method, /\.filter\(download => download && getPlaybackSource\(download/)
  assert.ok(watchSource.includes('const index = downloads.findIndex(download => download.downloadId === currentId)'))
  assert.ok(watchSource.includes('const target = downloads[index + direction]'))
})

test('Watch offline playlist skips deleted records and stops at boundaries', () => {
  const playlistStart = watchSource.indexOf('getOfflinePlaylistDownloads: function ()')
  const playlistEnd = watchSource.indexOf('\n    navigateOfflinePlaylist:', playlistStart)
  const playlist = watchSource.slice(playlistStart, playlistEnd)
  assert.match(playlist, /\.map\(id => stored\.find\(download => download\?\.downloadId === id && download\.status === 'completed'\)/)
  assert.match(playlist, /\.filter\(download => download && getPlaybackSource\(download/)

  const navigationStart = watchSource.indexOf('navigateOfflinePlaylist: function')
  const navigationEnd = watchSource.indexOf('\n    setViewingModeOnFirstLoad:', navigationStart)
  const navigation = watchSource.slice(navigationStart, navigationEnd)
  assert.ok(navigation.includes('const target = downloads[index + direction]'))
  assert.ok(navigation.includes('if (!target) return'))
})

test('Downloads playlist action reports missing local sources', () => {
  assert.ok(downloadsViewSource.includes("showToast(t('Downloads.Player source unavailable'))"))
  assert.ok(downloadsViewSource.includes('selected.length !== selectedIds.length'))
  assert.ok(downloadsViewSource.includes('selectedCompletedDownloads'))
})

test('Downloads view exposes cancel, retry, play and delete flows', () => {
  for (const action of ["control(download, 'cancel')", "control(download, 'pause')", "control(download, 'resume')", "control(download, 'retry')"]) assert.ok(downloadsViewSource.includes(action))
  assert.ok(downloadsViewSource.includes("download.status === 'completed'"))
  assert.ok(downloadsViewSource.includes('awaitAsyncResult(android.deleteDownloadFile(download.localPath))'))
  assert.ok(downloadsViewSource.includes('window.Android?.fileExists'))
  assert.ok(downloadsViewSource.includes("window.addEventListener('app-resume', load)"))
  assert.ok(downloadsViewSource.includes('stored.find(item => item.offlineUri === download.offlineUri)'))
  assert.ok(downloadsViewSource.includes('downloads.value = downloads.value.filter'))
})

test('Downloads allows immediate offline-only deletion', () => {
  const load = downloadsViewSource.slice(downloadsViewSource.indexOf('function load()'), downloadsViewSource.indexOf('async function retry('))
  assert.ok(load.includes("download.status === 'downloading'"))
  assert.ok(downloadsViewSource.includes('v-if="selectableDownloads.length > 0"'))
  assert.ok(downloadsViewSource.includes('v-if="playableDownloadIds.has(download.downloadId)"'))
  assert.ok(downloadsViewSource.includes('stored.find(item => item.offlineUri === download.offlineUri)'))
})

test('debug Downloads hook targets records and inspects offline storage', () => {
  assert.ok(downloadsViewSource.includes('function installTestHook()'))
  assert.ok(downloadsViewSource.includes('window.Android?.isDebugBuild?.()'))
  assert.ok(downloadsViewSource.includes('downloads.value.find(item => item.downloadId === id)'))
  assert.ok(downloadsViewSource.includes('active: id => hasSabrDownload(id)'))
  assert.ok(downloadsViewSource.includes('(await storage.list()).map(content => content.offlineUri).sort()'))
  assert.ok(downloadsViewSource.includes('delete window.__ftTest'))
})

test('WebView debugging is enabled only in debug builds', () => {
  const mainActivitySource = fs.readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/MainActivity.kt', import.meta.url), 'utf8')
  assert.ok(mainActivitySource.includes('WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)'))
  assert.ok(androidBridgeSource.includes('fun isDebugBuild(): Boolean = BuildConfig.DEBUG'))
})

test('public downloads use MediaStore Downloads collection', () => {
  assert.ok(androidBridgeSource.includes('MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)'))
  assert.ok(!androidBridgeSource.includes('MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)'))
})

test('native bridge deletes and checks MediaStore downloads with ContentResolver', () => {
  assert.ok(androidBridgeSource.includes('activity.contentResolver.delete(resolvedUri, null, null) > 0'))
  assert.ok(androidBridgeSource.includes('fun deleteDownloadFile(uri: String): String = asyncFileOperation'))
  assert.ok(androidBridgeSource.includes('fun fileExists(uri: String): Boolean'))
  assert.ok(androidBridgeSource.includes('activity.contentResolver.query(resolvedUri'))
})

test('native finalization separates MediaStore publish from SAF targets', () => {
  assert.match(downloadServiceSource, /Uri\.parse\(uri\)\.authority == MediaStore\.AUTHORITY/)
  assert.ok(downloadServiceSource.includes('!targetExists(item.optString("targetUri"))'))
  assert.match(downloadServiceSource, /Unable to rename download target/)
  assert.ok(downloadServiceSource.includes('MediaStore.MediaColumns.DISPLAY_NAME'))
  assert.ok(downloadServiceSource.includes('item.put("targetUri", rename('))
})

test('native adaptive progress aggregates video and audio bytes', () => {
  assert.ok(downloadServiceSource.includes('val aggregateReceived = completedBytes + received'))
  assert.ok(downloadServiceSource.includes('videoTotal + audioTotal'))
  assert.ok(!downloadServiceSource.includes('0.0, 0.5'))
  assert.ok(!downloadServiceSource.includes('0.5, 0.5'))
})

test('direct download queues honest initial totals, including unknown sizes', async () => {
  async function queue(video) {
    let item
    Object.assign(context.android, {
      createDownloadFile: () => 'content://download',
      enqueueNativeDownload: json => { item = JSON.parse(json); return false }
    })
    storage.delete('freetube-downloads')
    await assert.rejects(downloadProgressiveVideo({ id: 'id', title: 'Title', videoUrl: 'https://video', ...video }), /Unable to queue download/)
    return { item, metadata: JSON.parse(storage.get('freetube-downloads'))[0] }
  }

  const unknown = await queue({ videoTotal: 0 })
  assert.deepEqual(unknown.item, {
    id: unknown.metadata.downloadId,
    downloadId: unknown.metadata.downloadId,
    videoId: 'id',
    title: 'Title',
    thumbnail: '',
    selectedFormat: 'progressive',
    engine: 'native',
    sourceBackend: 'unknown',
    videoUrl: 'https://video',
    audioUrl: '',
    videoTotal: 0,
    audioTotal: 0,
    total: 0,
    totalExact: false,
    durationMs: 0,
    targetUri: 'content://download',
    sourceLocator: 'content://download',
    finalName: 'Title.mp4'
  })
  assert.deepEqual({ received: unknown.metadata.received, total: unknown.metadata.total, totalExact: unknown.metadata.totalExact, progress: unknown.metadata.progress }, {
    received: 0, total: 0, totalExact: false, progress: null
  })

  const partialAdaptive = await queue({ audioUrl: 'https://audio', videoTotal: 100, audioTotal: 0, total: 999 })
  assert.deepEqual({ videoTotal: partialAdaptive.item.videoTotal, audioTotal: partialAdaptive.item.audioTotal, total: partialAdaptive.item.total, totalExact: partialAdaptive.item.totalExact }, {
    videoTotal: 100, audioTotal: 0, total: 0, totalExact: false
  })

  const knownAdaptive = await queue({ audioUrl: 'https://audio', videoTotal: 100, audioTotal: 25 })
  assert.deepEqual({ total: knownAdaptive.metadata.total, totalExact: knownAdaptive.metadata.totalExact, progress: knownAdaptive.metadata.progress }, {
    total: 125, totalExact: true, progress: null
  })
})

test('native target deletion handles data MediaStore and SAF URIs', () => {
  assert.ok(androidBridgeSource.includes('if (uri.startsWith("data://")) java.io.File(dataDirectory, uri.removePrefix("data://")).delete()'))
  assert.ok(androidBridgeSource.includes('resolvedUri.authority == MediaStore.AUTHORITY'))
  assert.ok(androidBridgeSource.includes('DocumentFile.fromSingleUri(activity, resolvedUri)?.delete() == true'))
  assert.ok(androidBridgeSource.includes('fun deleteDownloadFile(uri: String): String = asyncFileOperation'))
  assert.ok(androidBridgeSource.includes('fun fileExists(uri: String): Boolean'))
})

test('native queue recovers queued and downloading items after app restart', () => {
  assert.ok(downloadServiceSource.includes('items.getJSONObject(it).optString("status") == "queued"'))
  assert.ok(downloadServiceSource.includes('items.getJSONObject(it).optString("status") == "downloading"'))
  assert.ok(downloadServiceSource.includes('item.optString("status") == "downloading" || item.optString("status") == "processing"'))
  assert.ok(downloadServiceSource.includes('item.put("status", "queued").put("phase", "queued")'))
  assert.ok(downloadServiceSource.includes('return START_STICKY'))
  assert.ok(mainActivitySource.includes('DownloadService.resumeIfNeeded(this)'))
})

test('native retry uses bounded retryable error policy', () => {
  assert.ok(downloadServiceSource.includes('ACTION_RETRY -> retry(intent.getStringExtra(EXTRA_ID))'))
  assert.ok(downloadServiceSource.includes('private fun isAllowedTransition(from: String, to: String)'))
  assert.ok(downloadServiceSource.includes('private const val MAX_RETRIES = 4'))
  assert.ok(downloadServiceSource.includes('withRetries { downloadSingleFile'))
  assert.ok(downloadServiceSource.includes('withRetries { downloadToFile'))
  assert.ok(downloadServiceSource.includes('is IOException -> true'))
  assert.ok(downloadServiceSource.includes('HTTP (408|429|5\\\\d{2})'))
  assert.ok(downloadServiceSource.includes('attempt++ >= MAX_RETRIES'))
})

test('native cancel disconnects and deletes target', () => {
  assert.ok(downloadServiceSource.includes('ACTION_CANCEL -> cancel(intent.getStringExtra(EXTRA_ID))'))
  assert.ok(downloadServiceSource.includes('connections[id]?.disconnect()'))
  assert.ok(downloadServiceSource.includes('item.put("status", "canceled").put("phase", "canceled")'))
  assert.ok(downloadServiceSource.includes('delete(item.optString("targetUri"))'))
  assert.ok(downloadServiceSource.includes('currentState == "paused" || currentState == "canceled"'))
})

test('native pause and resume transition queue state', () => {
  assert.ok(downloadServiceSource.includes('ACTION_PAUSE -> update(intent.getStringExtra(EXTRA_ID), "paused")'))
  assert.ok(downloadServiceSource.includes('ACTION_RESUME -> update(intent.getStringExtra(EXTRA_ID), "queued")'))
  assert.ok(downloadServiceSource.includes('private fun retry(id: String?)'))
  assert.ok(downloadServiceSource.includes('if (status == "paused") {'))
  assert.ok(downloadServiceSource.includes('cancelFfmpeg(id)'))
  assert.ok(downloadServiceSource.includes('item.optString("status") == "queued" && activeDownloads.add(id)'))
})

test('native completion verifies, renames and publishes target', () => {
  const completionStart = downloadServiceSource.indexOf('download(item)')
  const completionEnd = downloadServiceSource.indexOf('private fun targetFile', completionStart)
  const completion = downloadServiceSource.slice(completionStart, completionEnd)
  assert.ok(completion.includes('verifyCompletedTarget(item)'))
  assert.ok(completion.includes('item.put("status", "completed")'))
  assert.ok(completion.includes('rename(item.optString("targetUri"), item.optString("finalName"))'))
  assert.ok(completion.includes('publish(item.optString("targetUri"))'))
  assert.ok(completion.includes('item.put("fileSize", length(Uri.parse(item.optString("targetUri"))))'))
})

test('native download validates all remote source URLs', () => {
  assert.ok(downloadServiceSource.includes('require(url.startsWith("https://")) { "Invalid download URL" }'))
  assert.ok(downloadServiceSource.includes('require(audioUrl.startsWith("https://")) { "Invalid audio download URL" }'))
})

test('native adaptive download exposes processing mux lifecycle', () => {
  assert.ok(downloadServiceSource.includes('item.put("phase", "processing")'))
  assert.ok(downloadServiceSource.includes('notify(item.optString("id"), item.optString("title"), "Processing"'))
  assert.ok(downloadServiceSource.includes('muxMp4(item, videoFile, audioFile, outputFile)'))
  assert.ok(downloadServiceSource.includes('statistics.time / durationMs.toDouble()'))
  assert.ok(downloadServiceSource.includes('Processing ${"%.0f".format(progress * 100)}%'))
  assert.ok(downloadServiceSource.includes('FFmpegKit.executeAsync'))
  assert.ok(downloadServiceSource.includes('FFmpegKit::cancel'))
  assert.ok(downloadServiceSource.includes('outputFile.inputStream().use { input -> input.copyTo(stream) }'))
  assert.ok(downloadServiceSource.includes('FFmpegKit.executeAsync'))
  assert.ok(downloadServiceSource.includes('ReturnCode.isSuccess(finished.returnCode)'))
  assert.ok(downloadServiceSource.includes('-map 0:v:0 -map 1:a:0 -c copy'))
})

test('native download loop publishes progress telemetry', () => {
  assert.ok(downloadServiceSource.includes('item.put("progress", progress'))
  assert.ok(downloadServiceSource.includes('.put("received", received)'))
  assert.ok(downloadServiceSource.includes('.put("speedBps", speed)'))
  assert.ok(downloadServiceSource.includes('saveItem(item)'))
  assert.ok(downloadServiceSource.includes('notify(item.optString("id"), item.optString("title")'))
})

test('native queue starts queued items within concurrency limit', () => {
  assert.ok(downloadServiceSource.includes('item.put("status", "queued")'))
  assert.ok(downloadServiceSource.includes('item.optString("status") == "queued" && activeDownloads.add(id)'))
  assert.ok(downloadServiceSource.includes('item.put("status", "downloading")'))
  assert.ok(downloadServiceSource.includes('prefs().getInt("maxConcurrent", 5).coerceIn(1, 5)'))
})

test('native GET totals stay explicit across Kotlin and renderer boundaries', () => {
  const mainActivitySource = fs.readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/MainActivity.kt', import.meta.url), 'utf8')
  assert.match(downloadServiceSource, /val total = if \(request\.contentLengthLong > 0\) receivedStart \+ request\.contentLengthLong else 0L/)
  assert.match(downloadServiceSource, /item\.put\("total", total\)\s+\.put\("totalExact", total > 0\)[\s\S]{0,300}saveItem\(item\)/)
  assert.ok(downloadServiceSource.includes('phase == "audio" && componentTotal > 0 -> completedBytes + componentTotal'))
  assert.ok(downloadServiceSource.includes('val aggregateStart = completedBytes + receivedStart'))
  assert.equal(downloadServiceSource.includes('else if (phase == "video")'), false)
  assert.ok(downloadServiceSource.includes('progress ?: JSONObject.NULL'))
  assert.ok(downloadServiceSource.includes('builder.setProgress(0, 0, true)'))
  assert.ok(downloadServiceSource.includes('.putExtra("totalExact", item.optBoolean("totalExact", false))'))
  assert.ok(mainActivitySource.includes('put("totalExact", intent.getBooleanExtra("totalExact", false))'))

  const inexact = mergeNativeDownload({}, { status: 'downloading', received: 40, total: 100, totalExact: false })
  assert.equal(inexact.totalExact, false)
})

test('download metadata has native persistent storage contract', () => {
  assert.ok(downloadMetadataStoreSource.includes('SQLiteOpenHelper'))
  assert.ok(downloadMetadataStoreSource.includes('CREATE TABLE $TABLE'))
  assert.ok(downloadMetadataStoreSource.includes('private const val DATABASE_VERSION = 2'))
  assert.ok(downloadMetadataStoreSource.includes('ALTER TABLE $TABLE ADD COLUMN $SCHEMA'))
  assert.ok(downloadMetadataStoreSource.includes('private const val METADATA_SCHEMA_VERSION = 1'))
  assert.ok(downloadMetadataStoreSource.includes('private fun normalize(input: JSONObject, fallbackId: String)'))
  for (const field of ['downloadId', 'videoId', 'selectedFormat', 'engine', 'status', 'phase', 'sourceLocator', 'progress', 'error', 'createdAt', 'updatedAt']) {
    assert.ok(downloadMetadataStoreSource.includes(`put("${field}"`), `missing metadata field: ${field}`)
  }
  assert.ok(downloadMetadataStoreSource.includes('runCatching {'))
  assert.ok(downloadMetadataStoreSource.includes('fun replace(serialized: String): Boolean'))
  assert.ok(androidBridgeSource.includes('fun getDownloadMetadata(): String'))
  assert.ok(androidBridgeSource.includes('fun replaceDownloadMetadata(value: String): Boolean'))
  assert.ok(androidBridgeSource.includes('fun deleteDownloadMetadata(downloadId: String): Boolean'))
})

test('native queue receives metadata required for recovery', () => {
  for (const field of ['downloadId', 'videoId', 'thumbnail', 'selectedFormat', 'engine', 'sourceBackend', 'sourceLocator']) {
    assert.ok(source.includes(`${field},`) || source.includes(`${field}:`), `missing renderer metadata field: ${field}`)
  }
})

test('native downloads use canonical statuses and exact final file size', () => {
  assert.ok(androidBridgeSource.includes('fun getFileSize(uri: String): Long'))
  assert.ok(downloadServiceSource.includes('ACTION_STATE'))
  assert.ok(downloadServiceSource.includes('putExtra("status"'))
  assert.ok(downloadServiceSource.includes('item.put("fileSize", length('))
  assert.ok(source.includes('preflightSabrDownload'))
  assert.ok(watchSource.includes('total: preflight.total'))
  assert.equal(watchSource.includes('exportSabrDownload'), false)
})

test('stale active native queue entries become removable failed records', () => {
  assert.ok(downloadsViewSource.includes("['queued', 'downloading', 'paused'].includes(item.status) && !knownIds.has(item.id)"))
  assert.ok(downloadsViewSource.includes("error: 'Download metadata is missing'"))
  assert.ok(downloadsViewSource.includes('staleNative: true'))
  assert.ok(downloadsViewSource.includes("download.status === 'failed' && !download.staleNative"))
  assert.ok(downloadsViewSource.includes("|| download.staleNative"))
})

test('completed downloads require an existing local file target', () => {
  const start = downloadsViewSource.indexOf('function load()')
  const end = downloadsViewSource.indexOf('async function retry(', start)
  const load = downloadsViewSource.slice(start, end)
  assert.ok(load.includes("download.status === 'completed' && download.localPath"))
  assert.ok(load.includes('window.Android?.fileExists'))
  assert.ok(load.includes('!window.Android.fileExists(download.localPath)'))
  assert.ok(load.includes('return []'))
})

test('Downloads view supports filtered bulk selection and stale selection cleanup', () => {
  assert.ok(downloadsViewSource.includes('const selectableDownloads = computed(() => filteredDownloads.value)'))
  assert.ok(downloadsViewSource.includes('items.length > 0 && items.every(download => selected.has(download.downloadId))'))
  assert.ok(downloadsViewSource.includes('selectedDownloadIds.value = new Set([...selectedDownloadIds.value].filter(id => downloadIds.has(id)))'))
  assert.ok(downloadsViewSource.includes('items.forEach(download => selected.delete(download.downloadId))'))
  assert.ok(downloadsViewSource.includes('items.forEach(download => selected.add(download.downloadId))'))
})

test('Downloads skips malformed metadata records without hiding valid records', () => {
  assert.ok(downloadsViewSource.includes("if (!download || typeof download !== 'object' || Array.isArray(download) || !download.downloadId)"))
  assert.ok(downloadsViewSource.includes("console.warn('[Downloads] skipping invalid metadata record')"))
})

test('Downloads selection and rendering use stable download ids', () => {
  assert.ok(downloadsViewSource.includes(':key="download"'))
  assert.ok(downloadsViewSource.includes(':checked="selectedDownloadIds.has(download.downloadId)"'))
  assert.ok(downloadsViewSource.includes('selectedDownloadIds.value.has(download.downloadId)'))
  assert.ok(downloadsViewSource.includes('downloads.value.filter(download => !deleted.has(download.downloadId))'))
})

test('Downloads selection controls handle empty and selected states', () => {
  assert.ok(downloadsViewSource.includes('v-if="selectableDownloads.length > 0"'))
  assert.equal(downloadsViewSource.includes(':disabled="selectableDownloads.length === 0"'), false)
  assert.ok(downloadsViewSource.includes("t('Downloads.Clear selection')"))
  assert.ok(downloadsViewSource.includes('items.length > 0 && items.every(download => selectedDownloadIds.value.has(download.downloadId))'))
})

test('Downloads thumbnails have a fallback and mobile list clears bottom navigation', () => {
  assert.ok(downloadsViewSource.includes(':src="download.thumbnail || thumbnailPlaceholder"'))
  assert.ok(downloadsViewSource.includes('@error="handleThumbnailError"'))
  assert.ok(downloadsViewSource.includes("event.target.src = thumbnailPlaceholder"))
  assert.ok(downloadsViewSource.includes('.downloadsView::after'))
  assert.ok(downloadsViewSource.includes('block-size: 60px;'))
})

test('Downloads action hover is limited to hover-capable devices', () => {
  assert.ok(downloadsViewSource.includes('@media (hover: hover)'))
  assert.ok(downloadsViewSource.includes('color: var(--text-with-main-color);\n    background: var(--primary-color-hover);'))
})

test('download metadata is removed only after storage deletion succeeds', () => {
  const start = downloadsViewSource.indexOf('async function removeMany(')
  const end = downloadsViewSource.indexOf('async function remove(download)', start)
  const removeMany = downloadsViewSource.slice(start, end)
  const storageDelete = removeMany.indexOf('await storage.remove(content.offlineUri)')
  const result = removeMany.indexOf('results.push({ download, ok: true })', storageDelete)
  const metadataFilter = removeMany.indexOf('downloads.value = downloads.value.filter', result)
  assert.ok(storageDelete >= 0)
  assert.ok(result > storageDelete)
  assert.ok(metadataFilter > result)
  assert.ok(removeMany.includes('results.filter(result => result.ok)'))
})

test('Downloads search keeps bulk delete scoped to selected ids', () => {
  assert.ok(downloadsViewSource.includes("import { filterDownloads } from '../../helpers/android/download-search.mjs'"))
  assert.ok(downloadsViewSource.includes('const filteredDownloads = computed(() => filterDownloads(downloads.value, searchQuery.value))'))
  assert.ok(downloadsViewSource.includes('async function removeMany(items = downloads.value.filter(download => selectedDownloadIds.value.has(download.downloadId)))'))
  assert.ok(downloadsViewSource.includes('selectedDownloadIds.value.has(download.downloadId)'))
  assert.ok(downloadsViewSource.includes('const selectedIds = filteredDownloads.value.filter(download => selectedDownloadIds.value.has(download.downloadId))'))
})

test('Downloads view supports fast bulk selection and deletion', () => {
  assert.ok(downloadsViewSource.includes('selectedDownloadIds'))
  assert.ok(downloadsViewSource.includes('data-download-action="select-all"'))
  assert.ok(downloadsViewSource.includes('data-download-action="delete-selected"'))
  assert.ok(downloadsViewSource.includes('@click="removeMany()"'))
  assert.ok(downloadsViewSource.includes('for (const download of items)') && downloadsViewSource.includes('await storage.remove'))
  assert.ok(downloadsViewSource.includes('stored.find(item => item.offlineUri === download.offlineUri)'))
})

test('native queue progress replaces stale UI progress fields', () => {
  const result = mergeNativeDownload({ downloadId: 'one', progress: 0.1, received: 10, speedBps: 1 }, {
    status: 'downloading', progress: 0.4, received: 40, total: 100, totalExact: true, speedBps: 30, etaSeconds: 2, error: null
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    downloadId: 'one', status: 'downloading', progress: 0.4, received: 40, total: 100, fileSize: 0, totalExact: true, speedBps: 30, etaSeconds: 2, error: null
  })
})

test('native queue state overlays playback target and terminal error', () => {
  const result = mergeNativeDownload({ downloadId: 'one', status: 'downloading', localPath: 'old://target' }, {
    status: 'failed', targetUri: 'new://target', received: 10, total: 20, totalExact: true, error: 'network', fileSize: 10, phase: 'failed', speedBps: 0, etaSeconds: 0
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.localPath, 'new://target')
  assert.equal(result.error, 'network')
  assert.equal(result.phase, 'failed')
  assert.equal(result.fileSize, 10)
})

test('selected offline source has no network metadata request', () => {
  const localStart = watchSource.indexOf('loadOfflineDownload: function')
  const localFlow = watchSource.slice(localStart, watchSource.indexOf('setViewingModeOnFirstLoad', localStart))
  assert.ok(localFlow.includes('if (!download) return false'))
  assert.ok(localFlow.includes('this.offlinePlayback = true'))
  assert.ok(localFlow.includes('return true'))
  const selectionStart = watchSource.indexOf('enableDownloadedFormat: function')
  const selectionFlow = watchSource.slice(selectionStart, watchSource.indexOf('enableOnlineFormat', selectionStart))
  assert.equal(selectionFlow.includes('getVideoInformation'), false)
})

test('offline playlist Watch navigation stays local and ordered', () => {
  assert.ok(watchSource.includes("const playlist = String(this.$route.query.offlinePlaylist || '').split(',').filter(Boolean)"))
  assert.ok(watchSource.includes('getOfflinePlaylistDownloads: function ()'))
  assert.ok(watchSource.includes('this.$router.push({'))
  assert.ok(watchSource.includes('query: { ...this.$route.query, offline: target.downloadId }'))
  assert.ok(watchSource.includes('this.navigateOfflinePlaylist(1)'))
  assert.ok(watchSource.includes('this.navigateOfflinePlaylist(-1)'))
})

test('offline playlist next and previous keep local route state', () => {
  const start = watchSource.indexOf('navigateOfflinePlaylist: function')
  const end = watchSource.indexOf('\n    setViewingModeOnFirstLoad:', start)
  const navigation = watchSource.slice(start, end)
  assert.ok(navigation.includes('const target = downloads[index + direction]'))
  assert.ok(navigation.includes('path: `/watch/${target.videoId}`'))
  assert.ok(navigation.includes('query: { ...this.$route.query, offline: target.downloadId }'))

  const skipStart = watchSource.indexOf('handleSkipToNext: function')
  const skipEnd = watchSource.indexOf('\n    abortAutoplayCountdown:', skipStart)
  const skip = watchSource.slice(skipStart, skipEnd)
  assert.ok(skip.includes('this.navigateOfflinePlaylist(1)'))
  assert.ok(skip.includes('handleSkipToPrev: function'))
  assert.ok(skip.includes('this.navigateOfflinePlaylist(-1)'))
})

test('offline playlist does not fall back to online information', () => {
  const reloadStart = watchSource.indexOf('async reloadView()')
  const reloadEnd = watchSource.indexOf('resetVideoState:', reloadStart)
  const reload = watchSource.slice(reloadStart, reloadEnd)
  assert.ok(reload.includes('this.$route.query.offline || this.$route.query.offlinePlaylist'))
  assert.ok(reload.includes("this.errorMessage = this.$t('Downloads.Player source unavailable')"))
  assert.ok(reload.indexOf('loadOfflineDownload()') < reload.indexOf('getVideoInformationLocal()'))
  const mountStart = watchSource.indexOf('onMountedDependOnLocalStateLoading()')
  const mountEnd = watchSource.indexOf('loadDownloadedFormats:', mountStart)
  const mount = watchSource.slice(mountStart, mountEnd)
  assert.ok(mount.includes("if (this.$route.query.offlinePlaylist)"))
  assert.ok(mount.includes('return'))
})

test('offline playlist bypasses online metadata APIs', () => {
  const reloadStart = watchSource.indexOf('if (this.$route.query.offline || this.$route.query.offlinePlaylist) {', watchSource.indexOf('async reloadView()'))
  const reloadEnd = watchSource.indexOf('\n      switch (this.backendPreference)', reloadStart)
  const reloadOfflineBranch = watchSource.slice(reloadStart, reloadEnd)
  assert.ok(reloadOfflineBranch.includes('this.loadOfflineDownload()'))
  assert.equal(reloadOfflineBranch.includes('getVideoInformationLocal'), false)
  assert.equal(reloadOfflineBranch.includes('getVideoInformationInvidious'), false)

  const mountStart = watchSource.indexOf('onMountedDependOnLocalStateLoading() {')
  const mountEnd = watchSource.indexOf('\n\n      this.checkIfPlaylist()', mountStart)
  const mountOfflineBranch = watchSource.slice(mountStart, mountEnd)
  assert.ok(mountOfflineBranch.includes('this.loadOfflineDownload()'))
  assert.equal(mountOfflineBranch.includes('getVideoInformationLocal'), false)
  assert.equal(mountOfflineBranch.includes('getVideoInformationInvidious'), false)
})

test('Watch falls back to online information when local source is absent', () => {
  const startup = watchSource.slice(watchSource.indexOf('if (this.loadOfflineDownload()) return'), watchSource.indexOf('document.removeEventListener', watchSource.indexOf('if (this.loadOfflineDownload()) return')))
  assert.ok(startup.includes('if (this.loadOfflineDownload()) return'))
  assert.ok(startup.includes('this.getVideoInformationInvidious()'))
  assert.ok(startup.includes('this.getVideoInformationLocal()'))
  const localStart = watchSource.indexOf('loadOfflineDownload: function')
  const localFlow = watchSource.slice(localStart, watchSource.indexOf('setViewingModeOnFirstLoad', localStart))
  assert.ok(localFlow.includes('if (!download) return false'))
})

test('local source has priority over online information on Watch startup', () => {
  const startupIndex = watchSource.indexOf('if (this.loadOfflineDownload()) return')
  const localIndex = watchSource.indexOf('loadOfflineDownload: function')
  const onlineIndex = watchSource.indexOf('getVideoInformationInvidious()', startupIndex)
  assert.ok(startupIndex >= 0)
  assert.ok(localIndex >= 0)
  assert.ok(onlineIndex > startupIndex)
  const localFlow = watchSource.slice(localIndex, watchSource.indexOf('setViewingModeOnFirstLoad', localIndex))
  assert.ok(localFlow.includes("item.status === 'completed'"))
  assert.ok(localFlow.includes('return true'))
})

test('offline Watch exposes explicit Play Online action', () => {
  assert.ok(watchVideoInfoSource.includes("t('Change Format.Play Online')"))
  assert.ok(watchVideoInfoSource.includes("value: 'online'"))
  assert.ok(watchSource.includes("if (format === 'online')"))
  const onlineStart = watchSource.indexOf('enableOnlineFormat: function')
  const onlineFlow = watchSource.slice(onlineStart, watchSource.indexOf('enableDashFormat', onlineStart))
  assert.ok(onlineFlow.includes('this.offlinePlayback = false'))
  assert.ok(onlineFlow.includes('this.getVideoInformationInvidious()'))
  assert.ok(onlineFlow.includes('this.getVideoInformationLocal()'))
})

test('local format selection changes player source without information request', () => {
  const selectStart = watchSource.indexOf('enableDownloadedFormat: function')
  const selectFlow = watchSource.slice(selectStart, watchSource.indexOf('enableOnlineFormat', selectStart))
  assert.ok(selectFlow.includes("this.activeFormat = 'offline'"))
  assert.ok(selectFlow.includes('this.manifestSrc = null'))
  assert.ok(selectFlow.includes('this.offlineUri = downloaded.source.offlineUri || null'))
  assert.equal(selectFlow.includes('getVideoInformation'), false)
})

test('Watch prefers completed local record before network information', () => {
  const localStart = watchSource.indexOf('loadOfflineDownload: function')
  const localFlow = watchSource.slice(localStart, watchSource.indexOf('setViewingModeOnFirstLoad', localStart))
  assert.ok(localFlow.includes('item.videoId === videoId'))
  assert.ok(localFlow.includes("item.status === 'completed'"))
  assert.ok(localFlow.includes('if (!download) return false'))
  assert.ok(watchSource.includes('if (this.loadOfflineDownload()) return'))
})

test('Watch format picker passes downloaded source descriptor to player', () => {
  assert.ok(watchVideoInfoSource.includes("t('Change Format.Use Downloaded Formats')"))
  assert.ok(watchVideoInfoSource.includes("type: 'downloaded', source: props.downloadedFormats[0]"))
  assert.ok(watchVideoInfoSource.includes('props.downloadedFormats.length > 0'))
  assert.ok(watchSource.includes('getDownloadedSources'))
  assert.ok(watchSource.includes('format?.type === \'downloaded\''))
  assert.ok(watchSource.includes('this.enableDownloadedFormat(format.source)'))
  assert.ok(watchSource.includes('this.offlineUri = downloaded.source.offlineUri || null'))
  assert.ok(watchViewSource.includes(':downloaded-formats="downloadedFormats"'))
})

test('Downloads hides Play for records without a playable source', () => {
  assert.ok(downloadsViewSource.includes('playableDownloadIds.has(download.downloadId)'))
  assert.ok(downloadsViewSource.includes('const playableDownloadIds = computed'))
  assert.ok(downloadsViewSource.includes('if (!playableDownloadIds.value.has(download.downloadId)) return'))
})

test('Downloads items distinguish processing and terminal statuses visually', () => {
  assert.ok(downloadsViewSource.includes(":class=\"`downloadItem downloadItem--${download.phase === 'processing' ? 'processing' : download.status}`\""))
  for (const status of ['processing', 'paused', 'failed', 'completed']) {
    assert.ok(downloadsViewSource.includes(`.downloadItem--${status}`))
  }
})

test('Downloads metadata shows engine source type', () => {
  assert.ok(downloadsViewSource.includes('function formatDownloadEngine(download)'))
  assert.ok(downloadsViewSource.includes("download.engine === 'sabr' || download.offlineUri"))
  assert.ok(downloadsViewSource.includes("download.engine === 'native' || download.localPath"))
  assert.ok(downloadsViewSource.includes('const engine = formatDownloadEngine(download)'))
})

test('processing phase is shown instead of download progress', () => {
  assert.ok(downloadsViewSource.includes("download.phase !== 'processing'"))
  assert.ok(downloadsViewSource.includes("t('Downloads.Processing')"))
  assert.ok(downloadsViewSource.includes('const processing = download.phase === \'processing\''))
  assert.ok(downloadsViewSource.includes('const hasProgress = !processing'))
})

test('unknown totals stay indeterminate across download layers', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 100 }, 0))), {
    received: 100, total: 0, totalExact: false, progress: null
  })
  assert.ok(downloadsViewSource.includes('download.total > 0 && download.progress != null'))
  assert.ok(downloadServiceSource.includes('progress ?: JSONObject.NULL'))
  assert.ok(downloadServiceSource.includes('builder.setProgress(0, 0, true)'))
})

test('transport bytes stay diagnostic while stored bytes drive progress', () => {
  const storeStart = source.indexOf('let transportBytes = 0')
  const storeEnd = source.indexOf('export async function recoverSabrDownload', storeStart)
  const store = source.slice(storeStart, storeEnd)
  assert.ok(store.includes('transportBytes += bytes'))
  assert.ok(store.includes('received: snapshot.received'))
  assert.ok(store.includes('networkBytes: transportBytes'))
  assert.equal(store.includes('received: transportBytes'), false)
})

test('active downloads reserve 100 percent for terminal completion', () => {
  assert.equal(getProgressSnapshot({ size: 80 }, 1, 100, true, false).progress, 0.8)
  assert.ok(source.includes('Math.min(Math.max(rawProgressValue, 0), 0.99)'))
  assert.ok(downloadServiceSource.includes('item.put("status", "completed").put("phase", "completed").put("progress", 1)'))
})

test('SABR progress uses Shaka progress and stays below 100 before terminal', () => {
  const inconsistentRawProgress = getProgressSnapshot({ size: 63.9 }, 0.78, 149.4, true)
  assert.equal(inconsistentRawProgress.received, 63.9)
  assert.equal(inconsistentRawProgress.total, 149.4)
  assert.equal(inconsistentRawProgress.totalExact, true)
  assert.equal(Math.round(inconsistentRawProgress.progress * 100), 43)
  assert.equal(getProgressSnapshot({ size: 63.9 }, 1, 149.4, true, false).progress, 63.9 / 149.4)

  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 500 }, 0.5))), {
    received: 500, total: 1000, totalExact: false, progress: 0.5
  })
  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 500 }, 0))), {
    received: 500, total: 0, totalExact: false, progress: null
  })
})

test('SABR terminal progress reaches 100 in Downloads', () => {
  const result = getProgressSnapshot({ size: 80 }, 1, 100, true)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    received: 80, total: 80, totalExact: true, progress: 1
  })
  assert.ok(downloadsViewSource.includes("download.status === 'downloading' && download.received > 0"))
})

test('SABR exact total stays fixed until stored bytes overflow it', () => {
  const first = getProgressSnapshot({ size: 100 }, 0.78, 1000, true)
  const earlyCompletion = getProgressSnapshot({ size: 900 }, 1, first.total, first.totalExact, false)
  const second = getProgressSnapshot({ size: 1000 }, 1, first.total, first.totalExact)
  assert.equal(first.total, 1000)
  assert.equal(first.totalExact, true)
  assert.equal(earlyCompletion.total, 1000)
  assert.equal(earlyCompletion.progress, 0.9)
  assert.equal(second.total, 1000)
  assert.equal(second.received, 1000)
  assert.equal(second.progress, 1)

  const overflow = getProgressSnapshot({ size: 1001 }, 0.78, second.total, second.totalExact)
  assert.equal(overflow.total, 1001)
  assert.equal(overflow.totalExact, false)
  assert.equal(overflow.progress, 1)
})

test('SABR transport bytes stay diagnostic and Downloads renders normalized progress', () => {
  assert.ok(source.includes('networkBytes: transportBytes'))
  assert.equal(watchSource.includes('networkBytes'), false)
  assert.equal(downloadsViewSource.includes('networkBytes'), false)
  assert.ok(downloadsViewSource.includes('Math.round(download.progress * 100)'))
  assert.equal(downloadsViewSource.includes('download.received / download.total'), false)
  assert.ok(source.includes("Math.min(Math.max(rawProgressValue, 0), 0.99)"))
  assert.ok(watchSource.includes('const finalSnapshot = getProgressSnapshot(content, 1, lastTotal, lastTotalExact)'))
  assert.equal(watchSource.includes('progress: 1'), false)
})

test('SABR progress event updates bytes, speed and percent immediately', () => {
  const result = mergeDownloadProgress({ downloadId: 'sabr', progress: 0 }, {
    status: 'downloading', progress: 0.25, received: 25, total: 100, speedBps: 50, etaSeconds: 2
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    downloadId: 'sabr', status: 'downloading', progress: 0.25, received: 25, total: 100, totalExact: false, fileSize: 0, speedBps: 50, etaSeconds: 2, error: null
  })
})

test('SABR progress bar keeps active Shaka progress below 100 percent', () => {
  const result = mergeDownloadProgress({ downloadId: 'sabr' }, {
    status: 'downloading', progress: 1, received: 80, total: 100, totalExact: true
  })
  assert.equal(result.status, 'downloading')
  assert.equal(result.progress, 0.99)
  assert.equal(result.received, 80)
  assert.equal(result.total, 100)
})

test('native queue leaves progress notifications to DownloadService', () => {
  assert.ok(!source.includes('android.updateDownloadNotification?.(downloadId, video.title, item.status'))
  assert.ok(downloadServiceSource.includes('notify(item.optString("id"), item.optString("title")'))
})

test('SABR notifications use video title and clear every terminal state', () => {
  assert.ok(watchSource.includes('getDownloadNotificationPayload({ downloadId, title: this.videoTitle'))
  assert.equal(watchSource.match(/android\.finishDownloadNotification\?\.\(downloadId\)/g)?.length, 3)
})

test('metadata update changes only matching download', () => {
  storage.set('freetube-downloads', JSON.stringify([
    { downloadId: 'one', status: 'downloading' },
    { downloadId: 'two', status: 'completed' }
  ]))
  updateDownloadMetadata('one', { status: 'failed', error: 'network' })
  const result = JSON.parse(storage.get('freetube-downloads'))
  assert.deepEqual(result.map(({ updatedAt, ...download }) => download), [
    { downloadId: 'one', status: 'failed', error: 'network' },
    { downloadId: 'two', status: 'completed' }
  ])
  assert.ok(result[0].updatedAt > 0)
})

test('download metadata clamps speed jumps', () => {
  storage.set('freetube-downloads', JSON.stringify([
    { downloadId: 'speed', status: 'downloading', speedBps: 100 }
  ]))
  updateDownloadMetadata('speed', { status: 'downloading', speedBps: 1000 })
  assert.equal(JSON.parse(storage.get('freetube-downloads'))[0].speedBps, 150)
})

test('download concurrency defaults to five across Android paths', () => {
  assert.ok(source.includes('DEFAULT_DOWNLOAD_CONCURRENCY'))
  assert.ok(source.includes("|| DEFAULT_DOWNLOAD_CONCURRENCY"))
  assert.match(downloadServiceSource, /getInt\("maxConcurrent", 5\)/)
})

test('heavy SABR downloads use two scheduler weight units', () => {
  assert.ok(source.includes("Number(maxHeight) >= 1080 ? 2 : 1"))
  assert.ok(source.includes('sabrActiveWeight + weight <= sabrBudget()'))
  assert.ok(source.includes('weight: slotWeight'))
})

test('download progress persistence is throttled', () => {
  assert.ok(source.includes('DOWNLOAD_PROGRESS_UPDATE_MS = 250'))
  assert.ok(source.includes('now - lastUpdatedAt < DOWNLOAD_PROGRESS_UPDATE_MS'))
  assert.ok(source.includes('const nearCompletion = Number(changes.progress) >= 0.99'))
  assert.match(downloadServiceSource, /now - lastPublishedAt >= 250_000_000L/)
})

test('Watch route leave keeps active SABR download recoverable', () => {
  const leaveStart = watchSource.indexOf('beforeRouteLeave: function')
  const leaveEnd = watchSource.indexOf('setup: function', leaveStart)
  const leave = watchSource.slice(leaveStart, leaveEnd)
  assert.ok(leave.includes('this.handleRouteChange()'))
  assert.ok(leave.includes('this.destroyPlayer()'))
  assert.equal(leave.includes('cancelSabrDownload('), false)

  const downloadStart = watchSource.indexOf('async downloadSabr(')
  const record = watchSource.indexOf('recordDownloadMetadata({', downloadStart)
  const store = watchSource.indexOf('content = await storeSabrDownload', record)
  assert.ok(record > downloadStart && store > record)
})

test('SABR state transitions keep paused, canceled and interrupted distinct', () => {
  const controlStart = downloadsViewSource.indexOf('async function control(download, action)')
  const controlEnd = downloadsViewSource.indexOf('function play(download)', controlStart)
  const control = downloadsViewSource.slice(controlStart, controlEnd)
  assert.ok(control.includes("download.status = action === 'pause' ? 'paused' : 'canceled'"))
  assert.ok(control.includes('interrupted: action === \'pause\''))

  const loadStart = downloadsViewSource.indexOf('function load()')
  const loadEnd = downloadsViewSource.indexOf('async function retry(', loadStart)
  const load = downloadsViewSource.slice(loadStart, loadEnd)
  assert.ok(load.includes("download.status === 'downloading' && !download.interrupted && !hasSabrDownload(download.downloadId)"))
  assert.ok(load.includes("status: 'queued', interrupted: true"))
})

test('SABR recovery is guarded against duplicate runs', () => {
  const start = downloadsViewSource.indexOf('async function recoverSabrDownloads()')
  const end = downloadsViewSource.indexOf('function handleDownloadControl', start)
  const recovery = downloadsViewSource.slice(start, end)
  assert.ok(recovery.includes('if (sabrRecoveryRunning) return'))
  assert.ok(recovery.includes('sabrRecoveryRunning = true'))
  assert.ok(recovery.includes('sabrRecoveryRunning = false'))
  assert.equal((recovery.match(/Promise\.all\(queued\.map\(recover\)\)/g) || []).length, 1)
})

test('Downloads view recovers interrupted SABR records after app resume', () => {
  const mountStart = downloadsViewSource.indexOf('onMounted(() =>')
  const mountEnd = downloadsViewSource.indexOf('\nonBeforeUnmount', mountStart)
  const mount = downloadsViewSource.slice(mountStart, mountEnd)
  assert.ok(mount.indexOf('load()') < mount.indexOf('recoverSabrDownloads()'))
  assert.ok(mount.includes("window.addEventListener('app-resume', load)"))

  const recoveryStart = downloadsViewSource.indexOf('async function recoverSabrDownloads()')
  const recoveryEnd = downloadsViewSource.indexOf('function handleDownloadControl', recoveryStart)
  const recovery = downloadsViewSource.slice(recoveryStart, recoveryEnd)
  assert.ok(recovery.includes("item.status === 'queued' && item.interrupted && item.manifestSrc && item.sabrData"))
  assert.ok(recovery.includes('await Promise.all(queued.map(recover))'))
})

test('SABR recovery starts queued downloads together', () => {
  const recovery = downloadsViewSource.slice(downloadsViewSource.indexOf('async function recoverSabrDownloads()'), downloadsViewSource.indexOf('function handleDownloadControl'))
  assert.ok(recovery.includes('const queued = downloads.value.filter'))
  assert.ok(recovery.includes('await Promise.all(queued.map(recover))'))
  assert.equal(recovery.includes('while ((download ='), false)
})

test('Downloads selection uses stable ids across metadata reloads', () => {
  assert.ok(downloadsViewSource.includes('const selectedDownloadIds = ref(new Set())'))
  assert.ok(downloadsViewSource.includes('selectedDownloadIds.value = new Set([...selectedDownloadIds.value].filter(id => downloadIds.has(id)))'))
  assert.ok(downloadsViewSource.includes(':checked="selectedDownloadIds.has(download.downloadId)"'))
  assert.equal(downloadsViewSource.includes('downloads.value.includes(download)'), false)
})
