const SOURCES = { 'on-board': 'On this board', 'sdk-env': 'SDK DevKit', manual: 'Manual' }

export function apiError(body, status) {
  const data = body && typeof body === 'object' ? body : {}
  const error = new Error(data.error || data.message || `Request failed${status ? `: ${status}` : ''}`)
  error.code = data.code || ''
  error.hint = data.hint || ''
  error.details = data
  return error
}

export function normalizeError(error) {
  if (!error) return null
  if (typeof error === 'string') return { message: error, code: '', hint: '', details: {} }
  return {
    message: error.message || error.error || 'Unknown error',
    code: error.code || '',
    hint: error.hint || '',
    details: error.details || error
  }
}

export function sourceLabel(source) { return SOURCES[source] || source || '' }

export function connectionStateInfo(status) {
  if (status?.state === 'connected') return { label: 'Connected', short: 'Connected', tone: 'ok' }
  if (status?.state === 'error') return { label: 'Connection failed', short: 'Error', tone: 'danger' }
  return { label: 'Not checked', short: 'Not checked', tone: '' }
}

export function boardIndicator(board) {
  if (!board) return { label: 'Board', state: { short: 'Loading…', tone: '' }, title: 'Loading the selected board' }
  if (!board.target) return { label: 'No board', state: { short: 'Not selected', tone: 'warn' }, title: 'Choose a board' }
  const state = connectionStateInfo(board.status)
  const label = board.target.mode === 'local' ? 'This board' : `${board.target.source === 'sdk-env' ? 'DevKit' : 'Board'}: ${board.target.host}`
  return { label, state, title: `${board.target.label} — ${state.label}` }
}

export function initialBoardForm(board) {
  const target = board?.target?.mode === 'ssh' ? board.target : null
  const source = board?.saved || target || board?.defaults?.sdk_env || {}
  return { host: source.host || '', port: String(source.port || 22), user: source.user || 'sima' }
}

export function validateBoardForm(values) {
  const host = String(values.host || '').trim()
  const user = String(values.user || '').trim()
  const port = Number(values.port)
  if (!host || /\s/.test(host)) return { error: 'Enter a host name or IP address without spaces.' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'The SSH port must be from 1 to 65535.' }
  if (!user) return { error: 'Enter the SSH user, usually “sima”.' }
  return { body: { host, port, user } }
}

export function createBoardSync({ fetchBoard, onBoard, onError, onLoading }) {
  let latest = 0
  let newest = Promise.resolve(null)
  return {
    load() {
      const sequence = ++latest
      onLoading(true)
      const current = Promise.resolve().then(fetchBoard).then(
        (data) => {
          if (sequence !== latest) return newest
          onBoard(data); onLoading(false); return data
        },
        (error) => {
          if (sequence !== latest) return newest
          onError(error); onLoading(false); return null
        }
      )
      newest = current
      return current
    },
    apply(data) {
      latest += 1
      newest = Promise.resolve(data)
      onBoard(data); onLoading(false)
      return data
    }
  }
}

export function deviceTypes(devices) {
  const counts = new Map()
  for (const device of devices || []) if (device?.type) counts.set(device.type, (counts.get(device.type) || 0) + 1)
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([id, count]) => ({ id, count, label: typeLabel(id) }))
}

export function typeLabel(type) {
  const text = String(type || 'device').replace(/[_-]+/g, ' ')
  const title = text.charAt(0).toUpperCase() + text.slice(1)
  return `${title}${title.endsWith('s') ? '' : 's'}`
}

export function modeLabel(mode) {
  const size = mode.size_range
    ? `${mode.size_range.min_width}–${mode.size_range.max_width} × ${mode.size_range.min_height}–${mode.size_range.max_height}`
    : `${mode.width}×${mode.height}`
  const fps = mode.framerate_den ? mode.framerate_num / mode.framerate_den : 0
  return `${mode.format || 'Unknown'} · ${size} · ${Number.isInteger(fps) ? fps : fps.toFixed(2)} fps`
}

export function isExportableMode(camera, mode) {
  return Boolean(camera?.camera_name && mode?.supported === true && Number.isInteger(mode.width) && Number.isInteger(mode.height))
}

export function formatTime(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : 'Never'
}

export function catalogIdentity(catalog) {
  return `${catalog?.instance_id || ''}:${Number.isInteger(catalog?.revision) ? catalog.revision : ''}`
}

export function canRefreshCatalog(catalog, refreshing = false) {
  return Boolean(catalog?.instance_id) && !refreshing
}

export function createEventCursor(catalog) {
  let current = { sequence: catalog.sequence, instanceId: catalog.instance_id }
  return {
    current: () => current,
    observe(response) {
      const changed = response.resync_required || response.shutting_down || response.instance_id !== current.instanceId || response.events.length > 0
      if (!changed) current = { sequence: response.sequence, instanceId: response.instance_id }
      return changed
    },
    synchronize(nextCatalog) {
      current = { sequence: nextCatalog.sequence, instanceId: nextCatalog.instance_id }
    }
  }
}

function catalogOrder(catalog) {
  return [catalog?.scan_sequence || 0, catalog?.revision || 0, catalog?.sequence || 0]
}

function compareOrder(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

export function createCatalogPolicy() {
  let current = null
  let requestSequence = 0
  let acceptedRequest = 0
  const retiredInstances = new Set()
  return {
    begin() {
      requestSequence += 1
      return requestSequence
    },
    merge(next, request = ++requestSequence) {
      if (!next) return current
      if (!current || next.board_generation > current.board_generation) {
        current = next
        acceptedRequest = request
        retiredInstances.clear()
        return current
      }
      if (next.board_generation < current.board_generation) return current
      if (next.instance_id !== current.instance_id) {
        if (retiredInstances.has(next.instance_id) || request < acceptedRequest) return current
        retiredInstances.add(current.instance_id)
        current = next
        acceptedRequest = request
        return current
      }
      acceptedRequest = Math.max(acceptedRequest, request)
      if (compareOrder(catalogOrder(next), catalogOrder(current)) >= 0) current = next
      return current
    },
    reset() {
      current = null
      acceptedRequest = 0
      retiredInstances.clear()
    }
  }
}
