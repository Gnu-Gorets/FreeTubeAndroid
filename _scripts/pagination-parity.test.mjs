import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const searchPage = await readFile(new URL('../src/renderer/views/SearchPage/SearchPage.vue', import.meta.url), 'utf8')
const localApi = await readFile(new URL('../src/renderer/helpers/api/local.js', import.meta.url), 'utf8')
const invidiousApi = await readFile(new URL('../src/renderer/helpers/api/invidious.js', import.meta.url), 'utf8')
const autoLoadWrapper = await readFile(new URL('../src/renderer/components/FtAutoLoadNextPageWrapper.vue', import.meta.url), 'utf8')

assert.match(searchPage, /v-if="!isNextPageLoading && nextPagePossible"/)
assert.match(searchPage, /:enabled="lastSearchHasSomeValidResults"/)
assert.match(searchPage, /if \(apiUsed\.value === 'local'\) \{ return nextPageRef\.value != null \}/)
assert.match(localApi, /const validResultsCount = resultsWithValidTypes\.length/)
assert.match(localApi, /continuationData: response\.has_continuation && results\.length > 0 \? response : null,\s+validResultsCount/)
assert.match(invidiousApi, /const rawResultsCount = results\.length/)
assert.match(invidiousApi, /rawResultsCount,/)
assert.match(autoLoadWrapper, /generalAutoLoadMorePaginatedItemsEnabled\.value && props\.enabled/)
assert.match(searchPage, /lastSearchHasSomeValidResults\.value = history\.lastSearchHasSomeValidResults/)

console.log('pagination parity: PASS')
