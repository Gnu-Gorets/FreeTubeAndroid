export function normalizeDownloadSize (value) {
  if (value === undefined || value === null || String(value).trim() === '') return -1
  const bytes = Number(value)
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : -1
}

export function formatDownloadSpeed (bytesPerSecond) {
  const mib = Number(bytesPerSecond) / 1024 ** 2
  if (!Number.isFinite(mib) || mib < 0) return '? MiB'
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`
}
