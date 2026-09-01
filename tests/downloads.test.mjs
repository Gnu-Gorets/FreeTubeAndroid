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

test('fallback save dialog requests final mp4 name', () => {
  assert.ok(source.includes("requestSaveDialog(fileName, 'video/mp4')"))
  assert.ok(!source.includes('requestSaveDialog(`${fileName}.part`'))
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

test('SABR total stays fixed after first estimate', () => {
  const first = getStableProgressSnapshot({ size: 100 }, 100, 0.1)
  const second = getStableProgressSnapshot({ size: 500 }, 500, 0.5, first.total)
  assert.equal(first.total, 1000)
  assert.equal(second.total, 1000)
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
