import { Mixins, YTNodes } from 'youtubei.js'

/**
 * Build search continuation without YT.Search, which expects a reload command
 * while YouTube may return appendContinuationItemsAction for the same request.
 *
 * @param {import('youtubei.js').Actions} actions
 * @param {object} page
 */
export function createLocalSearchContinuation(actions, page) {
  const feed = new Mixins.Feed(actions, page, true)
  feed.results = feed.memo.getType(YTNodes.ItemSection).flatMap((section) => section.contents)
  return feed
}
