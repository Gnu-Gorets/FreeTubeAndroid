import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const downloadsVue = await readFile(new URL('../src/renderer/views/Downloads/Downloads.vue', import.meta.url), 'utf8')
const subscriptionsVue = await readFile(new URL('../src/renderer/views/Subscriptions/Subscriptions.vue', import.meta.url), 'utf8')
const downloadsCss = downloadsVue.match(/\.card \{[\s\S]*?\n\}/)?.[0]
const subscriptionsCss = await readFile(new URL('../src/renderer/views/Subscriptions/Subscriptions.css', import.meta.url), 'utf8')
const subscriptionsCardCss = subscriptionsCss.match(/\.card \{[\s\S]*?\n\}/)?.[0]

test('Downloads uses same card geometry as Subscriptions', () => {
  assert.match(downloadsVue, /<FtCard class="card">/)
  assert.doesNotMatch(downloadsVue, /\.downloadsView\s*\{[^}]*width:\s*100%/)
  assert.match(subscriptionsVue, /<FtCard class="card">/)
  assert.equal(downloadsCardGeometry(downloadsCss), downloadsCardGeometry(subscriptionsCardCss))
})

function downloadsCardGeometry(css) {
  return css
    .replace(/\s+/g, ' ')
    .trim()
}
