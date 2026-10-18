// Pictures from a camera plugged into the board (a /dev/video* device there),
// as opposed to this browser's camera: GenAI Studio lists them with
// GET /board-camera/devices and takes one JPEG with GET /board-camera/snapshot
// (apps#590). Kept free of React and DOM so `node --test` covers it.

const DEVICE = /^\/dev\/video\d+$/

// Whether the board can take pictures, from /health's `features`.
export function boardCameraSupport(health) {
  if (!health || health.httpStatus !== 200) {
    return { available: false, reason: "Connect to a board to use its camera." }
  }
  const features = health.body && health.body.features
  if (!features || features.board_camera !== true) {
    return { available: false, reason: "This board's GenAI Studio can't take pictures with a camera on the board yet. Update Apps on the board." }
  }
  return { available: true, reason: '' }
}

// GET /board-camera/devices: {devices: [{device, name}], default}. Returns
// {devices: [{device, label}], default} with only /dev/videoN nodes; the
// default is the board's ($NEAT_CAMERA_DEVICE or /dev/video16), which may not exist.
export function parseCameraDevices(body) {
  const list = Array.isArray(body && body.devices) ? body.devices : []
  const devices = []
  for (const item of list) {
    const device = item && typeof item.device === 'string' ? item.device : ''
    if (!DEVICE.test(device) || devices.some((d) => d.device === device)) continue
    const name = String(item.name || item.label || '').trim()
    devices.push({ device, label: name ? `${name} (${device})` : device })
  }
  const fallback = body && typeof body.default === 'string' && DEVICE.test(body.default) ? body.default : null
  return { devices, default: fallback }
}

// The camera to use: the one chosen before if the board still has it, else
// the board's default if it exists, else the first; null without cameras.
export function pickCamera(cameras, current) {
  const devices = (cameras && cameras.devices) || []
  const has = (device) => Boolean(device) && devices.some((d) => d.device === device)
  if (has(current)) return current
  if (has(cameras && cameras.default)) return cameras.default
  return devices.length ? devices[0].device : null
}

export function snapshotPath(device) {
  return device ? `board-camera/snapshot?device=${encodeURIComponent(device)}` : 'board-camera/snapshot'
}

// Why a picture couldn't be taken, with what to do about it. The board answers
// 400 for a device it doesn't accept and 503 when no tool could capture.
export function snapshotErrorMessage(error, device) {
  const camera = device || 'the board camera'
  if (error && error.status === 503) {
    return `The board couldn't take a picture with ${camera}. Check that the camera is plugged into the board, or choose another camera.`
  }
  if (error && error.status === 400) return `The board doesn't accept ${camera} as a camera. Choose another one.`
  return `The board camera didn't send a picture: ${(error && error.message) || 'unknown error'}`
}
