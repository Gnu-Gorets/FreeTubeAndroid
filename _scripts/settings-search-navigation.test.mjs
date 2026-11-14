import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('mobile settings search result adds a section history entry', async () => {
  const settingsView = await readFile(new URL('../src/renderer/views/Settings/Settings.vue', import.meta.url), 'utf8')
  const selection = settingsView.match(/async function selectSearchResult\(result\) \{([\s\S]*?)\n\}/)?.[1]

  assert.ok(selection)
  assert.match(selection, /if \(!isInDesktopView\.value\) \{\s*pushState\(`#\$\{result\.sectionType\}`\)\s*settingsSectionTypeOpenInMobile\.value = result\.sectionType\s*\}/)
  assert.match(settingsView, /history\.pushState\(\{\}, null, `#\/settings\$\{path\}`\)/)
})
