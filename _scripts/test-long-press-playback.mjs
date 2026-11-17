import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source = await readFile('src/renderer/components/ft-shaka-video-player/ft-shaka-video-player.js', 'utf8')

assert.match(source, /if \(!process\.env\.IS_ANDROID \|\| event\.pointerType === 'mouse' \|\| video\.value\.paused\) return/)
assert.match(source, /longPressTimer = setTimeout\(\(\) => \{/)
assert.match(source, /video\.value\.playbackRate = Math\.min\(2, maxVideoPlaybackRate\.value\)/)
assert.match(source, /controlsContainer\.addEventListener\('pointerdown', startLongPressPlayback\)/)
assert.match(source, /controlsContainer\.addEventListener\('pointerup', stopLongPressPlayback\)/)
assert.match(source, /controlsContainer\.addEventListener\('pointercancel', stopLongPressPlayback\)/)
assert.match(source, /customContextMenu: !process\.env\.IS_ANDROID/)
assert.match(source, /contextMenuElements: process\.env\.IS_ANDROID \? \[\] : \['ft_stats'\]/)
assert.match(source, /if \(!process\.env\.IS_ANDROID\) \{\n\s+shakaContextMenu\.registerElement\('ft_stats', new StatsButtonFactory\(\)\)/)
assert.match(source, /shakaOverflowMenu\.registerElement\('ft_stats', new StatsButtonFactory\(\)\)/)
assert.match(source, /onBeforeUnmount\(\(\) => \{[\s\S]*?removeLongPressPlaybackListeners\(\)[\s\S]*?\n\}\)/)

const start = source.match(/function startLongPressPlayback\(event\) \{[\s\S]*?\n {4}\}/)?.[0]
const stop = source.match(/function stopLongPressPlayback\(\) \{[\s\S]*?\n {4}\}/)?.[0]
assert.ok(start && stop)
const timers = new Map()
let nextTimer = 0
const video = { value: { paused: false, playbackRate: 1 } }
const gestures = runInNewContext(`
  let longPressTimer
  let longPressPlaybackRate
  ${start}
  ${stop}
  ({ startLongPressPlayback, stopLongPressPlayback })
`, {
  process: { env: { IS_ANDROID: true } },
  video,
  maxVideoPlaybackRate: { value: 2 },
  showValueChange() {},
  setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer },
  clearTimeout(id) { timers.delete(id) }
})
const pointer = { pointerType: 'touch', isPrimary: true, target: { closest: () => false } }
gestures.startLongPressPlayback(pointer)
assert.equal(timers.size, 1)
gestures.startLongPressPlayback({ ...pointer, isPrimary: false })
assert.equal(timers.size, 0, 'a second finger cancels pending acceleration')
assert.equal(video.value.playbackRate, 1)
gestures.startLongPressPlayback(pointer)
timers.get(nextTimer)()
assert.equal(video.value.playbackRate, 2)
gestures.startLongPressPlayback({ ...pointer, isPrimary: false })
assert.equal(video.value.playbackRate, 1, 'pinch restores the playback rate after an active long press')
assert.equal(timers.size, 0)
console.log('long-press playback contract: PASS')
