import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../src/renderer/helpers/android/downloads.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  .replace(/const log = .*$/m, 'const log = (...args) => globalThis.downloadLogs?.push(args)')
  .replace(/const requestSaveDialog = .*$/m, 'const requestSaveDialog = () => {}')
  .replace(/const setupSabrScheme = .*$/m, 'const setupSabrScheme = () => {}')
const downloadServiceSource = fs.readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadService.kt', import.meta.url), 'utf8')
const androidBridgeSource = fs.readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', import.meta.url), 'utf8')
const watchSource = fs.readFileSync(new URL('../src/renderer/views/Watch/Watch.js', import.meta.url), 'utf8')
const downloadsViewSource = fs.readFileSync(new URL('../src/renderer/views/Downloads/Downloads.vue', import.meta.url), 'utf8')

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
  process: { env: { IS_ANDROID: true } }
})
vm.runInContext(source, context)

const { downloadProgressiveVideo, getDownloadFormats, getProgressSnapshot, getSabrDownloadFormats, mergeDownloadProgress, mergeNativeDownload, preflightSabrDownload, recordDownloadMetadata, selectSabrDownloadTrack, selectSabrStorageTracks, storeSabrDownload, updateDownloadMetadata } = context

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
  assert.equal(Math.round(progress[1] * 100), 43)
  assert.equal(progress[2], 149.4)
  assert.equal(progress[3], true)
  assert.deepEqual(downloadLogs.filter(([message]) => message === 'SABR timestamp').map(([, detail]) => detail.event), [
    'slot-acquired',
    'offline-player-loaded',
    'store-started',
    'first-progress',
    'store-complete'
  ])
  assert.equal(downloadLogs.filter(([message]) => message === 'SABR timestamp').every(([, detail]) => Number.isFinite(detail.timestamp)), true)
  assert.equal(source.slice(source.indexOf('export async function storeSabrDownload'), source.indexOf('export async function recoverSabrDownload')).includes('estimateSabrSize('), false)
  assert.ok(source.includes('await player.load(manifestSrc, null, download.manifestMimeType)'))
})

test('Watch passes one complete SABR selection and logs its outer timestamps', () => {
  assert.ok(watchSource.includes('const selection = {'))
  for (const field of ['maxHeight', 'videoTrackId: preflight.videoId', 'audioTrackId: preflight.audioId', 'total: preflight.total', 'totalExact: preflight.totalExact']) assert.ok(watchSource.includes(field))
  assert.ok(watchSource.includes('}, selection)'))
  for (const event of ['selection', 'preflight-complete', 'completed']) assert.ok(watchSource.includes(`logSabrTimestamp(downloadId, '${event}'`))
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
  assert.ok(watchSource.includes('this.downloadSelected(formats)'))
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
  assert.ok(downloadsViewSource.includes('v-if="download.status === \'completed\'"'))
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

test('direct download keeps selected quality and source sizes', () => {
  assert.ok(watchSource.includes('selectedFormat: formats.label'))
  assert.ok(watchSource.includes('videoTotal: Number(formats.video.contentLength'))
  assert.ok(source.includes("selectedFormat: video.selectedFormat ||"))
  assert.ok(!source.includes("throw new Error('Download size is unavailable')"))
})

test('direct download queues honest initial totals, including unknown sizes', async () => {
  async function queue(video) {
    let item
    Object.assign(context.android, {
      downloadUrl: () => true,
      muxDownload: () => true,
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
    title: 'Title',
    videoUrl: 'https://video',
    audioUrl: '',
    videoTotal: 0,
    audioTotal: 0,
    total: 0,
    totalExact: false,
    targetUri: 'content://download',
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

test('native downloads use canonical statuses and exact final file size', () => {
  assert.ok(androidBridgeSource.includes('fun getFileSize(uri: String): Long'))
  assert.ok(downloadServiceSource.includes('ACTION_STATE'))
  assert.ok(downloadServiceSource.includes('putExtra("status"'))
  assert.ok(downloadServiceSource.includes('item.put("fileSize", length('))
  assert.ok(source.includes('preflightSabrDownload'))
  assert.ok(watchSource.includes('total: preflight.total'))
  assert.equal(watchSource.includes('exportSabrDownload'), false)
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

test('SABR progress is derived only from normalized stored bytes and total', () => {
  const inconsistentRawProgress = getProgressSnapshot({ size: 63.9 }, 0.78, 149.4, true)
  assert.equal(inconsistentRawProgress.received, 63.9)
  assert.equal(inconsistentRawProgress.total, 149.4)
  assert.equal(inconsistentRawProgress.totalExact, true)
  assert.equal(Math.round(inconsistentRawProgress.progress * 100), 43)

  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 500 }, 0.5))), {
    received: 500, total: 1000, totalExact: false, progress: 0.5
  })
  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 500 }, 0))), {
    received: 500, total: 0, totalExact: false, progress: null
  })
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
  assert.deepEqual(result, [
    { downloadId: 'one', status: 'failed', error: 'network' },
    { downloadId: 'two', status: 'completed' }
  ])
})

test('Downloads selection uses stable ids across metadata reloads', () => {
  assert.ok(downloadsViewSource.includes('const selectedDownloadIds = ref(new Set())'))
  assert.ok(downloadsViewSource.includes('selectedDownloadIds.value = new Set([...selectedDownloadIds.value].filter(id => downloadIds.has(id)))'))
  assert.ok(downloadsViewSource.includes(':checked="selectedDownloadIds.has(download.downloadId)"'))
  assert.equal(downloadsViewSource.includes('downloads.value.includes(download)'), false)
})
