export function getAudioFormatsForTrack(formats, trackId, videoMimeType = '', sortBy = 'bitrate') {
  const audioMimeType = videoMimeType === 'video/mp4' ? 'audio/mp4' : null
  return formats
    .filter(format => format.kind === 'audio' && format.audioTrackId === trackId)
    .filter(format => !audioMimeType || format.mimeType === audioMimeType)
    .sort(sortBy === 'size' ? compareAudioSizes : compareAudioFormats)
}

export function compareAudioFormats(left, right) {
  const bitrateDifference = Number(right.bitrate || 0) - Number(left.bitrate || 0)
  if (bitrateDifference) return bitrateDifference
  return Number(right.size || 0) - Number(left.size || 0)
}

export function compareAudioSizes(left, right) {
  const sizeDifference = Number(right.size || 0) - Number(left.size || 0)
  if (sizeDifference) return sizeDifference
  return Number(right.bitrate || 0) - Number(left.bitrate || 0)
}
