import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { addAndroidDoubleTapSeeking, addAndroidPinchZoom } from '../src/renderer/helpers/player/android-double-tap.mjs'

function pinchFixture(objectFit = 'fill') {
  const listeners = new Map()
  const messages = []
  const container = {
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 1000, height: 600 }),
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      assert.equal(listeners.get(type), listener)
      listeners.delete(type)
    }
  }
  function transform() {
    if (!video.style.transform) return { x: 0, y: 0, scale: 1 }
    const values = video.style.transform.match(/translate\(([^p]+)px, ([^p]+)px\) scale\(([^)]+)\)/)
    assert.ok(values, 'finite translate and scale transform')
    return { x: Number(values[1]), y: Number(values[2]), scale: Number(values[3]) }
  }
  const video = {
    style: { transform: '', objectFit },
    videoWidth: 1600,
    videoHeight: 900,
    getBoundingClientRect: () => {
      const { x, y, scale } = transform()
      return { left: 600 + x - 500 * scale, top: 500 + y - 300 * scale, width: 1000 * scale, height: 600 * scale }
    }
  }
  const cleanup = addAndroidPinchZoom(container, video, message => messages.push(message))
  function send(type, touches) {
    const event = { type, touches, preventDefault() { this.prevented = true } }
    listeners.get(type)?.(event)
    return event
  }
  return { send, cleanup, transform, messages, video, listeners }
}

function pair(x, y, distance, angle = 0) {
  const dx = Math.cos(angle) * distance / 2
  const dy = Math.sin(angle) * distance / 2
  return [{ clientX: x - dx, clientY: y - dy }, { clientX: x + dx, clientY: y + dy }]
}

const originalGetComputedStyle = globalThis.getComputedStyle
globalThis.getComputedStyle = video => video.style
try {
  for (const angle of [0, Math.PI / 2, Math.PI / 4]) {
    for (const [x, y] of [[200, 300], [1000, 300], [200, 700], [1000, 700], [600, 500]]) {
      const f = pinchFixture()
      f.send('touchstart', pair(x, y, 20, angle))
      assert.equal(f.send('touchmove', pair(x, y, 40, angle)).prevented, true)
      const zoomed = f.transform()
      assert.ok(Math.abs(zoomed.scale - 2) < 1e-10)
      assert.ok(Math.abs(600 + zoomed.x + (x - 600) * zoomed.scale - x) < 1e-10, 'horizontal focal point stays under fingers')
      assert.ok(Math.abs(500 + zoomed.y + (y - 500) * zoomed.scale - y) < 1e-10, 'vertical focal point stays under fingers')
      f.send('touchend', [{}])
      f.send('touchstart', pair(600, 500, 100, angle))
      f.send('touchmove', pair(600, 500, 100, angle))
      assert.deepEqual(f.transform(), zoomed, 'a new pinch at another location does not jump')
      f.cleanup()
      assert.equal(f.listeners.size, 0)
      assert.equal(f.video.style.transform, '')
    }
  }

  const f = pinchFixture()
  f.send('touchstart', pair(600, 500, 100))
  f.send('touchmove', pair(600, 500, 110))
  assert.equal(f.messages.at(-1), '1.1x')
  f.send('touchmove', pair(600, 500, 1000))
  assert.equal(f.transform().scale, 8)
  assert.equal(f.messages.at(-1), '8x')
  f.send('touchmove', pair(100000, -100000, 1000))
  assert.deepEqual(f.transform(), { x: 3500, y: -2100, scale: 8 }, 'pan stays within picture bounds')
  f.send('touchend', [{}])
  f.send('touchstart', pair(600, 500, 100))
  f.send('touchmove', pair(600, 500, 1))
  assert.equal(f.video.style.transform, '', '1x restores the original image')
  assert.equal(f.messages.at(-1), '1x')
  f.send('touchstart', pair(600, 500, 0))
  f.send('touchmove', pair(600, 500, 100))
  assert.equal(f.video.style.transform, '', 'coincident fingers cannot create invalid zoom')
  f.send('touchstart', pair(600, 500, 100))
  f.send('touchmove', pair(600, 500, 200))
  f.send('touchend', [{}])
  f.send('touchstart', pair(600, 500, 100))
  f.send('touchmove', pair(700, 550, 100))
  assert.deepEqual(f.transform(), { x: 100, y: 50, scale: 2 }, 'two fingers pan at constant scale')
  f.send('touchcancel', [])
  f.send('touchmove', pair(600, 500, 400))
  assert.deepEqual(f.transform(), { x: 100, y: 50, scale: 2 }, 'cancel ends gesture tracking')
  f.send('touchstart', [...pair(600, 500, 100), { clientX: 650, clientY: 550 }])
  assert.equal(f.send('touchmove', [...pair(600, 500, 200), {}]).prevented, true)
  f.send('touchend', pair(600, 500, 100))
  f.send('touchmove', pair(600, 500, 100))
  assert.deepEqual(f.transform(), { x: 100, y: 50, scale: 2 }, 'returning to two fingers rebases without a jump')
  f.cleanup()
  const messageCount = f.messages.length
  f.send('touchmove', pair(600, 500, 800))
  assert.equal(f.messages.length, messageCount, 'cleanup stops zoom feedback')

  const letterbox = pinchFixture('contain')
  letterbox.send('touchstart', pair(600, 500, 100))
  letterbox.send('touchmove', pair(100000, 100000, 200))
  assert.deepEqual(letterbox.transform(), { x: 500, y: 262.5, scale: 2 }, 'contain bounds use the picture, not scaled black bars')
  letterbox.cleanup()
} finally {
  if (originalGetComputedStyle === undefined) delete globalThis.getComputedStyle
  else globalThis.getComputedStyle = originalGetComputedStyle
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
    case 'multitouch':
      f.send('touchstart', 200, 200)
      f.send('touchstart', 200, 210, { touches: pair(200, 200, 100, Math.PI / 2) })
      f.send('touchmove', 200, 220, { touches: pair(200, 200, 200, Math.PI / 2) })
      f.send('touchend', 200, 230, { touches: [{ clientX: 200, clientY: 100 }] })
      f.send('touchend', 200, 250)
      break
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
