import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compile } from 'vue'

test('mobile settings search result adds a section history entry', async () => {
  const settingsView = await readFile(new URL('../src/renderer/views/Settings/Settings.vue', import.meta.url), 'utf8')
  const selection = settingsView.match(/async function selectSearchResult\(result\) \{([\s\S]*?)\n\}/)?.[1]

  assert.ok(selection)
  assert.match(selection, /if \(!isInDesktopView\.value\) \{\s*pushState\(`#\$\{result\.sectionType\}`\)\s*settingsSectionTypeOpenInMobile\.value = result\.sectionType\s*\}/)
  assert.match(settingsView, /history\.pushState\(\{\}, null, `#\/settings\$\{path\}`\)/)
})

test('shared settings controls expose their displayed label to search', async () => {
  for (const component of ['FtInput', 'FtSelect', 'FtSlider', 'FtToggleSwitch']) {
    const source = await readFile(new URL(`../src/renderer/components/${component}/${component}.vue`, import.meta.url), 'utf8')
    const expression = source.match(/:data-settings-search-label="([^"]+)"/)?.[1]
    assert.ok(expression, `${component} must be indexed by settings search`)
    const render = compile(`<div :data-settings-search-label="${expression}" />`)
    const props = { showLabel: true, label: 'Visible label', placeholder: 'Placeholder' }
    assert.equal(render(props).props['data-settings-search-label'], component === 'FtSelect' ? 'Placeholder' : 'Visible label')
    if (component === 'FtInput') {
      props.showLabel = false
      assert.equal(render(props).props['data-settings-search-label'], 'Placeholder')
      props.showLabel = true
      props.label = ''
      assert.equal(render(props).props['data-settings-search-label'], 'Placeholder')
    }
  }
})
