/**
 * Parse legacy JSON-array and line-delimited playlist exports.
 * @param {string} data
 * @returns {unknown[]}
 */
export function parsePlaylistImportData (data) {
  const trimmedData = data.trim()
  const playlists = trimmedData.startsWith('[') && trimmedData.endsWith(']')
    ? JSON.parse(trimmedData)
    : trimmedData.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))

  if (!Array.isArray(playlists)) {
    throw new TypeError('Playlist data must be an array')
  }

  return playlists
}
