export const DEFAULT_DOWNLOAD_CONCURRENCY = 5

export function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '')
}
