export function selectExternalStreams(info, targetQuality, originalAudioLanguage) {
  const formatUrl = format => format.freeTubeUrl ?? format.url
  const hasVideo = format => format.has_video || (format.width ?? 0) > 0 || format.mime_type?.startsWith('video/')
  const hasAudio = format => format.has_audio || format.mime_type?.startsWith('audio/')
  const hasUrl = format => /^https?:\/\//.test(formatUrl(format) ?? '')
  const selectVideo = formats => {
    const suitable = formats.filter(format => (format.height ?? 0) <= targetQuality)
    return [...(suitable.length ? suitable : formats)]
      .sort((a, b) => suitable.length ? (b.height ?? 0) - (a.height ?? 0) : (a.height ?? 0) - (b.height ?? 0))[0]
  }
  const progressive = selectVideo((info.streaming_data?.formats ?? [])
    .filter(format => hasVideo(format) && hasAudio(format) && hasUrl(format)))
  const adaptiveFormats = (info.streaming_data?.adaptive_formats ?? []).filter(hasUrl)
  const video = selectVideo(adaptiveFormats.filter(hasVideo))
  const audioFormats = adaptiveFormats.filter(format => hasAudio(format) && !hasVideo(format))
  const originalAudioFormats = audioFormats.filter(format => {
    return format.is_original === true || (originalAudioLanguage && format.language === originalAudioLanguage)
  })
  const audio = [...(originalAudioFormats.length ? originalAudioFormats : audioFormats)]
    .sort((a, b) => {
      const aIsMp4 = a.mime_type?.startsWith('audio/mp4') ? 1 : 0
      const bIsMp4 = b.mime_type?.startsWith('audio/mp4') ? 1 : 0
      return bIsMp4 - aIsMp4 || (b.bitrate ?? 0) - (a.bitrate ?? 0)
    })[0]

  if (video && audio) {
    return {
      maxQuality: video.height ?? targetQuality,
      externalStreams: {
        videoUrl: formatUrl(video),
        audioUrl: formatUrl(audio),
        videoWidth: video.width,
        videoHeight: video.height,
        videoMimeType: video.mime_type,
        videoBandwidth: video.bitrate,
        videoInitRange: video.init_range,
        videoIndexRange: video.index_range,
        audioMimeType: audio.mime_type,
        audioBandwidth: audio.bitrate,
        audioInitRange: audio.init_range,
        audioIndexRange: audio.index_range,
        audioSampleRate: audio.audio_sample_rate,
        audioChannels: audio.audio_channels,
        durationSeconds: Number(info.basic_info?.duration ?? 0)
      }
    }
  }
  if (progressive) {
    return {
      maxQuality: targetQuality,
      mediaUrl: formatUrl(progressive),
      mediaMimeType: progressive.mime_type
    }
  }
  throw new Error('No playable video with audio')
}
