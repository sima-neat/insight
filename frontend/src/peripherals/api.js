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

// `text` may be a promise: handing it to ClipboardItem inside the click keeps the copy allowed while it
// resolves, which Safari requires.
export async function copyText(text) {
  if (window.ClipboardItem && navigator.clipboard?.write) {
    try {
      const blob = Promise.resolve(text).then((value) => new Blob([value], { type: 'text/plain' }))
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
      return
    } catch {
      // A failed lookup rethrows below; a refused write falls back to the older paths.
    }
  }
  text = await text
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // navigator.clipboard is missing over plain HTTP to a board; fall back to a hidden textarea.
  }
  const focused = document.activeElement
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    // Reported below.
  } finally {
    area.remove()
    focused?.focus?.({ preventScroll: true })
  }
  if (!copied) throw new Error('Could not copy: the browser blocked clipboard access.')
}
