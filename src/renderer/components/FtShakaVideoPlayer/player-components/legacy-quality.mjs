export function getUniqueLegacyFormats (formats) {
  const uniqueFormats = new Map()

  for (const format of formats) {
    const current = uniqueFormats.get(format.qualityLabel)
    if (!current || format.bitrate > current.bitrate) {
      uniqueFormats.set(format.qualityLabel, format)
    }
  }

  const sortedFormats = [...uniqueFormats.values()]

  if (sortedFormats.length > 0) {
    const isPortrait = sortedFormats[0].height > sortedFormats[0].width
    sortedFormats.sort((a, b) => isPortrait ? b.width - a.width : b.height - a.height)
  }

  return sortedFormats
}
