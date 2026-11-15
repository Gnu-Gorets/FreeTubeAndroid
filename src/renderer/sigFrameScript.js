// This is injected into the sigFrame iframe
// See index.ejs and webpack.renderer.config.js
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || typeof event.data !== 'string') {
    return
  }

  let data
  try {
    data = JSON.parse(event.data)
    if (typeof data.id !== 'string' || typeof data.code !== 'string') {
      return
    }

    window.parent.postMessage(JSON.stringify({
      id: data.id,
      // Run player code only in this sandboxed iframe with an opaque origin.
      // eslint-disable-next-line no-new-func
      result: new Function(data.code)() // codeql[js/code-injection]
    }), '*')
  } catch (error) {
    window.parent.postMessage(JSON.stringify({
      id: data.id,
      error: error.toString()
    }), '*')
  }
})
