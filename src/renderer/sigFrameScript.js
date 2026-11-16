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
      // YouTube rotates decoder functions; static command allowlists cannot replace evaluation.
      // Opaque iframe origin differs from parent; validate event.source instead of event.origin.
      // eslint-disable-next-line no-new-func
      result: new Function(data.code)() // codeql[js/code-injection]
    }), '*')
  } catch (error) {
    window.parent.postMessage(JSON.stringify({
      id: data?.id,
      error: error.toString()
    }), '*')
  }
})
