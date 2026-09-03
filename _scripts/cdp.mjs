#!/usr/bin/env node

const args = process.argv.slice(2)
const wait = args[0] === '--wait'
const expression = wait ? args[1] : args[0]
const timeout = wait ? Number(args[2] || 45) * 1000 : 0
if (!expression) {
  console.error('Usage: cdp.mjs [--wait <expression> [timeout-seconds]] | <expression>')
  process.exit(2)
}

const targets = await fetch('http://127.0.0.1:9222/json/list').then(response => response.json())
const target = targets.find(item => item.type === 'page' && item.url.includes('/index.html'))
if (!target?.webSocketDebuggerUrl) throw new Error('No WebView page available through CDP')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let requestId = 0
const evaluate = () => new Promise((resolve, reject) => {
  const id = ++requestId
  const onMessage = event => {
    const response = JSON.parse(event.data)
    if (response.id !== id) return
    socket.removeEventListener('message', onMessage)
    resolve(response)
  }
  socket.addEventListener('message', onMessage)
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
})

const deadline = Date.now() + timeout
let result
while (true) {
  try {
    result = await evaluate()
    if (!result.error && !result.result?.exceptionDetails && result.result.result.value === true) break
  } catch (error) {
    if (!wait) throw error
  }
  if (!wait || Date.now() >= deadline) {
    if (!result) throw new Error('CDP wait failed')
    break
  }
  await new Promise(resolve => setTimeout(resolve, 250))
}
socket.close()
if (result.error || result.result?.exceptionDetails) throw new Error(result.error?.message || result.result.exceptionDetails.text)
console.log(JSON.stringify(result.result.result.value))
