import { apiError } from './model.js'

export async function requestJson(url, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch {
    throw apiError({ error: 'Could not reach the Insight server.', code: 'network', hint: 'Check that Insight is still running, then retry.' })
  }
  const isJson = (res.headers.get('content-type') || '').toLowerCase().includes('application/json')
  const data = isJson ? await res.json().catch(() => null) : null
  if (!res.ok) throw apiError(data, res.status)
  if (!data) {
    throw apiError({
      error: `Expected JSON from ${url}.`,
      code: 'bad_response',
      hint: 'The running Insight server may not include this API. Update Insight and restart it.'
    }, res.status)
  }
  return data
}

export async function copyText(text) {
  const failure = 'Could not copy: the browser only allows clipboard access over HTTPS or localhost. Select the text and copy it instead.'
  if (!navigator.clipboard?.writeText) throw new Error(failure)
  await navigator.clipboard.writeText(text).catch(() => {
    throw new Error(failure)
  })
}

export function downloadText(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function startMicrophoneTest(id) {
  return requestJson('/api/peripherals/microphones/test', { method: 'POST', body: { id } })
}

export function stopMicrophoneTest() {
  return requestJson('/api/peripherals/microphones/test/stop', { method: 'POST' })
}

export function getMicrophoneTest() {
  return requestJson('/api/peripherals/microphones/test')
}

// The status read never contacts the board, so a failed read is a network blip or an Insight
// restart, not the end of the recording: retry it. Codes that mean the test is gone end it, and so
// does a run of failures (about 5 s at the page's 100 ms poll).
const TERMINAL_MICROPHONE_STATUS_ERRORS = new Set(['not_found', 'stale_snapshot'])

export async function readMicrophoneTest({
  request = getMicrophoneTest,
  isActive = () => true,
  wait = () => new Promise((resolve) => setTimeout(resolve, 100)),
  maxFailures = 50
} = {}) {
  for (let failures = 1; ; failures += 1) {
    try {
      return await request()
    } catch (error) {
      if (TERMINAL_MICROPHONE_STATUS_ERRORS.has(error?.code) || failures >= maxFailures || !isActive()) throw error
      await wait()
    }
  }
}
