import { apiError } from './model.js'

export async function requestJson(url, { method = 'GET', body, signal } = {}) {
  let response
  try {
    response = await fetch(url, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw apiError({ error: 'Could not reach the Insight server.', code: 'network', hint: 'Check that Insight is still running, then retry.' })
  }
  const isJson = (response.headers.get('content-type') || '').toLowerCase().includes('application/json')
  const data = isJson ? await response.json().catch(() => null) : null
  if (!response.ok) throw apiError(data, response.status)
  if (!data) throw apiError({ error: `Expected JSON from ${url}.`, code: 'bad_response' }, response.status)
  return data
}

export async function copyText(text) {
  text = await text
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    const focused = document.activeElement
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(area)
    area.select()
    let copied = false
    try { copied = document.execCommand('copy') } finally { area.remove(); focused?.focus?.({ preventScroll: true }) }
    if (!copied) throw new Error('The browser blocked clipboard access.')
  }
}

export function createLatestRequest() {
  let sequence = 0
  let controller = null
  return {
    async run(request) {
      controller?.abort()
      controller = new AbortController()
      const current = ++sequence
      try {
        const value = await request(controller.signal)
        return current === sequence ? { current: true, value } : { current: false }
      } catch (error) {
        if (current !== sequence || error?.name === 'AbortError') return { current: false }
        throw error
      }
    },
    cancel() {
      sequence += 1
      controller?.abort()
      controller = null
    }
  }
}

export function startMicrophoneTest(selection) {
  return requestJson('/api/peripherals/microphones/test', {
    method: 'POST',
    body: selection
  })
}

export function getMicrophoneTest(token, signal) {
  return requestJson(`/api/peripherals/microphones/test/${encodeURIComponent(token)}`, { signal })
}

const TERMINAL_MICROPHONE_STATUS_ERRORS = new Set(['not_found', 'stale_snapshot'])

export async function pollMicrophoneTest(token, {
  request = getMicrophoneTest,
  isActive = () => true,
  onStatus = () => {},
  onError = () => {},
  wait = () => new Promise((resolve) => setTimeout(resolve, 100))
} = {}) {
  while (isActive()) {
    let answer
    try {
      answer = (await request(token)).test
    } catch (error) {
      if (!isActive()) return null
      if (TERMINAL_MICROPHONE_STATUS_ERRORS.has(error?.code)) throw error
      onError(error)
      await wait()
      continue
    }
    if (!isActive()) return null
    onError(null)
    onStatus(answer)
    if (answer.state === 'ready' || answer.state === 'failed') return answer
    await wait()
  }
  return null
}

export function stopMicrophoneTest(token) {
  return requestJson(`/api/peripherals/microphones/test/${encodeURIComponent(token)}/stop`, {
    method: 'POST'
  })
}
