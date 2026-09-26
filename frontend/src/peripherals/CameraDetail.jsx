import {
  availabilityInfo,
  blockedFormatSummary,
  cameraSubtitle,
  cameraSummaryLine,
  deviceRows,
  formatOptions,
  fpsOptions,
  groupOptions,
  optionTier,
  sizeKey,
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

function FieldHead({ title, tier }) {
  return (
    <span className="periph-field-head">
      {title}
      {tier && <Pill tone={tier.tone}>{tier.label}</Pill>}
    </span>
  )
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
          <FieldHead title="Pixel format" tier={optionTier(formats, selection.format)} />
          <select value={selection.format} onChange={(e) => onChange({ ...selection, format: e.target.value })}>
            <ModeOptions options={formats} />
          </select>
        </label>
        <label>
          <FieldHead title="Resolution" tier={optionTier(sizes, sizeKey(selection.width, selection.height))} />
          <select
            value={sizeKey(selection.width, selection.height)}
            onChange={(e) => {
              const size = sizes.find((s) => s.value === e.target.value)
              onChange({ format: selection.format, width: size.width, height: size.height, fps: selection.fps })
            }}
          >
            <ModeOptions options={sizes} />
          </select>
        </label>
        <label>
          <FieldHead title="Frame rate" tier={optionTier(rates, selection.fps)} />
          <select value={String(selection.fps)} onChange={(e) => onChange({ ...selection, fps: Number(e.target.value) })}>
            <ModeOptions options={rates} />
          </select>
        </label>
      </div>
      {notice && <p className="hint" role="status">{notice}</p>}
    </fieldset>
  )
}

export default function CameraDetail({ camera, selection, selectionNotice, onSelectionChange }) {
  const availability = availabilityInfo(camera.availability)
  const tier = tierInfo(camera.support?.tier)
  const summary = cameraSummaryLine(camera)

  return (
    <section className="periph-detail" aria-labelledby="periph-detail-title">
      <div className="periph-detail-head">
        <div>
          <h3 id="periph-detail-title">{camera.name}</h3>
          {cameraSubtitle(camera) && <p className="hint">{cameraSubtitle(camera)}</p>}
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
    </section>
  )
}
