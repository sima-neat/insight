import {
  modeLabel,
  previewBlock,
  previewErrorInfo,
  previewStatusInfo,
  previewStreamUrl,
  rateLabel,
  sizeLabel
} from './model.js'
import { Callout, Pill } from './ui.jsx'

function PreviewError({ error, onOpenBoardPanel }) {
  const info = previewErrorInfo(error)
  if (!info) return null
  return (
    <>
      <p className="sr-only" role="alert">{info.message}</p>
      <Callout tone="danger" title={info.message}>
        {/* One recovery line: the board's own hint when it sent one, ours otherwise. */}
        {(info.hint || info.action) && <p>{info.hint || info.action}</p>}
        {info.otherCamera && <p>The running preview is on <span className="periph-inline-code">{info.otherCamera}</span>.</p>}
        {info.detail && <pre className="periph-code" tabIndex={0} aria-label="Board output"><code>{info.detail}</code></pre>}
        {(info.code === 'no_target' || info.code === 'unreachable' || info.code === 'auth_failed' || info.code === 'host_key_changed') && (
          <button type="button" className="btn-ghost" onClick={onOpenBoardPanel}>Open board settings</button>
        )}
      </Callout>
    </>
  )
}

// The mode as tags -- format, size, and the camera's rate once a running preview knows it -- rather
// than one run of text, so each reads at a glance. Screen readers get the same sentence.
// The rate is what the camera runs at (`camera_fps`), never a requested one: Insight sets no rate.
function ModeBadges({ mode, fps = null, label }) {
  if (!mode) return null
  const rate = rateLabel(fps)
  return (
    <span className="periph-mode-badges" role="group" aria-label={`${label}: ${modeLabel(mode)}${rate ? ` at ${rate}` : ''}`}>
      <span>{mode.format}</span>
      <span>{sizeLabel(mode.width, mode.height)}</span>
      {rate && <span>{rate}</span>}
    </span>
  )
}

// `elapsed` is how many seconds the current start has taken; the view keeps the clock, since this
// component renders from props alone.
export default function PreviewPane({ camera, selection, stale, target, state: paneState, elapsed = 0, onStart, onStop, onStreamError, onOpenBoardPanel }) {
  // A session kept for another camera (its stop failed when the user switched) is not this camera's
  // video: this camera reads as idle, blocked by that preview, with the failure; the owner's pane keeps Stop.
  const foreign = Boolean(paneState?.session?.camera_id) && paneState.session.camera_id !== camera?.id && paneState.status !== 'stopping'
  const state = foreign ? { ...paneState, status: 'idle' } : paneState
  const block = previewBlock({ camera, selection, stale, target, session: state?.session })
  const status = previewStatusInfo(state)
  const session = state?.session || null
  const running = state?.status === 'starting' || state?.status === 'live' || state?.status === 'stopping'
  const streamUrl = state?.status === 'live' ? previewStreamUrl(session) : null
  return (
    <section className="periph-preview" aria-labelledby="periph-preview-title">
      <div className="periph-preview-head">
        <h4 id="periph-preview-title">Video Preview</h4>
        <Pill tone={status.tone}>{status.label}</Pill>
      </div>

      <p className="sr-only" role="status">
        {state?.status === 'live'
          ? 'Preview live'
          : state?.status === 'starting'
            ? 'Starting the preview'
            : state?.status === 'stopping'
              ? 'Stopping the preview'
              : ''}
      </p>

      {!running && (
        <>
          <div className="periph-actions">
            <button
              type="button"
              className="btn-tonal"
              onClick={() => onStart()}
              disabled={block.blocked}
              aria-describedby={block.blocked ? 'periph-preview-reason' : undefined}
            >
              Start preview
            </button>
            {!block.blocked && <ModeBadges mode={selection} label="Mode" />}
          </div>
          {block.blocked && <p className="hint periph-preview-reason" id="periph-preview-reason">{block.reason}</p>}
        </>
      )}

      {running && !streamUrl && (
        // Starting and stopping take one row, like idle; the video is the only thing that gets the full width.
        <div className="periph-actions periph-preview-progress" role="status">
          {state?.status !== 'live' && <span className="periph-spinner" aria-hidden="true" />}
          <span>
            {state?.status === 'stopping'
              ? 'Stopping the preview…'
              : state?.status === 'live'
                ? 'The preview stream could not be opened. Stop the preview and report it with the board label.'
                : `Starting the camera on the board… ${elapsed} s`}
          </span>
          <button type="button" className="btn-ghost" onClick={onStop} disabled={state?.status === 'stopping'}>
            {state?.status === 'stopping' ? 'Stopping…' : 'Stop preview'}
          </button>
        </div>
      )}

      {streamUrl && (
        <div className="periph-stage">
          {/* The backend relays the board's JPEG frames as multipart/x-mixed-replace, which an <img> plays. */}
          <img
            className="periph-preview-frame"
            alt={`Live preview of ${camera?.name || 'the camera'}`}
            src={streamUrl}
            onError={() => onStreamError?.(session?.id)}
          />
          <span className="periph-stage-chip">
            <i className="periph-live-dot" aria-hidden="true" />
            <ModeBadges mode={session?.mode} fps={session?.camera_fps} label="Streaming" />
          </span>
          {/* The mode alone: leaving this tab stops the preview, so a warning about holding the camera
              describes a state the reader cannot walk away from. */}
          <button type="button" className="btn-ghost periph-stage-stop" onClick={onStop}>Stop preview</button>
        </div>
      )}

      {/* The error sits under the Start row, which is the retry; it never replaces the row. */}
      {!foreign && <PreviewError error={state?.error} onOpenBoardPanel={onOpenBoardPanel} />}
    </section>
  )
}
