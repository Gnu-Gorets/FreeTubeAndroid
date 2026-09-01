export function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '')
}
