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

const { getDownloadFormats, getProgressSnapshot, getSabrDownloadFormats, getStableProgressSnapshot, mergeDownloadProgress, mergeNativeDownload, recordDownloadMetadata, updateDownloadMetadata } = context

test('SABR qualities deduplicate variants and use quality labels', () => {
  const manifest = `data:application/sabr+json,${encodeURIComponent(JSON.stringify({
    formats: [
      { mimeType: 'video/mp4', quality: 'hd1080', height: 960, width: 1920 },
      { mimeType: 'video/mp4', quality: 'hd1080', height: 960, width: 1920 },
      { mimeType: 'video/mp4', quality: 'hd720', height: 640, width: 1280 },
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

test('invalid SABR manifest returns no quality options', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(getSabrDownloadFormats('not-a-manifest'))), [])
  assert.deepEqual(JSON.parse(JSON.stringify(getSabrDownloadFormats('data:application/sabr+json,%7Bbad'))), [])
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
    downloadId: 'one', status: 'downloading', progress: null, received: 5, total: 0, speedBps: 0, error: null
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
  assert.ok(downloadsViewSource.includes('window.Android?.deleteFile(download.localPath)'))
  assert.ok(downloadsViewSource.includes('downloads.value = downloads.value.filter'))
})

test('public downloads use MediaStore Downloads collection', () => {
  assert.ok(androidBridgeSource.includes('MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)'))
  assert.ok(!androidBridgeSource.includes('MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)'))
})

test('native finalization separates MediaStore publish from SAF targets', () => {
  assert.match(downloadServiceSource, /Uri\.parse\(uri\)\.authority == MediaStore\.AUTHORITY/)
  assert.ok(downloadServiceSource.includes('!targetExists(item.optString("targetUri"))'))
  assert.match(downloadServiceSource, /Unable to rename download target/)
  assert.ok(downloadServiceSource.includes('MediaStore.MediaColumns.DISPLAY_NAME'))
})

test('native queue progress replaces stale UI progress fields', () => {
  const result = mergeNativeDownload({ downloadId: 'one', progress: 0.1, received: 10, speedBps: 1 }, {
    status: 'downloading', progress: 0.4, received: 40, total: 100, speedBps: 30, etaSeconds: 2, error: null
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    downloadId: 'one', status: 'downloading', progress: 0.4, received: 40, total: 100, speedBps: 30, etaSeconds: 2, error: null
  })
})

test('SABR progress snapshot uses transport bytes before storage catches up', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 0 }, 200, 0.1))), { received: 200, total: 2000 })
  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 500 }, 200, 0.5))), { received: 500, total: 1000 })
  assert.deepEqual(JSON.parse(JSON.stringify(getProgressSnapshot({ size: 700 }, 900, 0.6, 2000))), { received: 900, total: 2000 })
})

test('SABR total never falls below received bytes', () => {
  const first = getStableProgressSnapshot({ size: 100 }, 100, 0.1)
  const second = getStableProgressSnapshot({ size: 1500 }, 1500, 0.5, first.total)
  assert.equal(first.total, 1000)
  assert.equal(second.total, 1500)
  assert.equal(second.progress, 0.5)
})

test('SABR progress event updates bytes, speed and percent immediately', () => {
  const result = mergeDownloadProgress({ downloadId: 'sabr', progress: 0 }, {
    status: 'downloading', progress: 0.25, received: 25, total: 100, speedBps: 50, etaSeconds: 2
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    downloadId: 'sabr', status: 'downloading', progress: 0.25, received: 25, total: 100, speedBps: 50, etaSeconds: 2, error: null
  })
})

test('native queue notifications sync title and terminal state', () => {
  assert.ok(source.includes('android.updateDownloadNotification?.(downloadId, video.title, item.status'))
  assert.ok(source.includes('android.finishDownloadNotification?.(downloadId, video.title, item.status === \'completed\')'))
})

test('SABR notifications use video title for every terminal state', () => {
  assert.ok(watchSource.includes('getDownloadNotificationPayload({ downloadId, title: this.videoTitle'))
  assert.ok(watchSource.includes('android.finishDownloadNotification?.(downloadId, this.videoTitle, true)'))
  assert.ok(watchSource.includes('android.finishDownloadNotification?.(downloadId, this.videoTitle, false)'))
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
