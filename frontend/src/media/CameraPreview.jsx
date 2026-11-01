import { useEffect, useRef, useState } from 'react'

import { IDLE, createCameraPreview } from './cameraPreview.js'
import { Callout, Pill } from '../peripherals/ui.jsx'

const STATUS = {
  idle: { label: 'Not running', tone: '' },
  loading: { label: 'Opening…', tone: 'periph-info' },
  live: { label: 'Live', tone: 'ok' },
  error: { label: 'Could not preview', tone: 'periph-danger' }
}

function FactsTable({ rows, label, testId }) {
  return (
    <table className="kv-table camera-preview-facts" aria-label={label} data-testid={testId}>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th>{row.label}</th>
            <td>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// What the browser reports about the previewed stream: the active settings, then what the camera
// says it supports, kept apart so a maximum is never read as the current mode.
function StreamFacts({ info }) {
  return (
    <div className="camera-preview-info">
      <h4>Active stream</h4>
      {info.active.length
        ? <FactsTable rows={info.active} label="Active stream" testId="camera-active-settings" />
        : <p className="hint">The browser did not report this stream's settings.</p>}
      <h4>Camera capabilities</h4>
      {info.supported.length
        ? <FactsTable rows={info.supported} label="Camera capabilities" testId="camera-capabilities" />
        : <p className="hint" data-testid="camera-capabilities-missing">
          {info.capabilitiesReported ? 'The browser reported no size or rate limits for this camera.' : 'This browser does not report what the camera supports.'}
        </p>}
    </div>
  )
}

// The selected camera's preview in Media Sources. Renders from props alone; CameraPreview below
// owns the camera.
export default function CameraPreviewPane({ state = IDLE, onStop, onRetry, onRefreshCameras, onVideoSettled }) {
  const camera = state.camera || null
  const status = STATUS[state.status] || STATUS.idle
  const error = state.status === 'error' ? state.error : null
  const info = state.status === 'live' ? state.info : null
  return (
    <section className="camera-preview" aria-labelledby="camera-preview-title" data-testid="camera-preview" data-status={state.status}>
      <div className="camera-preview-head">
        <h3 id="camera-preview-title" data-testid="camera-preview-name">{camera?.label || 'Camera'}</h3>
        <Pill tone={status.tone}>{status.label}</Pill>
      </div>
      <p className="hint">
        A local preview in this browser. It does not assign a Streaming slot or publish the camera.
      </p>
      {state.status === 'live' && state.sharedWith != null && (
        <p className="hint" data-testid="camera-preview-shared">
          This tab is publishing this camera to src{state.sharedWith}, so the preview shows that capture without opening the camera again.
        </p>
      )}

      <p className="sr-only" role="status">
        {state.status === 'loading' ? `Opening ${camera?.label || 'the camera'}` : state.status === 'live' ? 'Camera preview live' : ''}
      </p>

      {state.status === 'loading' && (
        <div className="periph-actions periph-preview-progress" data-testid="camera-preview-loading">
          <span className="periph-spinner" aria-hidden="true" />
          <span>Opening the camera… If the browser asks, allow camera access.</span>
          <button type="button" className="btn-ghost" onClick={onStop}>Cancel</button>
        </div>
      )}

      {state.status === 'live' && (
        <>
          <div className="periph-stage">
            <video
              className="periph-preview-frame"
              data-testid="camera-preview-video"
              aria-label={`Live preview of ${camera?.label || 'the camera'}`}
              autoPlay
              muted
              playsInline
              ref={(el) => {
                if (el && el.srcObject !== state.stream) el.srcObject = state.stream
              }}
              onLoadedMetadata={onVideoSettled}
              onResize={onVideoSettled}
            />
            {(info.resolution || info.frameRate) && (
              <span className="periph-stage-chip">
                <i className="periph-live-dot" aria-hidden="true" />
                <span className="periph-mode-badges" role="group" aria-label={`Active: ${[info.resolution, info.frameRate].filter(Boolean).join(' at ')}`}>
                  {info.resolution && <span>{info.resolution}</span>}
                  {info.frameRate && <span>{info.frameRate}</span>}
                </span>
              </span>
            )}
            <button type="button" className="btn-ghost periph-stage-stop" onClick={onStop}>Stop preview</button>
          </div>
          <StreamFacts info={info} />
        </>
      )}

      {error && (
        <>
          <p className="sr-only" role="alert">{error.title}</p>
          <Callout tone="danger" title={error.title}>
            <p data-testid="camera-preview-error" data-kind={error.kind}>{error.action}</p>
            <div className="periph-actions">
              {error.kind === 'disconnected'
                ? <button type="button" className="btn-tonal" onClick={onRefreshCameras}>Refresh cameras</button>
                : error.kind !== 'blocked' && <button type="button" className="btn-tonal" onClick={onRetry}>Try again</button>}
              <button type="button" className="btn-ghost" onClick={onStop}>Close</button>
            </div>
          </Callout>
        </>
      )}
    </section>
  )
}

// Owns one camera preview while it is mounted: selecting another camera replaces it, and unmounting
// (leaving Media Sources, picking a file, closing the page) releases it. `findShared(deviceId)`
// returns this tab's publishing track for the camera, if any, so a camera that is already
// publishing is previewed from a clone instead of being opened again.
export function CameraPreview({ camera, findShared, onClose, onRefreshCameras }) {
  const [state, setState] = useState(IDLE)
  const controllerRef = useRef(null)
  if (!controllerRef.current) controllerRef.current = createCameraPreview({ onState: setState })
  const findRef = useRef(findShared)
  findRef.current = findShared
  const [attempt, setAttempt] = useState(0)
  const deviceId = camera?.deviceId || null

  useEffect(() => {
    const controller = controllerRef.current
    controller.select(camera, { shared: deviceId ? findRef.current?.(deviceId) : null })
    return () => controller.stop()
    // A new label for the same camera is not a new preview.
  }, [deviceId, attempt])

  return (
    <CameraPreviewPane
      state={state.status === 'idle' && camera ? { status: 'loading', camera } : state}
      onStop={onClose}
      onRetry={() => setAttempt((n) => n + 1)}
      onRefreshCameras={async () => {
        // Re-scan, then try this camera again: a reconnected camera keeps its id.
        await onRefreshCameras?.()
        setAttempt((n) => n + 1)
      }}
      onVideoSettled={() => controllerRef.current.refresh()}
    />
  )
}
