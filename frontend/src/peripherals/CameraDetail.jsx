import { useState } from 'react'
import PreviewPane from './PreviewPane.jsx'
import {
  availabilityInfo,
  blockedFormatSummary,
  cameraSubtitle,
  cameraSummaryLine,
  deviceRows,
  formatOptions,
  fpsOptions,
  sizeKey,
  sizeLabel,
  sizeOptions,
  tierInfo
} from './model.js'
import { Callout, ErrorNotice, Pill, SupportLinks } from './ui.jsx'

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

function ModePicker({ camera, selection, notice, onChange }) {
  const formats = formatOptions(camera)
  const range = formats.find((f) => f.value === selection?.format)?.range
  const sizes = selection ? sizeOptions(camera, selection.format) : []
  const rates = selection ? fpsOptions(camera, selection.format, selection.width, selection.height) : []

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
          Pixel format
          <select value={selection.format} onChange={(e) => onChange({ ...selection, format: e.target.value })}>
            {formats.map((f) => <option key={f.value} value={f.value} disabled={f.disabled}>{f.label}</option>)}
          </select>
        </label>
        <label>
          Resolution
          <select
            value={sizeKey(selection.width, selection.height)}
            onChange={(e) => {
              const size = sizes.find((s) => s.value === e.target.value)
              onChange({ format: selection.format, width: size.width, height: size.height, fps: selection.fps })
            }}
          >
            {sizes.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label>
          Frame rate
          <select value={String(selection.fps)} onChange={(e) => onChange({ ...selection, fps: Number(e.target.value) })}>
            {rates.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
      </div>
      {notice && <p className="hint" role="status">{notice}</p>}
      {range && (
        <p className="hint">
          This format also accepts sizes from {sizeLabel(range.min_width, range.min_height)} to {sizeLabel(range.max_width, range.max_height)};
          only the listed sizes can be used.
        </p>
      )}
      <BlockedFormats options={formats} />
    </fieldset>
  )
}

function ExportPanel({ camera, state, onCopy, onDownload, onRetry }) {
  const [activeTab, setActiveTab] = useState('')
  if (state.status === 'error') {
    return (
      <ErrorNotice error={state.error}>
        <button type="button" className="btn-ghost" onClick={onRetry}>Retry</button>
      </ErrorNotice>
    )
  }
  const data = state.data?.camera_id === camera.id ? state.data : null
  if (!data) return state.status === 'loading' ? <p className="hint" role="status">Preparing configuration…</p> : null
  const busy = state.status === 'loading'
  const { support, warnings = [], exports = [] } = data
  const current = exports.find((item) => item.id === activeTab) || exports[0]
  const coreUnsupported = camera.connection === 'usb' || support?.tier === 'unsupported'

  return (
    <div className="periph-export" aria-busy={busy}>
      {coreUnsupported && (
        <Callout tone="danger" title="Not a Core CameraInput config">
          <p>
            {support?.reason || 'Core CameraInput supports MIPI (libcamera) cameras only.'} This descriptor records the device and
            mode for your own capture code; Neat applications cannot open it with CameraInput.
          </p>
          <SupportLinks links={support?.links} />
        </Callout>
      )}
      {warnings.length > 0 && (
        <ul className="periph-warnings">
          {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
        </ul>
      )}
      <div className="periph-export-tabs" role="group" aria-label="Configuration format">
        {exports.map((item) => (
          <button key={item.id} type="button" aria-pressed={item.id === current?.id} onClick={() => setActiveTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {current && (
        <>
          <pre className="periph-code" tabIndex={0} aria-label={`${current.label} configuration`}><code>{current.content}</code></pre>
          <div className="periph-actions">
            <button type="button" className="btn-tonal" onClick={() => onCopy(current)} disabled={busy}>Copy</button>
            <button type="button" className="btn-ghost" onClick={() => onDownload(current)} disabled={busy}>Download {current.filename}</button>
          </div>
        </>
      )}
    </div>
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
  onStartPreview,
  onStopPreview,
  exportState,
  onCopy,
  onDownload,
  onRetryExport,
  onOpenBoardPanel,
  integrationOpen,
  onIntegrationToggle
}) {
  const availability = availabilityInfo(camera.availability)
  const tier = tierInfo(camera.support?.tier)
  const summary = cameraSummaryLine(camera)

  return (
    <section className="periph-detail" aria-labelledby="periph-detail-title">
      <div className="periph-detail-head">
        <div>
          <h3 id="periph-detail-title">{camera.name}</h3>
          <p className="hint">{cameraSubtitle(camera)}</p>
        </div>
        <span className="periph-pills">
          <Pill tone={availability.tone}>{availability.label}</Pill>
          <Pill tone={tier.tone}>{tier.label}</Pill>
        </span>
      </div>

      {summary && (
        <p className="periph-summary-line">
          {summary} <SupportLinks links={camera.support?.links} inline />
        </p>
      )}

      {(camera.errors || []).map((error, index) => (
        <ErrorNotice key={`${error.code || 'error'}-${index}`} error={error} />
      ))}

      <details className="periph-identity">
        <summary>Device details</summary>
        <table className="sysinfo-table key-value">
          <tbody>
            {deviceRows(camera).map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {camera.notes?.length > 0 && (
          <ul className="periph-notes">
            {camera.notes.map((note, index) => <li key={index}>{note}</li>)}
          </ul>
        )}
      </details>

      <ModePicker camera={camera} selection={selection} notice={selectionNotice} onChange={onSelectionChange} />

      <PreviewPane
        camera={camera}
        selection={selection}
        stale={stale}
        target={target}
        state={preview}
        onStart={onStartPreview}
        onStop={onStopPreview}
        onOpenBoardPanel={onOpenBoardPanel}
      />

      <details
        className="periph-integration"
        open={integrationOpen}
        onToggle={(event) => onIntegrationToggle?.(event.currentTarget.open)}
      >
        <summary>View integration code</summary>
        {stale ? (
          <p className="hint">The board changed after this scan. Refresh to build a configuration for the current board.</p>
        ) : (
          <ExportPanel camera={camera} state={exportState} onCopy={onCopy} onDownload={onDownload} onRetry={onRetryExport} />
        )}
      </details>
    </section>
  )
}
