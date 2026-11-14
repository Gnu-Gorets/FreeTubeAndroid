import assert from 'node:assert/strict'

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

console.log('player menu test: PASS')
