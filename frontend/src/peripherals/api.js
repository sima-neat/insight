import { apiError, exportChoices } from './model.js'

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
// resolves, which Safari requires. Without a clipboard (plain HTTP to a board) a hidden textarea copies it.
export async function copyText(text) {
  const failure = 'Could not copy: the browser only allows clipboard access over HTTPS or localhost. Select the text and copy it instead.'
  if (globalThis.ClipboardItem && navigator.clipboard?.write) {
    try {
      const blob = Promise.resolve(text).then((value) => new Blob([value], { type: 'text/plain' }))
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
      return
    } catch {
      // A failed lookup rethrows below; a refused write falls back to the older paths.
    }
  }
  text = await text
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Falls back to the textarea below.
    }
  }
  if (!globalThis.document?.execCommand) throw new Error(failure)
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
  if (!copied) throw new Error(failure)
}

// Copies one export of the selected mode. The request starts and the clipboard write is handed its pending
// text in the same call, inside the click, before anything awaits. `isCurrent` reports whether the selection
// is still the one clicked, so a late response for an older mode is never copied.
export function copyCameraExport({ camera, selection, exportId, isCurrent = () => true }) {
  const { format, width, height, fps } = selection
  const label = exportChoices(camera).find((choice) => choice.id === exportId)?.label || exportId
  const text = requestJson('/api/peripherals/cameras/export', {
    method: 'POST',
    body: { id: camera.id, format, width, height, fps }
  }).then((data) => {
    if (!isCurrent()) throw new Error('The selection changed; nothing was copied.')
    const item = (data.exports || []).find((entry) => entry.id === exportId)
    if (!item) throw new Error(`${label} is not available for this mode.`)
    return item.content
  })
  return copyText(text)
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
