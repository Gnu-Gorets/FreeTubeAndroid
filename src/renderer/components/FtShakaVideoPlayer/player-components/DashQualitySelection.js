import shaka from 'shaka-player'

import { PlayerIcons } from '../../../../constants'
import { getQualityMark, getUniqueVideoTracks } from './dash-quality.mjs'

export class DashQualitySelection extends shaka.ui.SettingsMenu {
  constructor (parent, controls) {
    super(parent, controls, PlayerIcons.TUNE_FILLED)

    this.button.classList.add('shaka-resolution-button', 'shaka-tooltip-status')
    this.menu.classList.add('shaka-resolutions')
    this.overflowQualityMark = parent.parentElement?.querySelector('.shaka-overflow-quality-mark')

    this.eventManager.listenMulti(this.player, [
      'loading',
      'loaded',
      'unloading',
      'variantchanged',
      'trackschanged',
      'abrstatuschanged',
      'adaptation'
    ], () => this.updateSelection_())

    this.updateSelection_()
  }

  updateSelection_ () {
    for (const child of [...this.menu.children]) {
      if (child !== this.backButton) child.remove()
    }

    const videoTracks = this.player.getVideoTracks() || []
    const tracks = getUniqueVideoTracks(videoTracks)
    const abrEnabled = this.player.getConfiguration().abr.enabled
    const activeTrack = videoTracks.find(track => track.active)
    const { width, height } = activeTrack || this.player.getStats()
    const currentQualityMark = getQualityMark(width, height, this.controls.getConfig().qualityMarks)

    if (this.overflowQualityMark) {
      this.overflowQualityMark.textContent = currentQualityMark
      this.overflowQualityMark.style.display = currentQualityMark ? '' : 'none'
    }
    for (const { label, track, selected } of tracks) {
      const button = document.createElement('button')
      button.role = 'menuitemradio'
      button.ariaChecked = 'false'
      button.classList.add('explicit-resolution')
      button.addEventListener('click', () => {
        this.player.configure({ abr: { enabled: false } })
        this.player.selectVideoTrack(track, this.controls.getConfig().clearBufferOnQualityChange)
      })

      const span = document.createElement('span')
      span.textContent = label
      button.appendChild(span)

      const qualityMark = getQualityMark(track.width, track.height, this.controls.getConfig().qualityMarks)
      if (qualityMark) {
        const mark = document.createElement('sup')
        mark.classList.add('shaka-quality-mark')
        mark.textContent = qualityMark
        button.appendChild(mark)
      }

      if (!abrEnabled && selected) {
        button.ariaChecked = 'true'
        span.classList.add('shaka-chosen-item')
        button.appendChild(this.createCheckmark_())
        this.currentSelection.textContent = label
      }

      this.menu.appendChild(button)
    }

    const autoButton = document.createElement('button')
    autoButton.role = 'menuitemradio'
    autoButton.ariaChecked = String(abrEnabled)
    autoButton.classList.add('shaka-enable-abr-button')
    autoButton.addEventListener('click', () => {
      this.player.configure({ abr: { enabled: true } })
      this.updateSelection_()
    })

    const autoSpan = document.createElement('span')
    autoSpan.textContent = this.localization.resolve('AUTO_QUALITY')
    autoButton.appendChild(autoSpan)

    if (abrEnabled) {
      autoSpan.classList.add('shaka-chosen-item')
      autoButton.appendChild(this.createCheckmark_())
      this.currentSelection.textContent = autoSpan.textContent
    }

    this.menu.appendChild(autoButton)
    this.button.setAttribute('shaka-status', this.currentSelection.textContent)
    this.button.classList.toggle('shaka-hidden', tracks.length === 0 || this.isSubMenuOpened)
    this.updateLocalizedStrings()
  }

  createCheckmark_ () {
    const checkmark = new shaka.ui.Icon(null, PlayerIcons.DONE_FILLED).getSvgElement()
    checkmark.classList.add('shaka-chosen-item')
    checkmark.ariaHidden = 'true'
    return checkmark
  }

  updateLocalizedStrings () {
    const label = this.localization.resolve('RESOLUTION')
    this.button.ariaLabel = label
    this.backButton.ariaLabel = this.localization.resolve('BACK')
    this.backSpan.textContent = this.backButton.ariaLabel
    this.nameSpan.textContent = label
  }
}
