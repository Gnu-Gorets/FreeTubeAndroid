import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

import { isPlayerMenuOpen } from '../src/renderer/helpers/player/player-menu.mjs'

const menu = hidden => ({
  classList: { contains: name => hidden && name === 'shaka-hidden' }
})

const container = menus => ({
  querySelector: selector => {
    assert.match(selector, /shaka-overflow-menu/)
    return menus.find(element => !element.classList.contains('shaka-hidden')) || null
  }
})

assert.equal(isPlayerMenuOpen(container([menu(true)])), false)
assert.equal(isPlayerMenuOpen(container([menu(false)])), true)
assert.equal(isPlayerMenuOpen(container([menu(true), menu(false)])), true)

const stats = await readFile(new URL('../src/renderer/components/ft-shaka-video-player/player-components/StatsButton.js', import.meta.url), 'utf8')
const listeners = stats.match(/ {4}this\.eventManager\.listen\(controls, 'submenu(?:open|close)', \(\) => \{[\s\S]*?\n {4}\}\)/g)
assert.equal(listeners?.length, 2)
const controls = new EventTarget()
const classes = new Set()
const button = {
  button_: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
  eventManager: { listen: (target, event, handler) => target.addEventListener(event, handler) }
}
runInNewContext(`(function () { ${listeners.join('\n')} }).call(button)`, { button, controls })
controls.dispatchEvent(new Event('submenuopen'))
assert.equal(classes.has('shaka-hidden'), true)
controls.dispatchEvent(new Event('submenuclose'))
assert.equal(classes.has('shaka-hidden'), false)

console.log('player menu test: PASS')
