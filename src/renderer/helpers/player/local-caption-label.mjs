export function getLocalCaptionLabel(caption) {
  return caption.name ? caption.name.text : caption.language_code
}
