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
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
