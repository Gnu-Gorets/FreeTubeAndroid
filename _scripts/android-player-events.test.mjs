import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../src/renderer/components/ft-shaka-video-player/ft-shaka-video-player.js', import.meta.url), 'utf8')
const handlers = source.slice(source.indexOf('    function startPowerSaveBlocker()'), source.indexOf('    function updateVolume()'))

function fixture(isAndroid = true) {
  const calls = []
  const video = {
    value: {
      currentTime: 12.345,
      paused: true,
      play: () => {
        calls.push('play')
        return Promise.resolve()
      },
      pause: () => calls.push('pause')
    }
  }
  const context = {
    process: { env: { IS_ANDROID: isAndroid, IS_ELECTRON: false } },
    video,
    props: { autoplayOnLoad: false, format: 'legacy' },
    startInPip: false,
    navigator: { mediaSession: {} },
    android: {
      enableKeepScreenOn: () => calls.push('screen-on'),
      disableKeepScreenOn: () => calls.push('screen-off')
    },
    updateMediaSessionState: (...args) => calls.push(args),
    STATE_PLAYING: 3,
    STATE_PAUSED: 2,
    STATE_NONE: 0,
    emit: (...args) => calls.push(args),
    isBuffering: { value: true },
    canSeek: () => true,
    defaultSkipInterval: { value: 10 },
    seekBySeconds: (...args) => calls.push(args),
    clearInterval: () => calls.push('clear-seek'),
    setInterval: callback => { context.repeatSeek = callback },
    enterFullscreenOnDisplayRotate: { value: true },
    document: {
      fullscreenElement: {},
      exitFullscreen: () => {
        calls.push('exit-fullscreen')
        return Promise.resolve()
      }
    },
    ui: { configure: config => calls.push(config.enableFullscreenOnRotation) },
    console
  }
  runInNewContext(handlers, context)
  return { context, calls, video }
}

test('Android playback updates native state, screen and browser session', () => {
  const { context, calls } = fixture()
  context.handlePlay()
  assert.deepEqual(calls, [['play'], 'screen-on', [3]])
  assert.equal(context.navigator.mediaSession.playbackState, 'playing')
  calls.length = 0
  context.handlePause()
  assert.deepEqual(calls, ['screen-off', [2, 12345]])
  assert.equal(context.navigator.mediaSession.playbackState, 'paused')
  calls.length = 0
  context.handleEnded()
  assert.deepEqual(calls, ['screen-off', [0, 12345], ['ended']])
  assert.equal(context.navigator.mediaSession.playbackState, 'none')
})

test('non-Android playback does not call the native bridge', () => {
  const { context, calls } = fixture(false)
  context.handlePlay()
  context.handlePause()
  context.handleEnded()
  assert.deepEqual(calls, [['play'], ['ended']])
})

test('headset seeking validates positions and uses the configured interval', () => {
  const { context, calls, video } = fixture()
  context.handleMediaPlay()
  context.handleMediaPause()
  assert.deepEqual(calls, ['play', 'pause'])
  context.handleMediaSeek({ detail: { position: 30000 } })
  assert.equal(video.value.currentTime, 30)
  for (const position of [NaN, Infinity, '1000', undefined]) {
    context.handleMediaSeek({ detail: { position } })
    assert.equal(video.value.currentTime, 30)
  }
  context.canSeek = () => false
  context.handleMediaSeek({ detail: { position: 1000 } })
  assert.equal(video.value.currentTime, 30)
  context.handleMediaSeekForward()
  assert.deepEqual(calls, ['play', 'pause'])
  context.canSeek = () => true
  calls.length = 0
  context.handleMediaSeekForward()
  context.handleMediaSeekBackward()
  context.handleMediaSeekForwardStart()
  context.repeatSeek()
  context.handleMediaSeekStop()
  assert.deepEqual(calls, [[10, true], [-10, true], 'clear-seek', [10, true], [1, true], 'clear-seek'])
})

test('app pause exits fullscreen without pausing background playback', () => {
  const { context, calls } = fixture()
  context.handleAppPause()
  context.handleAppResume()
  assert.deepEqual(calls, ['exit-fullscreen', false, true])
})

test('download autoplay overrides the global setting only when requested', () => {
  const { context, calls } = fixture()
  context.handleCanPlay()
  assert.deepEqual(calls, [])
  assert.equal(context.isBuffering.value, false)
  context.props.autoplayOnLoad = true
  context.handleCanPlay()
  assert.deepEqual(calls, ['play'])
  context.video.value.paused = false
  context.handleCanPlay()
  assert.deepEqual(calls, ['play'])
})

test('long press restores the original rate and ignores controls and mouse input', () => {
  let timer
  const video = { value: { paused: false, playbackRate: 1.25 } }
  const context = {
    process: { env: { IS_ANDROID: true } },
    video,
    maxVideoPlaybackRate: { value: 1.5 },
    setTimeout: callback => { timer = callback },
    clearTimeout: () => { timer = null },
    showValueChange: () => {}
  }
  runInNewContext(source.slice(source.indexOf('    let longPressTimer'), source.indexOf('    function addLongPressPlaybackListeners')), context)
  const event = { pointerType: 'touch', target: { closest: () => false } }
  context.startLongPressPlayback(event)
  timer()
  assert.equal(video.value.playbackRate, 1.5)
  context.stopLongPressPlayback()
  assert.equal(video.value.playbackRate, 1.25)
  assert.equal(timer, null)
  for (const blocked of [
    { ...event, pointerType: 'mouse' },
    { ...event, target: { closest: () => true } }
  ]) {
    context.startLongPressPlayback(blocked)
    assert.equal(timer, null)
  }
})

test('Android uses native PiP and overflow Stats without changing desktop PiP', () => {
  const configSource = source.match(/ {4}const uiConfig = computed\(\(\) => \{[\s\S]*?\n {4}\}\)/)[0]
  for (const isAndroid of [true, false]) {
    for (const format of ['legacy', 'dash', 'audio']) {
      const config = runInNewContext(`${configSource}\nuiConfig.value`, {
        process: { env: { IS_ANDROID: isAndroid } },
        computed: callback => ({ value: callback() }),
        props: { format, captions: [], chapters: [] },
        hasMultipleAudioTracks: { value: false },
        TrackLabelFormat: {},
        useVrMode: { value: false },
        onlyUseOverFlowMenu: { value: true },
        enableScreenshot: { value: false },
        isLive: { value: false },
        seekingIsPossible: { value: true },
        removeFromArrayIfExists: (items, item) => {
          const index = items.indexOf(item)
          if (index >= 0) items.splice(index, 1)
        }
      })
      assert.equal(config.controlPanelElements.includes('ft_picture_in_picture'), isAndroid && format !== 'audio')
      assert.equal(config.overflowMenuButtons.includes('picture_in_picture'), !isAndroid && format !== 'audio')
      assert.equal(config.overflowMenuButtons.includes('ft_stats'), isAndroid)
      assert.equal(config.controlPanelElements.includes('ft_fit_screen'), format !== 'audio')
    }
  }
})
