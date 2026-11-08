export function normalizeDownloadSize (value) {
  if (value === undefined || value === null || String(value).trim() === '') return -1
  const bytes = Number(value)
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : -1
}

export function sumDownloadSizes (...values) {
  const sizes = values.map(normalizeDownloadSize)
  if (!sizes.every(size => size >= 0)) return -1
  const total = sizes.reduce((sum, size) => sum + size, 0)
  return Number.isSafeInteger(total) ? total : -1
}

export function formatDownloadSize (value) {
  const bytes = normalizeDownloadSize(value)
  if (bytes < 0) return '? MiB'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let amount = bytes
  let unit = 'B'
  for (const nextUnit of units) {
    amount /= 1024
    unit = nextUnit
    if (amount < 1024 || nextUnit === units.at(-1)) break
  }
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${unit}`
}

export function formatDownloadSpeed (bytesPerSecond) {
  const mib = Number(bytesPerSecond) / 1024 ** 2
  if (!Number.isFinite(mib) || mib < 0) return '? MiB'
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`
}
