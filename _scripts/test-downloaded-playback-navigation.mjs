import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const watch = await readFile('src/renderer/views/Watch/Watch.js', 'utf8')
const reloadStart = watch.indexOf('    async reloadView() {')
const reloadEnd = watch.indexOf('\n    resetVideoState:', reloadStart)
assert.notEqual(reloadStart, -1)
assert.notEqual(reloadEnd, -1)

const reloadView = watch.slice(reloadStart, reloadEnd)
const playlistCheck = reloadView.indexOf('this.checkIfPlaylist()')
const downloadedLookup = reloadView.indexOf('if (await this.loadDownloadedMission()) return')
const networkFallback = reloadView.indexOf('switch (this.backendPreference)')
assert.ok(playlistCheck >= 0 && playlistCheck < downloadedLookup)
assert.ok(downloadedLookup < networkFallback)

console.log('downloaded playback navigation: PASS')
