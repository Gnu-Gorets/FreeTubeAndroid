window.addEventListener('message', (event) => {
  const id = event.id
  const code = Android.readSync(id)
  try {
    const result = new Function(code)()
    console.log(`[Android decipher] ${id}: ${typeof result} ${String(result).slice(0, 120)}`)
    Android.resolve(id, JSON.stringify(result))
  } catch (error) {
    console.error(`[Android decipher] ${id}: ${error}`)
    Android.reject(id, error.toString())
  }
})
