export const PREVIEW_ENABLED_STORAGE_KEY = 'neatInsight.externalPreviewEnabled'

const PROTOCOL_LABELS = { rtsp: 'RTSP', rtsps: 'RTSPS', webrtc: 'WebRTC', srt: 'SRT', rtmp: 'RTMP', rtmps: 'RTMPS' }

export function isExternal(src) {
  return src?.state === 'external'
}

export function protocolLabel(protocol) {
  if (!protocol) return '-'
  return PROTOCOL_LABELS[protocol] || String(protocol).toUpperCase()
}

export function dimensionsText(ext) {
  const parts = []
  if (ext?.width && ext?.height) parts.push(`${ext.width}×${ext.height}`)
  if (ext?.fps) parts.push(`${ext.fps} fps`)
  return parts.join(' · ')
}

export function externalChipText(ext) {
  const parts = [protocolLabel(ext?.protocol)]
  if (ext?.address) parts.push(ext.address)
  const dims = dimensionsText(ext)
  if (dims) parts.push(dims)
  return `⇢ ${parts.join(' · ')}`
}

export function codecWarningText(ext, codecName) {
  if (!ext || ext.codec_supported !== false) return null
  return `${codecName} cannot be decoded by Neat video pipelines (expects H.264, H.265 or MJPEG). Readers can connect, but decoding will fail.`
}

export function readPreviewEnabled(storage) {
  try {
    return storage.getItem(PREVIEW_ENABLED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function writePreviewEnabled(storage, enabled) {
  try {
    storage.setItem(PREVIEW_ENABLED_STORAGE_KEY, enabled ? '1' : '0')
  } catch {}
}

export function previewUrl(index, enabled) {
  if (!enabled) return null
  return `/stream/preview/src${index}.mjpg`
}

// `since` identifies the publisher session: when a publisher reconnects between two polls
// the slot never stops being external, and only the changed URL remounts the ended image.
export function previewSrc(index, enabled, token, since) {
  const url = previewUrl(index, enabled)
  if (url === null) return null
  return `${url}?t=${token}${since ? `&s=${encodeURIComponent(since)}` : ''}`
}

// Responses can arrive out of order; begin() marks a request as started and returns a check
// that stays true only while no later request has started.
export function latestOnly() {
  let started = 0
  return () => {
    const mine = ++started
    return () => mine === started
  }
}

export function liveFor(sinceIso, nowMs) {
  const since = sinceIso ? Date.parse(sinceIso) : NaN
  if (!Number.isFinite(since)) return '-'
  const total = Math.max(0, Math.floor((nowMs - since) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export function formatBitrate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '-'
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbit/s`
  return `${Math.round(bps / 1000)} kbit/s`
}

export function readersText(readers) {
  const list = Array.isArray(readers) ? readers : []
  if (list.length === 0) return '0'
  return `${list.length} · ${list.map((r) => r.label || r.address || r.protocol).join(', ')}`
}
