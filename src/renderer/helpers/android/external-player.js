import store from '../../store/index'
import i18n from '../../i18n/index'
import { getLocalVideoInfo, getOriginalVideoLanguage } from '../api/local'
import { copyToClipboard, openExternalPlayer, showToast } from '../utils'
import { getNetworkType } from './network'
import { getDefaultQualityForNetwork } from '../player/network-quality.mjs'
import { selectExternalStreams } from '../player/external-streams.mjs'

export async function openAndroidExternalPlayer(payload) {
  try {
    const { info, clientInfo } = await getLocalVideoInfo(payload.videoId)
    const networkType = getNetworkType()
    const configuredQuality = Number(getDefaultQualityForNetwork(
      networkType,
      store.getters.getWifiDefaultQuality,
      store.getters.getMobileDefaultQuality,
      720
    ))
    const targetQuality = Number.isFinite(configuredQuality) && configuredQuality > 0 ? configuredQuality : 720
    const media = selectExternalStreams(info, targetQuality, getOriginalVideoLanguage(info))
    console.warn('[ExternalPlayer] stream-selected', JSON.stringify({
      networkType,
      targetQuality,
      selectedHeight: media.externalStreams?.videoHeight ?? null
    }))
    return openExternalPlayer({
      ...payload,
      ...media,
      externalHeaders: clientInfo
        ? {
            'X-Goog-Visitor-Id': clientInfo.visitorData,
            'X-YouTube-Client-Name': String(clientInfo.clientName),
            'X-YouTube-Client-Version': clientInfo.clientVersion
          }
        : null
    })
  } catch (error) {
    console.warn('Failed to resolve external player stream', error)
    showToast(`${i18n.global.t('Local API Error (Click to copy)')}: ${error}`, 10000, () => {
      copyToClipboard(String(error))
    })
  }
}
