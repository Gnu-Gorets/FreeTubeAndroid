import shaka from 'shaka-player'

export class PictureInPictureButton extends shaka.ui.Element {
  /**
   * @param {EventTarget} events
   * @param {HTMLElement} parent
   * @param {shaka.ui.Controls} controls
   */
  constructor(events, parent, controls) {
    super(parent, controls)

    this.button_ = document.createElement('button')
    this.button_.classList.add('shaka-pip-button', 'shaka-tooltip')
    // eslint-disable-next-line no-new
    new shaka.ui.Icon(this.button_, shaka.ui.Enums.MaterialDesignSVGIcons.PIP)
    this.parent.appendChild(this.button_)

    this.eventManager.listen(this.button_, 'click', () => {
      if (this.controls.isOpaque()) window.Android?.enterPictureInPicture(!document.querySelector('video.player')?.paused)
    })
    this.eventManager.listen(events, 'localeChanged', () => this.updateLocalizedStrings_())
    this.updateLocalizedStrings_()
  }

  updateLocalizedStrings_() {
    this.button_.ariaLabel = this.localization.resolve('ENTER_PICTURE_IN_PICTURE').replace(/\s+\([^)]+\)$/, '')
  }
}
