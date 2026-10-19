import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { addAndroidDoubleTapSeeking } from '../src/renderer/helpers/player/android-double-tap.mjs'

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

const source = await readFile('src/renderer/components/ft-shaka-video-player/ft-shaka-video-player.js', 'utf8')
assert.match(source, /if \(process\.env\.IS_ANDROID\) firstTimeConfig\.seekOnTaps = true/)
assert.match(source, /const seconds = direction \* defaultSkipInterval\.value\n\s+seekBySeconds\(seconds, true\)\n\s+return seconds/)
assert.match(source, /if \(!process\.env\.IS_ANDROID\) return\n\s+removeLongPressPlaybackListeners\(\)/)
assert.match(source, /removeDoubleTapSeeking\(\)/)
console.log('Android double-tap seeking: PASS')
