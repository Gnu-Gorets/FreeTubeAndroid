export function getCaptionTrackLanguage (track) {
  if (track && track.name && track.name.text) return track.name.text
  return track && track.language_code ? track.language_code : ''
}

export function getCaptionLanguageName (language) {
  if (language && language.language_name && language.language_name.text) return language.language_name.text
  return language && language.language_code ? language.language_code : ''
}
