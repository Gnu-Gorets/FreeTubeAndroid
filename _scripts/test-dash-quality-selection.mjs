import assert from 'node:assert/strict'
import { getUniqueVideoTracks } from '../src/renderer/components/FtShakaVideoPlayer/player-components/dash-quality.mjs'

const tracks = [
  { width: 1280, height: 720, bandwidth: 2_000_000, language: 'en', roles: [] },
  { width: 256, height: 144, bandwidth: 120_000, language: 'en', roles: [], active: true },
  { width: 256, height: 144, bandwidth: 180_000, language: 'en', roles: [] },
  { width: 854, height: 480, bandwidth: 800_000, language: 'en', roles: [] },
  { width: 256, height: 144, bandwidth: 250_000, language: 'fr', roles: [] }
]

assert.deepEqual(
  getUniqueVideoTracks(tracks).map(({ label }) => label),
  ['720p', '480p', '144p']
)
assert.equal(getUniqueVideoTracks(tracks)[2].track.bandwidth, 180_000)
assert.equal(getUniqueVideoTracks(tracks)[2].selected, true)
assert.deepEqual(getUniqueVideoTracks([]), [])

console.log('DASH quality selection tests passed')
