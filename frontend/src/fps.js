// Pure logic behind the per-slot FPS stepper (issue #111). Keep the range in sync with neat_insight/renditions.py.
export const FPS_MIN = 1
export const FPS_MAX = 240
export const FPS_STEP = 5

export function stepFps(value, direction) {
  const next = Number(value) + (direction < 0 ? -FPS_STEP : FPS_STEP)
  return Math.min(FPS_MAX, Math.max(FPS_MIN, next))
}

export function parseFps(text) {
  if (text == null) return null
  const trimmed = String(text).trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  if (value < FPS_MIN || value > FPS_MAX) return null
  return value
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const mmss = `${minutes}:${String(secs).padStart(2, '0')}`
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : mmss
}

export function formatFpsProgress({ seconds, total }) {
  const done = clock(Number(seconds) || 0)
  return Number.isFinite(total) && total > 0 ? `${done} / ${clock(total)}` : done
}
