export function getVideoResolutionLabel (track, tracks) {
  let { width, height } = track

  if (!width || !height) {
    return track.bandwidth
      ? track.bandwidth >= 1e6 ? `${(track.bandwidth / 1e6).toFixed(1).replace('.0', '')} Mbps` : `${Math.floor(track.bandwidth / 1e3)} Kbps`
      : 'Unknown'
  }

  if (height > width) {
    [width, height] = [height, width]
  }

  if (width / height > 16 / 9) {
    height = Math.round(width * 9 / 16)
  }

  let label = `${height}p`
  const frameRates = new Set(tracks.filter(item => item.frameRate).map(item => Math.round(item.frameRate)))
  const frameRate = Math.round(track.frameRate || 0)

  if (frameRates.size > 1 && frameRate > 30) {
    label += frameRate
  }

  if (track.hdr === 'PQ' || track.hdr === 'HLG') {
    label += ' HDR'
  }

  return label
}

export function getQualityMark (width, height, qualityMarks) {
  if (!width || !height) return ''

  let trackHeight = height
  let trackWidth = width
  if (trackHeight > trackWidth) {
    [trackWidth, trackHeight] = [trackHeight, trackWidth]
  }

  if (trackWidth / trackHeight > 16 / 9) {
    trackHeight = Math.round(trackWidth * 9 / 16)
  }

  if (trackHeight >= 8640) return `${trackHeight}p`
  if (trackHeight >= 4320) return qualityMarks['4320']
  if (trackHeight >= 2160) return qualityMarks['2160']
  if (trackHeight >= 1440) return qualityMarks['1440']
  if (trackHeight >= 1080) return qualityMarks['1080']
  if (trackHeight >= 720) return qualityMarks['720']
  return ''
}

export function getUniqueVideoTracks (tracks) {
  const selectedTrack = tracks.find(track => track.active)
  const filteredTracks = selectedTrack
    ? tracks.filter(track => track.language === selectedTrack.language &&
      track.label === selectedTrack.label &&
      (track.roles || []).length === (selectedTrack.roles || []).length &&
      (track.roles || []).every(role => (selectedTrack.roles || []).includes(role)))
    : tracks
  const selectedLabel = selectedTrack ? getVideoResolutionLabel(selectedTrack, filteredTracks) : null
  const uniqueTracks = new Map()

  for (const track of filteredTracks) {
    const label = getVideoResolutionLabel(track, filteredTracks)
    const current = uniqueTracks.get(label)

    if (!current || track.bandwidth > current.bandwidth) {
      uniqueTracks.set(label, track)
    }
  }

  return [...uniqueTracks.entries()]
    .sort(([labelA, trackA], [labelB, trackB]) => {
      const heightA = parseInt(labelA)
      const heightB = parseInt(labelB)
      return Number.isNaN(heightA) || Number.isNaN(heightB)
        ? trackB.bandwidth - trackA.bandwidth
        : heightB - heightA || trackB.bandwidth - trackA.bandwidth
    })
    .map(([label, track]) => ({ label, track, selected: label === selectedLabel }))
}
