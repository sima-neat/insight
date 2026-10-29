import PreviewPane from './PreviewPane.jsx'
import { copyText } from './api.js'
import {
  blockedFormatSummary,
  cameraSubtitle,
  cameraSummaryLine,
  formatOptions,
  groupOptions,
  sizeKey,
  sizeOptions
} from './model.js'
import { Callout, ErrorNotice } from './ui.jsx'

export { cameraSubtitle }

function BlockedFormats({ options }) {
  const summary = blockedFormatSummary(options)
  if (!summary) return null
  const blocked = options.filter((option) => option.disabled)
  return (
    <details className="periph-blocked-disclosure">
      <summary>{summary}</summary>
      <ul className="periph-blocked">
        {blocked.map((option) => (
          <li key={option.value}>
            <strong>{option.value}</strong>: {option.reason}
          </li>
        ))}
      </ul>
    </details>
  )
}

// Folded beside the camera's name: the ID (`device.camera_name`) a Neat application opens this camera by.
function NeatCameraName({ name, onStatus }) {
  function copy() {
    copyText(name).then(() => onStatus?.(`Copied the camera ID: ${name}`), (err) => onStatus?.(`${err.message} Camera ID: ${name}`))
  }
  return (
    <details className="periph-blocked-disclosure periph-neat-name">
      <summary>Camera ID</summary>
      <div className="periph-command">
        <p className="hint">The ID a Neat application opens this camera by.</p>
        <pre className="periph-code" tabIndex={0} aria-label="Camera ID"><code>{name}</code></pre>
        <button type="button" className="btn-ghost" onClick={copy}>Copy ID</button>
      </div>
    </details>
  )
}

function FieldHead({ title }) {
  return <span className="periph-field-head">{title}</span>
}

function ModeOptions({ options }) {
  const groups = groupOptions(options)
  const entry = (o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
  if (groups.length < 2) return options.map(entry)
  return groups.map((group) => <optgroup key={group.id} label={group.label}>{group.options.map(entry)}</optgroup>)
}

function ModePicker({ camera, selection, notice, onChange }) {
  const formats = formatOptions(camera)
  const sizes = selection ? sizeOptions(camera, selection.format) : []

  if (!selection) {
    return (
      <Callout title="No usable modes">
        <p>
          {camera.modes_source === 'live'
            ? 'None of the formats this camera reports can be used. Open the list below for the reason for each one.'
            : 'Modes could not be read from this camera; the message above says why and how to fix it.'}
        </p>
        <BlockedFormats options={formats} />
      </Callout>
    )
  }

  return (
    <fieldset className="periph-modes">
      <legend>Input mode</legend>
      <div className="periph-mode-fields">
        <label>
          <FieldHead title="Pixel format" />
          <select value={selection.format} onChange={(e) => onChange({ format: e.target.value })}>
            <ModeOptions options={formats} />
          </select>
        </label>
        <label>
          <FieldHead title="Resolution" />
          <select
            value={sizeKey(selection.width, selection.height)}
            onChange={(e) => {
              const size = sizes.find((s) => s.value === e.target.value)
              onChange({ format: selection.format, width: size.width, height: size.height })
            }}
          >
            <ModeOptions options={sizes} />
          </select>
        </label>
      </div>
      {notice && <p className="hint" role="status">{notice}</p>}
    </fieldset>
  )
}

export default function CameraDetail({
  camera,
  stale,
  target,
  selection,
  selectionNotice,
  onSelectionChange,
  preview,
  previewElapsed = 0,
  onStartPreview,
  onStopPreview,
  onPreviewStreamError,
  onOpenBoardPanel,
  onStatus
}) {
  const summary = cameraSummaryLine(camera)

  return (
    <section className="periph-detail" aria-labelledby="periph-detail-title">
      <div className="periph-detail-head">
        <div>
          <div className="periph-title-row">
            <h3 id="periph-detail-title">{camera.name}</h3>
            {camera.device?.camera_name && <NeatCameraName name={camera.device.camera_name} onStatus={onStatus} />}
          </div>
          {cameraSubtitle(camera) && <p className="hint">{cameraSubtitle(camera)}</p>}
        </div>

      </div>

      {summary && (
        <p className="periph-summary-line">
          {summary}
        </p>
      )}

      {(camera.errors || []).map((error, index) => (
        <ErrorNotice key={`${error.code || 'error'}-${index}`} error={error} />
      ))}

      <ModePicker camera={camera} selection={selection} notice={selectionNotice} onChange={onSelectionChange} />

      <PreviewPane
        camera={camera}
        selection={selection}
        stale={stale}
        target={target}
        state={preview}
        elapsed={previewElapsed}
        onStart={onStartPreview}
        onStop={onStopPreview}
        onStreamError={onPreviewStreamError}
        onOpenBoardPanel={onOpenBoardPanel}
      />
    </section>
  )
}
