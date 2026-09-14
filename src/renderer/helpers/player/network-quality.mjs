export function getDefaultQualityForNetwork(networkType, wifiQuality, mobileQuality, fallback) {
  switch (networkType) {
    case 'wifi':
      return wifiQuality
    case 'mobile':
      return mobileQuality
    default:
      return fallback
  }
}
