export function isPlayerMenuOpen(container) {
  return Boolean(container.querySelector(
    '.shaka-overflow-menu:not(.shaka-hidden), .shaka-settings-menu:not(.shaka-hidden), .shaka-sub-menu:not(.shaka-hidden)'
  ))
}
