import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const watch = await readFile('src/renderer/views/Watch/Watch.js', 'utf8')
const reloadStart = watch.indexOf('    async reloadView() {')
const reloadEnd = watch.indexOf('\n    resetVideoState:', reloadStart)
assert.notEqual(reloadStart, -1)
assert.notEqual(reloadEnd, -1)

const reloadView = watch.slice(reloadStart, reloadEnd)
const resetState = reloadView.indexOf('this.resetVideoState()')
const nextTick = reloadView.indexOf('await this.$nextTick()', resetState)
const playlistCheck = reloadView.indexOf('this.checkIfPlaylist()')
const downloadedLookup = reloadView.indexOf('if (await this.loadDownloadedMission()) return')
const networkFallback = reloadView.indexOf('switch (this.backendPreference)')
assert.ok(resetState >= 0 && resetState < nextTick && nextTick < playlistCheck)
assert.ok(playlistCheck >= 0 && playlistCheck < downloadedLookup)
assert.ok(downloadedLookup < networkFallback)
assert.match(watch, /const wasPlaying = shouldResume \|\| \(this\.\$refs\.player \? !this\.\$refs\.player\.isPaused\(\) : false\)/)
assert.match(watch, /handleDownloadedPlaybackStarted: function \(\)[\s\S]*?this\.resumeDownloadedPlayback = false/)
assert.match(watch, /playDownloadedVideo\(1, true\)/)
assert.match(await readFile('src/renderer/views/Watch/Watch.vue', 'utf8'), /:autoplay-on-load="resumeDownloadedPlayback"/)
assert.match(await readFile('src/renderer/views/Watch/Watch.vue', 'utf8'), /@play="handleDownloadedPlaybackStarted"/)
assert.match(await readFile('src/renderer/components/FtShakaVideoPlayer/FtShakaVideoPlayer.vue', 'utf8'), /autoplayVideos \|\| autoplayOnLoad/)
assert.match(await readFile('src/renderer/components/FtShakaVideoPlayer/FtShakaVideoPlayer.vue', 'utf8'), /if \(props\.autoplayOnLoad && video\.value\.paused\)[\s\S]*?video\.value\.play\(\)\.catch/)

console.log('downloaded playback navigation: PASS')
