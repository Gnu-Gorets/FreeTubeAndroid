import android from 'android'

function isDark(color) {
  const value = color.match(/\d+/g)?.map(Number) || [0, 0, 0]
  return (value[0] * 299 + value[1] * 587 + value[2] * 114) < 128000
}

export function updateAndroidTheme(usesMain = false) {
  const style = getComputedStyle(document.body)
  const top = usesMain
    ? style.getPropertyValue('--primary-color')
    : style.getPropertyValue('--card-bg-color')
  const bottom = style.getPropertyValue('--side-nav-color')
  android.themeSystemUi(bottom, top, isDark(bottom), isDark(top))
}

export function getConsoleLogs() {
  return JSON.parse(android.getLogs())
}
