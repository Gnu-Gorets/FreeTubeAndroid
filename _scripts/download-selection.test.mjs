import assert from 'node:assert/strict'
import test from 'node:test'
import { compareAudioFormats, compareAudioSizes, compareLabels, compareVideoFormats, getAudioFormatsForTrack, selectDefaultAudioTrack, selectDefaultVideoFormat } from '../src/renderer/helpers/download-selection.mjs'

const formats = [
  { id: 'webm-best', kind: 'audio', audioTrackId: 'ru.4', mimeType: 'audio/webm', bitrate: 192000, size: 9_000_000 },
  { id: 'm4a-low', kind: 'audio', audioTrackId: 'ru.4', mimeType: 'audio/mp4', bitrate: 128000, size: 6_000_000 },
  { id: 'm4a-best', kind: 'audio', audioTrackId: 'ru.4', mimeType: 'audio/mp4', bitrate: 192000, size: 9_000_000 },
  { id: 'webm-small', kind: 'audio', audioTrackId: 'ru.4', mimeType: 'audio/webm', bitrate: 256000, size: 5_000_000 },
  { id: 'en-best', kind: 'audio', audioTrackId: 'en-US.10', mimeType: 'audio/mp4', bitrate: 256000, size: 12_000_000 }
]

test('labels sort alphabetically', () => {
  assert.deepEqual([
    { label: 'German (DE)' },
    { label: 'english (US)' },
    { label: 'French (FR)' }
  ].sort(compareLabels).map(format => format.label), [
    'english (US)', 'French (FR)', 'German (DE)'
  ])
})

test('video sorts MP4 before WebM by resolution', () => {
  assert.deepEqual([
    { id: 'webm-1080', mimeType: 'video/webm', height: 1080, size: 20 },
    { id: 'mp4-720', mimeType: 'video/mp4', height: 720, size: 10 },
    { id: 'mp4-1080', mimeType: 'video/mp4', height: 1080, size: 15 }
  ].sort(compareVideoFormats).map(format => format.id), [
    'mp4-1080', 'mp4-720', 'webm-1080'
  ])
})

test('video defaults to 1080p MP4, then best MP4, then WebM', () => {
  const formats = [
    { id: 'webm-2160', mimeType: 'video/webm', height: 2160 },
    { id: 'mp4-2160', mimeType: 'video/mp4', height: 2160 },
    { id: 'mp4-1080', mimeType: 'video/mp4', height: 1080 }
  ]
  assert.equal(selectDefaultVideoFormat(formats).id, 'mp4-1080')
  assert.equal(selectDefaultVideoFormat(formats.filter(format => format.id !== 'mp4-1080')).id, 'mp4-2160')
  assert.equal(selectDefaultVideoFormat(formats.filter(format => format.mimeType !== 'video/mp4')).id, 'webm-2160')
})

test('audio defaults to English track', () => {
  assert.equal(selectDefaultAudioTrack([
    { id: 'de', label: 'German', language: 'de' },
    { id: 'en-US', label: 'English (US)', language: 'en-US' }
  ]).id, 'en-US')
})

test('video selects compatible highest bitrate audio', () => {
  assert.deepEqual(
    getAudioFormatsForTrack(formats, 'ru.4', 'video/mp4').map(format => format.id),
    ['m4a-best', 'm4a-low']
  )
})

test('video selects matching WebM audio', () => {
  assert.deepEqual(
    getAudioFormatsForTrack(formats, 'ru.4', 'video/webm').map(format => format.id),
    ['webm-small', 'webm-best']
  )
})

test('audio mode sorts all containers by size', () => {
  assert.deepEqual(
    getAudioFormatsForTrack(formats, 'ru.4', '', 'size').map(format => format.id),
    ['m4a-best', 'm4a-low', 'webm-best', 'webm-small']
  )
})

test('equal bitrate prefers larger stream', () => {
  assert.equal(compareAudioFormats(
    { bitrate: 192000, size: 6_000_000 },
    { bitrate: 192000, size: 9_000_000 }
  ), 3_000_000)
})

test('audio size sort uses bitrate as tie breaker', () => {
  assert.equal(compareAudioSizes(
    { bitrate: 128000, size: 9_000_000 },
    { bitrate: 192000, size: 9_000_000 }
  ), 64_000)
})
