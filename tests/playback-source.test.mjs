import assert from 'node:assert/strict'
import test from 'node:test'
import { getOfflinePlaybackState, getPlaybackSource } from '../src/renderer/helpers/player/playback-source.mjs'

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
