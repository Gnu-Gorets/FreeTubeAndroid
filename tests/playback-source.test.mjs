import assert from 'node:assert/strict'
import test from 'node:test'
import { createDownloadedPlaylistRoute, getCompletedDownloadRecords, getDownloadedSources, getOfflinePlaybackState, getPlayableDownloadRecords, getPlaybackSource } from '../src/renderer/helpers/player/playback-source.mjs'

test('offline Shaka URI is preferred', () => {
  assert.deepEqual(getPlaybackSource({ offlineUri: 'offline:manifest/1', localPath: 'data://1' }, () => 'native://1'), {
    offlineUri: 'offline:manifest/1'
  })
})

test('native local path uses Android playback URL', () => {
  assert.deepEqual(getPlaybackSource({ localPath: 'data://1' }, uri => `native:${uri}`), {
    localVideoUrl: 'native:data://1'
  })
})

test('missing source is rejected', () => {
  assert.equal(getPlaybackSource({}, () => null), null)
})

test('downloaded sources include only completed playable records for video', () => {
  assert.deepEqual(getDownloadedSources([
    { downloadId: 'offline', videoId: 'video-1', status: 'completed', offlineUri: 'offline:1', selectedFormat: '720p' },
    { downloadId: 'native', videoId: 'video-1', status: 'completed', localPath: 'data://1', selectedFormat: '480p' },
    { downloadId: 'paused', videoId: 'video-1', status: 'paused', offlineUri: 'offline:2' },
    { downloadId: 'other', videoId: 'video-2', status: 'completed', offlineUri: 'offline:3' },
    { downloadId: 'missing', videoId: 'video-1', status: 'completed' }
  ], 'video-1', uri => `native:${uri}`), [
    { downloadId: 'offline', selectedFormat: '720p', source: { offlineUri: 'offline:1' } },
    { downloadId: 'native', selectedFormat: '480p', source: { localVideoUrl: 'native:data://1' } }
  ])
})

test('downloaded playlist keeps selected order in route state', () => {
  assert.deepEqual(createDownloadedPlaylistRoute(['two', 'one', 'three']), {
    query: { offline: 'two', offlinePlaylist: 'two,one,three' }
  })
})

test('playlist model stays metadata-only without a persistent store', () => {
  const records = [{ downloadId: 'one', status: 'completed' }]
  const result = getCompletedDownloadRecords(records)
  assert.equal(result[0], records[0])
  assert.deepEqual(result, records)
})

test('playable download records exclude completed records without a source', () => {
  const records = [
    { downloadId: 'offline', status: 'completed', offlineUri: 'offline:1' },
    { downloadId: 'missing', status: 'completed' },
    { downloadId: 'native', status: 'completed', localPath: 'data://1' },
    { downloadId: 'pending', status: 'downloading', offlineUri: 'offline:2' }
  ]
  assert.deepEqual(
    getPlayableDownloadRecords(records, path => `native:${path}`).map(download => download.downloadId),
    ['offline', 'native']
  )
})

test('playlist source model uses completed download metadata records', () => {
  const records = [
    { downloadId: 'one', status: 'completed' },
    { downloadId: 'paused', status: 'paused' },
    { downloadId: 'two', status: 'completed' }
  ]
  assert.deepEqual(getCompletedDownloadRecords(records), [records[0], records[2]])
  assert.deepEqual(getCompletedDownloadRecords(null), [])
})

test('multiple downloaded qualities remain separate local sources', () => {
  assert.deepEqual(getDownloadedSources([
    { downloadId: '720p', videoId: 'video', status: 'completed', localPath: 'data://720p', selectedFormat: '720p' },
    { downloadId: '360p', videoId: 'video', status: 'completed', offlineUri: 'offline:360p', selectedFormat: '360p' }
  ], 'video', uri => `native:${uri}`), [
    { downloadId: '720p', selectedFormat: '720p', source: { localVideoUrl: 'native:data://720p' } },
    { downloadId: '360p', selectedFormat: '360p', source: { offlineUri: 'offline:360p' } }
  ])
})

test('missing local targets are excluded from downloaded sources', () => {
  assert.deepEqual(getDownloadedSources([
    { downloadId: 'empty-offline', videoId: 'video', status: 'completed', offlineUri: '' },
    { downloadId: 'missing-file', videoId: 'video', status: 'completed', localPath: 'data://missing' },
    { downloadId: 'valid', videoId: 'video', status: 'completed', localPath: 'data://valid' }
  ], 'video', uri => uri.endsWith('valid') ? `native:${uri}` : ''), [
    { downloadId: 'valid', selectedFormat: '', source: { localVideoUrl: 'native:data://valid' } }
  ])
})

test('unavailable download statuses are excluded from local formats', () => {
  assert.deepEqual(getDownloadedSources([
    { downloadId: 'paused', videoId: 'video', status: 'paused', offlineUri: 'offline:paused' },
    { downloadId: 'failed', videoId: 'video', status: 'failed', localPath: 'data://failed' },
    { downloadId: 'canceled', videoId: 'video', status: 'canceled', offlineUri: 'offline:canceled' }
  ], 'video', uri => `native:${uri}`), [])
})

test('downloaded source descriptor keeps offline and native locators separate', () => {
  const [offline, native] = getDownloadedSources([
    { downloadId: 'offline', videoId: 'video', status: 'completed', offlineUri: 'offline:1' },
    { downloadId: 'native', videoId: 'video', status: 'completed', localPath: 'data://1' }
  ], 'video', uri => `native:${uri}`)
  assert.deepEqual(offline.source, { offlineUri: 'offline:1' })
  assert.deepEqual(native.source, { localVideoUrl: 'native:data://1' })
  assert.equal('localVideoUrl' in offline.source, false)
  assert.equal('offlineUri' in native.source, false)
})

test('offline Watch state keeps video metadata and offline MIME', () => {
  assert.deepEqual(getOfflinePlaybackState({
    videoId: 'video-1',
    title: 'Title',
    thumbnail: 'thumb',
    duration: 12,
    channelName: 'Channel',
    channelThumbnail: 'avatar',
    published: 1700000000000,
    captions: [{ language: 'en' }],
    chapters: [{ title: 'Intro' }],
    offlineUri: 'offline:manifest/idb/v5/1'
  }), {
    videoId: 'video-1',
    title: 'Title',
    thumbnail: 'thumb',
    duration: 12,
    channelId: '',
    channelName: 'Channel',
    channelThumbnail: 'avatar',
    published: 1700000000000,
    description: '',
    descriptionHtml: '',
    license: '',
    viewCount: null,
    likeCount: 0,
    dislikeCount: 0,
    isLive: false,
    videoGenreIsMusic: false,
    captions: [{ language: 'en' }],
    chapters: [{ title: 'Intro' }],
    offlineUri: 'offline:manifest/idb/v5/1',
    localVideoUrl: null,
    manifestMimeType: 'application/x-offline-manifest'
  })
})

test('native Watch state has no offline manifest MIME', () => {
  assert.deepEqual(getOfflinePlaybackState({ videoId: 'video-2', localPath: 'data://video' }, value => `native:${value}`), {
    videoId: 'video-2',
    title: '',
    thumbnail: '',
    duration: 0,
    channelId: '',
    channelName: '',
    channelThumbnail: '',
    published: 0,
    description: '',
    descriptionHtml: '',
    license: '',
    viewCount: null,
    likeCount: 0,
    dislikeCount: 0,
    isLive: false,
    videoGenreIsMusic: false,
    captions: [],
    chapters: [],
    offlineUri: null,
    localVideoUrl: 'native:data://video',
    manifestMimeType: ''
  })
})
