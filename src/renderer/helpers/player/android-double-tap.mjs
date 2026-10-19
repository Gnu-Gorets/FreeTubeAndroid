const TAP_WINDOW = 500
const SCROLL_THRESHOLD = 10

/** Handle side taps independently of Shaka's controls visibility. */
export function addAndroidDoubleTapSeeking (container, controls, seek) {
  let touchStart = null
  let lastTap = null
  let indicator = null
  let indicatorTimer

  function hideIndicator () {
    clearTimeout(indicatorTimer)
    if (!indicator) return
    indicator.style.opacity = '0'
    indicator.querySelector('span').textContent = '0s'
    indicator = null
  }

  function showIndicator (seconds) {
    const element = container.querySelector(seconds < 0 ? '.shaka-rewind-container' : '.shaka-fast-forward-container')
    if (!element) return
    if (indicator !== element) hideIndicator()
    indicator = element
    const value = indicator.querySelector('span')
    value.textContent = `${parseInt(value.textContent, 10) + seconds}s`
    indicator.style.opacity = '1'
    clearTimeout(indicatorTimer)
    indicatorTimer = setTimeout(hideIndicator, TAP_WINDOW)
  }

  function start (event) {
    touchStart = null
    if (event.touches.length !== 1 || controls.isPlayingVR() || controls.anySettingsMenusAreOpen() ||
        event.target.closest('button, input, a, .shaka-bottom-controls, .shaka-top-controls')) {
      lastTap = null
      return
    }

    const touch = event.touches[0]
    const bounds = container.getBoundingClientRect()
    const x = (touch.clientX - bounds.left) / bounds.width
    const direction = x < 0.4 ? -1 : x > 0.6 ? 1 : 0
    if (!direction) {
      lastTap = null
      return
    }
    touchStart = { x: touch.clientX, y: touch.clientY, time: event.timeStamp, direction, moved: false }
  }

  function move (event) {
    if (!touchStart) return
    const touch = event.touches[0]
    if (event.touches.length !== 1 ||
        Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > SCROLL_THRESHOLD) {
      touchStart.moved = true
    }
  }

  function end (event) {
    if (!touchStart) return
    const start = touchStart
    touchStart = null
    event.preventDefault()
    event.stopPropagation()
    if (start.moved || event.timeStamp - start.time >= TAP_WINDOW) {
      lastTap = null
      return
    }

    if (lastTap && lastTap.direction === start.direction && event.timeStamp - lastTap.time < TAP_WINDOW) {
      const seconds = seek(start.direction)
      if (seconds) showIndicator(seconds)
    } else {
      hideIndicator()
      if (controls.isOpaque()) {
        controls.hideUI()
      } else {
        controls.showUI()
      }
    }
    lastTap = { direction: start.direction, time: event.timeStamp }
  }

  function cancel () {
    touchStart = null
    lastTap = null
    hideIndicator()
  }

  container.addEventListener('touchstart', start, { capture: true, passive: true })
  container.addEventListener('touchmove', move, { capture: true, passive: true })
  container.addEventListener('touchend', end, { capture: true, passive: false })
  container.addEventListener('touchcancel', cancel, true)
  return () => {
    container.removeEventListener('touchstart', start, true)
    container.removeEventListener('touchmove', move, true)
    container.removeEventListener('touchend', end, true)
    container.removeEventListener('touchcancel', cancel, true)
    cancel()
  }
}
