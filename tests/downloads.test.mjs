import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../src/renderer/helpers/android/downloads.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  .replace(/const log = .*$/m, 'const log = () => {}')
  .replace(/const requestSaveDialog = .*$/m, 'const requestSaveDialog = () => {}')
  .replace(/const setupSabrScheme = .*$/m, 'const setupSabrScheme = () => {}')
const downloadServiceSource = fs.readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadService.kt', import.meta.url), 'utf8')
const androidBridgeSource = fs.readFileSync(new URL('../android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt', import.meta.url), 'utf8')
const watchSource = fs.readFileSync(new URL('../src/renderer/views/Watch/Watch.js', import.meta.url), 'utf8')
const downloadsViewSource = fs.readFileSync(new URL('../src/renderer/views/Downloads/Downloads.vue', import.meta.url), 'utf8')

const storage = new Map()
const context = vm.createContext({
  console,
  document: {},
  localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value))
  },
  shaka: { offline: { Storage: true } },
  android: {}
})
vm.runInContext(source, context)

const { getDownloadFormats, getProgressSnapshot, getSabrDownloadFormats, getStableProgressSnapshot, mergeDownloadProgress, mergeNativeDownload, recordDownloadMetadata, selectSabrDownloadTrack, selectSabrStorageTracks, updateDownloadMetadata } = context

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

test('SABR storage callback keeps exact MP4 ids and never falls back to WebM', () => {
  const exact = { type: 'variant', height: 1080, bandwidth: 10, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4', originalVideoId: 'video-exact', originalAudioId: 'audio-exact' }
  const fallback = { type: 'variant', height: 720, bandwidth: 20, videoMimeType: 'video/mp4', audioMimeType: 'audio/mp4', originalVideoId: 'video-fallback', originalAudioId: 'audio-fallback' }
  const webm = { type: 'variant', height: 1080, bandwidth: 30, videoMimeType: 'video/webm', audioMimeType: 'audio/webm', originalVideoId: 'video-webm', originalAudioId: 'audio-webm' }
  assert.deepEqual(Array.from(selectSabrStorageTracks([fallback, exact], { videoTrackId: 'video-exact', audioTrackId: 'audio-exact', maxHeight: 720 })), [exact])
  assert.deepEqual(Array.from(selectSabrStorageTracks([webm, fallback], { videoTrackId: 'video-webm', audioTrackId: 'audio-webm', maxHeight: 1080 })), [fallback])
  assert.throws(() => selectSabrStorageTracks([webm], { videoTrackId: 'video-webm', audioTrackId: 'audio-webm' }), /SABR download has no MP4 track/)
  assert.ok(source.includes('trackSelectionCallback: selectTracks'))
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
    downloadId: 'one', status: 'downloading', progress: null, received: 5, total: 0, fileSize: 0, speedBps: 0, error: null
  })
  assert.equal(getStableProgressSnapshot({ size: 100 }, 1000, 2).progress, 1)
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

test('downloads use canonical native statuses and exact final file size', () => {
  assert.ok(androidBridgeSource.includes('fun getFileSize(uri: String): Long'))
  assert.ok(downloadServiceSource.includes('ACTION_STATE'))
  assert.ok(downloadServiceSource.includes('putExtra("status"'))
  assert.ok(downloadServiceSource.includes('item.put("fileSize", length('))
  assert.ok(source.includes('preflightSabrDownload'))
  assert.ok(watchSource.includes('total: preflight.total'))
  assert.ok(watchSource.includes('fileSize: exported.fileSize || 0'))
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

test('SABR progress uses stored bytes instead of transport overhead', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 0 }, 200, 0.1))), { received: 0, total: 0, totalExact: false })
  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 500 }, 200, 0.5))), { received: 500, total: 1000, totalExact: false })
  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 700 }, 900, 0.6, 2000))), { received: 700, total: 2000, totalExact: false })
})

test('SABR known total stays fixed through completion', () => {
  const first = getStableProgressSnapshot({ size: 100 }, 100, 0.1, 1000)
  const second = getStableProgressSnapshot({ size: 1000 }, 1500, 1, first.total)
  assert.equal(first.total, 1000)
  assert.equal(second.total, 1000)
  assert.equal(second.received, 1000)
  assert.equal(second.progress, 1)
})

test('SABR progress event updates bytes, speed and percent immediately', () => {
  const result = mergeDownloadProgress({ downloadId: 'sabr', progress: 0 }, {
    status: 'downloading', progress: 0.25, received: 25, total: 100, speedBps: 50, etaSeconds: 2
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    downloadId: 'sabr', status: 'downloading', progress: 0.25, received: 25, total: 100, fileSize: 0, speedBps: 50, etaSeconds: 2, error: null
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
