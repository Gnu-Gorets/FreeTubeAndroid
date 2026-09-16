import shaka from 'shaka-player'

import i18n from '../../../i18n/index'
import { PlayerIcons } from '../../../../constants'

export class FitScreenButton extends shaka.ui.Element {
  /**
   * @param {boolean} fitScreenEnabled
   * @param {EventTarget} events
   * @param {HTMLElement} parent
   * @param {shaka.ui.Controls} controls
   */
  constructor(fitScreenEnabled, events, parent, controls) {
    super(parent, controls)

    this.button_ = document.createElement('button')
    this.button_.classList.add('fit-screen-button', 'shaka-tooltip')
    this.button_.dataset.test = 'fit-screen'

    this.icon_ = new shaka.ui.Icon(this.button_, PlayerIcons.RECTANGLE_DEFAULT)

    const label = document.createElement('label')
    label.classList.add(
      'shaka-overflow-button-label',
      'shaka-overflow-menu-only',
      'shaka-simple-overflow-button-label-inline'
    )

    this.nameSpan_ = document.createElement('span')
    label.appendChild(this.nameSpan_)

    this.currentState_ = document.createElement('span')
    this.currentState_.classList.add('shaka-current-selection-span')
    label.appendChild(this.currentState_)

    this.button_.appendChild(label)
    this.parent.appendChild(this.button_)
    this.fitScreenEnabled_ = fitScreenEnabled

    this.eventManager.listen(this.button_, 'click', () => {
      events.dispatchEvent(new CustomEvent('toggleFitScreen', {
        detail: !this.fitScreenEnabled_
      }))
    })

    this.eventManager.listen(events, 'setFitScreen', (/** @type {CustomEvent} */ event) => {
      this.fitScreenEnabled_ = event.detail
      this.updateLocalisedStrings_()
    })

    this.eventManager.listen(events, 'localeChanged', () => {
      this.updateLocalisedStrings_()
    })

    this.updateLocalisedStrings_()
  }

  updateLocalisedStrings_() {
    this.icon_.use(this.fitScreenEnabled_ ? PlayerIcons.VARIABLES_DEFAULT : PlayerIcons.RECTANGLE_DEFAULT)
    this.nameSpan_.textContent = i18n.global.t('Settings.Player Settings.Fit Video to Fullscreen')
    this.currentState_.textContent = this.localization.resolve(this.fitScreenEnabled_ ? 'ON' : 'OFF')
    this.button_.ariaLabel = this.nameSpan_.textContent
    this.button_.ariaPressed = String(this.fitScreenEnabled_)
  }
}
