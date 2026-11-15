/**
 * Parse channel IDs from current and legacy hidden-channel settings.
 * @param {string} channelsHiddenJson
 * @returns {Set<string>}
 */
export function getChannelsHiddenIdSet (channelsHiddenJson) {
  const channelsHidden = JSON.parse(channelsHiddenJson)
  const set = new Set()

  for (const channel of channelsHidden) {
    if (typeof channel === 'string') {
      set.add(channel)
    } else if (channel && typeof channel.name === 'string') {
      set.add(channel.name)
    }
  }

  return set
}
