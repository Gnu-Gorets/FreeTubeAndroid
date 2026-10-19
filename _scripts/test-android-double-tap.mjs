import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { addAndroidDoubleTapSeeking } from '../src/renderer/helpers/player/android-double-tap.mjs'

function fixture(shown = false) {
  const listeners = new Map()
  const seeks = []
  const controls = {
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
    getBoundingClientRect: () => ({ left: 100, width: 1000 }),
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      assert.equal(listeners.get(type), listener)
      listeners.delete(type)
    }
  }
  const cleanup = addAndroidDoubleTapSeeking(container, controls, direction => seeks.push(direction))
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
  return { controls, seeks, send, tap, cleanup, listeners }
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
    f.tap(x, 400)
    assert.deepEqual(f.seeks, [direction, direction], 'each extra tap seeks again')
    f.cleanup()
    assert.equal(f.listeners.size, 0)
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

const source = await readFile('src/renderer/components/ft-shaka-video-player/ft-shaka-video-player.js', 'utf8')
assert.match(source, /if \(process\.env\.IS_ANDROID\) firstTimeConfig\.seekOnTaps = false/)
assert.match(source, /seekBySeconds\(direction \* defaultSkipInterval\.value, false, true\)/)
assert.match(source, /if \(!process\.env\.IS_ANDROID\) return\n\s+removeLongPressPlaybackListeners\(\)/)
assert.match(source, /removeDoubleTapSeeking\(\)/)
console.log('Android double-tap seeking: PASS')
