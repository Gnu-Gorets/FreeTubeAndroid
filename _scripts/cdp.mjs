#!/usr/bin/env node

const expression = process.argv[2]
if (!expression) {
  console.error('Usage: cdp.mjs <expression>')
  process.exit(2)
}

const targets = await fetch('http://127.0.0.1:9222/json/list').then(response => response.json())
const target = targets.find(item => item.type === 'page')
if (!target?.webSocketDebuggerUrl) throw new Error('No WebView page available through CDP')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const result = await new Promise((resolve, reject) => {
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data)
    if (response.id === 1) resolve(response)
  })
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  socket.addEventListener('error', reject, { once: true })
})
socket.close()
if (result.error || result.result?.exceptionDetails) throw new Error(result.error?.message || result.result.exceptionDetails.text)
console.log(JSON.stringify(result.result.result.value))
