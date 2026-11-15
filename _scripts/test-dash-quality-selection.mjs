import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { getQualityMark, getUniqueVideoTracks } from '../src/renderer/components/FtShakaVideoPlayer/player-components/dash-quality.mjs'

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
assert.equal(getQualityMark(1920, 1080, { 720: '', 1080: 'HD', 1440: '2K', 2160: '4K', 4320: '8K' }), 'HD')
assert.equal(getQualityMark(2560, 1440, { 720: '', 1080: 'HD', 1440: '2K', 2160: '4K', 4320: '8K' }), '2K')
assert.equal(getQualityMark(3840, 2160, { 720: '', 1080: 'HD', 1440: '2K', 2160: '4K', 4320: '8K' }), '4K')

const player = await readFile('src/renderer/components/ft-shaka-video-player/ft-shaka-video-player.js', 'utf8')
assert.match(player, /props\.format === 'dash' \? 'ft_dash_quality'/)
assert.match(player, /shakaControls\.registerElement\('ft_dash_quality'/)
assert.match(player, /registerDashQualitySelection\(\)/)

console.log('DASH quality selection tests passed')
