import {
  CONNECTION_ERROR_CODES,
  fpsLabel,
  modeLabel,
  previewBlock,
  previewErrorInfo,
  previewStatusInfo,
  safeHref,
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
        {(info.hint || info.action) && <p>{info.hint || info.action}</p>}
        {info.otherCamera && <p>The running preview is on <span className="periph-inline-code">{info.otherCamera}</span>.</p>}
        {info.detail && <pre className="periph-code" tabIndex={0} aria-label="Board output"><code>{info.detail}</code></pre>}
        {(info.code === 'no_target' || CONNECTION_ERROR_CODES.has(info.code)) && (
          <button type="button" className="btn-ghost" onClick={onOpenBoardPanel}>Open board settings</button>
        )}
      </Callout>
    </>
  )
}

function ModeBadges({ mode, label }) {
  if (!mode) return null
  return (
    <span className="periph-mode-badges" role="group" aria-label={`${label}: ${modeLabel(mode)}`}>
      <span>{mode.format}</span>
      <span>{sizeLabel(mode.width, mode.height)}</span>
      <span>{fpsLabel(mode.fps)} fps</span>
    </span>
  )
}

export default function PreviewPane({ camera, selection, stale, target, state, onStart, onStop, onOpenBoardPanel }) {
  const block = previewBlock({ camera, selection, stale, target, session: state?.session })
  const status = previewStatusInfo(state)
  const session = state?.session || null
  const running = state?.status === 'starting' || state?.status === 'live' || state?.status === 'stopping'
  const frameUrl = state?.status === 'live' ? safeHref(session?.viewer_url) : null

  return (
    <section className="periph-preview" aria-labelledby="periph-preview-title">
      <div className="periph-preview-head">
        <h4 id="periph-preview-title">Video Preview</h4>
        <span className="periph-pills">
          {running && <ModeBadges mode={session?.mode} label="Streaming" />}
          <Pill tone={status.tone}>{status.label}</Pill>
        </span>
      </div>

      <p className="sr-only" role="status">
        {{ live: `Preview live on channel ${session?.channel}`, starting: 'Starting the preview', stopping: 'Stopping the preview' }[state?.status] || ''}
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

      {running && (
        <>
          <div className="periph-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={onStop}
              disabled={!session?.id || state?.status === 'stopping'}
            >
              {state?.status === 'stopping' ? 'Stopping…' : 'Stop preview'}
            </button>
          </div>
          {frameUrl ? (
            <iframe
              className="periph-preview-frame"
              title={`Live preview of ${camera?.name || 'the camera'}`}
              src={frameUrl}
              allow="autoplay; fullscreen"
            />
          ) : state?.status === 'live' ? (
            <Callout tone="danger" title="The viewer link could not be opened">
              <p>Insight returned a preview address this browser will not load. Stop the preview and report it with the board label.</p>
            </Callout>
          ) : (
            <p className="periph-preview-placeholder" role="status">Waiting for the board to start the encoder…</p>
          )}
        </>
      )}

      <PreviewError error={state?.error} onOpenBoardPanel={onOpenBoardPanel} />
    </section>
  )
}
