export function getAudioFormatsForTrack(formats, trackId, videoMimeType = '', sortBy = 'bitrate') {
  const audioMimeType = videoMimeType === 'video/mp4'
    ? 'audio/mp4'
    : videoMimeType === 'video/webm' ? 'audio/webm' : null
  return formats
    .filter(format => format.kind === 'audio' && format.audioTrackId === trackId)
    .filter(format => !audioMimeType || format.mimeType === audioMimeType)
    .sort(sortBy === 'size' ? compareAudioSizes : compareAudioFormats)
}

export function compareLabels(left, right) {
  return String(left.label || '').localeCompare(String(right.label || ''), undefined, { sensitivity: 'base' })
}

export function compareVideoFormats(left, right) {
  const containerDifference = Number(right.mimeType === 'video/mp4') - Number(left.mimeType === 'video/mp4')
  if (containerDifference) return containerDifference
  const heightDifference = Number(right.height || 0) - Number(left.height || 0)
  if (heightDifference) return heightDifference
  return Number(right.size || 0) - Number(left.size || 0)
}

export function compareAudioFormats(left, right) {
  const bitrateDifference = Number(right.bitrate || 0) - Number(left.bitrate || 0)
  if (bitrateDifference) return bitrateDifference
  return Number(right.size || 0) - Number(left.size || 0)
}

export function compareAudioSizes(left, right) {
  const containerDifference = Number(right.mimeType === 'audio/mp4') - Number(left.mimeType === 'audio/mp4')
  if (containerDifference) return containerDifference
  const sizeDifference = Number(right.size || 0) - Number(left.size || 0)
  if (sizeDifference) return sizeDifference
  return Number(right.bitrate || 0) - Number(left.bitrate || 0)
}
