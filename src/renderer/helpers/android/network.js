import android from 'android'

export function getNetworkType() {
  return android?.getNetworkType?.() || 'unknown'
}
