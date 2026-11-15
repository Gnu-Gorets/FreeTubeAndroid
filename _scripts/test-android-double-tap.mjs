import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { addAndroidDoubleTapSeeking, addAndroidPinchZoom } from '../src/renderer/helpers/player/android-double-tap.mjs'

for (const vertical of [false, true]) {
  const listeners = new Map()
  const container = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      assert.equal(listeners.get(type), listener)
      listeners.delete(type)
    }
  }
  const video = { style: { transform: '' } }
  const cleanup = addAndroidPinchZoom(container, video)
  const send = (type, touches) => {
    const event = { type, touches, preventDefault() { this.prevented = true } }
    listeners.get(type)(event)
    return event
  }
  const pair = distance => [{ clientX: 0, clientY: 0 }, { clientX: vertical ? 0 : distance, clientY: vertical ? distance : 0 }]

  send('touchstart', pair(100))
  assert.equal(send('touchmove', pair(200)).prevented, true)
  assert.equal(video.style.transform, 'scale(2)')
  send('touchend', [{}])
  send('touchstart', pair(100))
  send('touchmove', [...pair(500), { clientX: 250, clientY: 200 }])
  assert.equal(video.style.transform, 'scale(3)', 'zoom is capped and blocks additional-touch browser gestures')
  send('touchend', [{}])
  send('touchstart', pair(100))
  send('touchmove', pair(25))
  assert.equal(video.style.transform, '', 'zoom cannot shrink below the original size')
  send('touchstart', pair(100))
  send('touchcancel', pair(100))
  assert.equal(send('touchmove', pair(200)).prevented, undefined, 'cancel ends the active pinch')
  cleanup()
  assert.equal(listeners.size, 0)
  assert.equal(video.style.transform, '')
}

function fixture(shown = false) {
  const listeners = new Map()
  const seeks = []
  const indicators = new Map(['.shaka-rewind-container', '.shaka-fast-forward-container'].map(selector => {
    const value = { textContent: '0s' }
    return [selector, { style: { opacity: '0' }, querySelector: () => value }]
  }))
  const controls = {
    interval: 5,
    seekable: true,
    shown,
    menu: false,
    vr: false,
    isOpaque() { return this.shown },
    isPlayingVR() { return this.vr },
    anySettingsMenusAreOpen() { return this.menu },
    showUI() { this.shown = true },
    hideUI() { this.shown = false }
  }
  const container = {
    querySelector: selector => indicators.get(selector),
    getBoundingClientRect: () => ({ left: 100, width: 1000 }),
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      assert.equal(listeners.get(type), listener)
      listeners.delete(type)
    }
  }
  const cleanup = addAndroidDoubleTapSeeking(container, controls, direction => {
    if (!controls.seekable) return 0
    seeks.push(direction)
    return direction * controls.interval
  })
  function send(type, x, time, options = {}) {
    const event = {
      touches: type === 'touchend' ? [] : [{ clientX: x, clientY: 100 }],
      timeStamp: time,
      target: { closest: () => options.button ?? false },
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true },
      stopPropagation() { this.stopped = true },
      ...options
    }
    listeners.get(type)?.(event)
    return event
  }
  function tap(x, time, options) {
    send('touchstart', x, time, options)
    return send('touchend', x, time + 50, options)
  }
  return { controls, seeks, send, tap, cleanup, listeners, indicators }
}

for (const shown of [false, true]) {
  for (const [x, direction] of [[200, -1], [1000, 1]]) {
    const f = fixture(shown)
    f.tap(x, 0)
    assert.equal(f.controls.shown, !shown, 'single tap toggles controls')
    const end = f.tap(x, 200)
    assert.deepEqual(f.seeks, [direction], 'double tap seeks even with hidden controls')
    assert.equal(end.prevented, true, 'suppress synthetic click')
    assert.equal(end.stopped, true, 'do not also invoke Shaka touch handler')
    const indicator = f.indicators.get(direction < 0 ? '.shaka-rewind-container' : '.shaka-fast-forward-container')
    assert.equal(indicator.querySelector('span').textContent, `${direction * 5}s`)
    assert.equal(indicator.style.opacity, '1', 'show original Shaka indicator')
    f.tap(x, 400)
    assert.deepEqual(f.seeks, [direction, direction], 'each extra tap seeks again')
    assert.equal(indicator.querySelector('span').textContent, `${direction * 10}s`, 'accumulate seconds')
    f.cleanup()
    assert.equal(f.listeners.size, 0)
    assert.equal(indicator.style.opacity, '0', 'cleanup hides indicator')
    assert.equal(indicator.querySelector('span').textContent, '0s')
  }
}

for (const scenario of ['timeout', 'opposite', 'hold', 'scroll', 'cancel', 'multitouch', 'button', 'center', 'menu', 'vr']) {
  const f = fixture()
  f.tap(200, 0)
  switch (scenario) {
    case 'timeout': f.tap(200, 600); break
    case 'opposite': f.tap(1000, 200); break
    case 'hold': f.send('touchstart', 200, 200); f.send('touchend', 200, 800); break
    case 'scroll':
      f.send('touchstart', 200, 200)
      f.send('touchmove', 220, 220)
      f.send('touchmove', 200, 230)
      f.send('touchend', 200, 250)
      break
    case 'cancel': f.send('touchcancel', 200, 100); f.tap(200, 200); break
    case 'multitouch': f.send('touchstart', 200, 200, { touches: [{}, {}] }); f.send('touchend', 200, 250); break
    case 'button': assert.equal(f.tap(200, 200, { button: true }).stopped, false); break
    case 'center': assert.equal(f.tap(600, 200).stopped, false); break
    case 'menu': f.controls.menu = true; assert.equal(f.tap(200, 200).stopped, false); break
    case 'vr': f.controls.vr = true; assert.equal(f.tap(200, 200).stopped, false); break
  }
  assert.deepEqual(f.seeks, [], `${scenario} must not seek`)
  f.cleanup()
}

const timed = fixture()
timed.tap(200, 0)
timed.tap(200, 200)
const timedIndicator = timed.indicators.get('.shaka-rewind-container')
await new Promise(resolve => setTimeout(resolve, 550))
assert.equal(timedIndicator.style.opacity, '0', 'hide after original 500 ms window')
assert.equal(timedIndicator.querySelector('span').textContent, '0s')
assert.deepEqual(timed.seeks, [-1], 'indicator timeout must not seek a second time')
timed.cleanup()

const configured = fixture()
configured.controls.interval = 10
configured.tap(1000, 0)
configured.tap(1000, 200)
assert.equal(configured.indicators.get('.shaka-fast-forward-container').querySelector('span').textContent, '10s')
configured.cleanup()

const blocked = fixture()
blocked.controls.seekable = false
blocked.tap(200, 0)
blocked.tap(200, 200)
assert.deepEqual(blocked.seeks, [])
assert.equal(blocked.indicators.get('.shaka-rewind-container').style.opacity, '0')
blocked.cleanup()

const source = await readFile('src/renderer/components/FtShakaVideoPlayer/FtShakaVideoPlayer.vue', 'utf8')
assert.match(source, /if \(process\.env\.IS_ANDROID\) \{\n\s+firstTimeConfig\.seekOnTaps = true\n\s+firstTimeConfig\.doubleClickForFullscreen = false\n\s+\}/)
assert.match(source, /const seconds = direction \* defaultSkipInterval\.value\n\s+seekBySeconds\(seconds, true\)\n\s+return seconds/)
assert.match(source, /if \(!process\.env\.IS_ANDROID\) return\n\s+removeLongPressPlaybackListeners\(\)/)
assert.match(source, /removeDoubleTapSeeking\?\.\(\)/)
// Exercise the dependency's touch path, including its previous fullscreen toggle.
const shakaControls = await readFile('node_modules/shaka-player/ui/controls.js', 'utf8')
const shakaButton = await readFile('node_modules/shaka-player/ui/fullscreen_button.js', 'utf8')
const touchMethod = shakaControls.match(/ {2}onContainerTouch\(event\) \{[\s\S]*?\n {2}\}/)?.[0]
const clickMethod = shakaControls.match(/ {2}onContainerClick\(fromTouchEvent = false\) \{[\s\S]*?\n {2}\}/)?.[0]
const buttonHandler = shakaButton.match(/this\.eventManager\.listen\(this\.button_, 'click', (async \(\) => \{[\s\S]*?\n {4}\})\);/)?.[1]
assert.ok(touchMethod && clickMethod && buttonHandler, 'locate actual Shaka touch and button handlers')
const methods = runInNewContext(`({ ${touchMethod}, ${clickMethod} })`, { Date: { now: () => 100 } })

for (const doubleClickForFullscreen of [true, false]) {
  let toggles = 0
  const controls = {
    ...methods,
    video_: { duration: 100 },
    enabled_: true,
    config_: { doubleClickForFullscreen, singleClickForPlayAndPause: false },
    lastContainerTouchEventTime_: null,
    isPlayingVR: () => false,
    isFullScreenSupported: () => true,
    isOpaque: () => true,
    anyContextMenusAreOpen: () => false,
    anySettingsMenusAreOpen: () => false,
    hideUITimer_: { stop() {}, tickNow() {}, tickAfter() {} },
    resetLastTouchEventTime() { this.lastContainerTouchEventTime_ = null },
    toggleFullScreen() { toggles++ }
  }
  for (const touches of [[{ clientX: 500, clientY: 150 }], []]) {
    controls.onContainerTouch({ touches, cancelable: true, preventDefault() {} })
  }
  assert.equal(toggles, doubleClickForFullscreen ? 1 : 0, 'staggered releases must not toggle Android fullscreen')
  const button = { controls, button_: { focus() {} } }
  const invokeButton = runInNewContext(`(function () { return (${buttonHandler})() })`)
  await invokeButton.call(button)
  assert.equal(toggles, doubleClickForFullscreen ? 2 : 1, 'fullscreen button remains active')
}
console.log('Android double-tap seeking and fullscreen gestures: PASS')
