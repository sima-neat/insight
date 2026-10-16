// Presentational pieces shared by the Stats panels.
import { useRef, useState } from 'react'
import { Callout } from '../peripherals/ui.jsx'
import { chipKeyTarget } from './model.js'

/** An accessible no-change reason shown by focus, tap or hover and dismissed with Escape. */
export function DeltaReason({ reason }) {
  const [dismissed, setDismissed] = useState(false)
  const sentence = reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : ''
  return (
    <span className="stats-delta-why">
      <button
        type="button"
        className="stats-delta-why-button"
        onClick={(event) => {
          // Safari does not focus a button it was tapped on; the reason shows while focused.
          event.currentTarget.focus()
          setDismissed(false)
        }}
        onBlur={() => setDismissed(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !dismissed) {
            event.preventDefault()
            event.stopPropagation()
            setDismissed(true)
          }
        }}
      >
        —<span className="sr-only">{` no change shown, because ${reason}`}</span>
      </button>
      <span className="stats-delta-tip" aria-hidden="true" hidden={dismissed || undefined}>
        {sentence}
      </span>
    </span>
  )
}

/** Command output the backend attached, behind a disclosure. */
export function OutputDetails({ label, text }) {
  return (
    <details className="stats-detail">
      <summary>{label}</summary>
      <pre className="periph-code" tabIndex={0}><code>{text}</code></pre>
    </details>
  )
}

/** How many metrics are past a threshold, in the worst tone among them. */
export function AlertBadge({ alert }) {
  if (!alert) return null
  return (
    <span className={`stats-chip-alert tone-${alert.tone}`}>
      {alert.count} {alert.tone === 'critical' ? 'critical' : `warning${alert.count === 1 ? '' : 's'}`}
    </span>
  )
}

/** A count, followed for screen readers by the noun it counts. */
export function CountBadge({ className, count, noun = '' }) {
  return (
    <span className={className}>
      {count}
      {noun && <span className="sr-only">{` ${noun}${count === 1 ? '' : 's'}`}</span>}
    </span>
  )
}

export function Facts({ rows, className = 'periph-facts' }) {
  if (!rows?.length) return null
  return (
    <dl className={className}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function KeyValueTable({ rows, caption }) {
  if (!rows?.length) return null
  return (
    <table className="sysinfo-table key-value">
      {caption && <caption className="sr-only">{caption}</caption>}
      <tbody>
        {rows.map(([label, value], index) => (
          <tr key={`${label}-${index}`}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** A backend failure with its hint and optional command output disclosure. */
export function FailureCallout({ notice, detailLabel = 'Output from the board', children }) {
  if (!notice) return null
  return (
    <>
      <p className="sr-only" role="alert">{`${notice.title}. ${notice.message}`}</p>
      <Callout tone="danger" title={notice.title}>
        <p>{notice.message}</p>
        {notice.hint && <p className="hint">{notice.hint}</p>}
        {notice.detail && <OutputDetails label={detailLabel} text={notice.detail} />}
        {children}
      </Callout>
    </>
  )
}

export function ChipTabs({ label, items, selected, onSelect, idPrefix, panelId, noun = '' }) {
  const refs = useRef([])
  const [focused, setFocused] = useState(null)
  const selectedIndex = items.findIndex((item) => item.id === selected)
  const current = focused !== null && focused < items.length ? focused : Math.max(0, selectedIndex)

  function onKeyDown(event) {
    const next = chipKeyTarget(event.key, current, items.length)
    if (next === null) return
    event.preventDefault()
    setFocused(next)
    refs.current[next]?.focus()
    onSelect(items[next].id)
  }

  return (
    <div className="stats-chips" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, index) => {
        const active = item.id === selected
        return (
          <button
            key={item.id}
            ref={(node) => {
              refs.current[index] = node
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-${index}`}
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={index === current ? 0 : -1}
            className={active ? 'stats-chip active' : 'stats-chip'}
            onFocus={() => setFocused(index)}
            onClick={() => onSelect(item.id)}
          >
            <span className="stats-chip-label">{item.label}</span>
            <CountBadge className="stats-chip-count" count={item.count} noun={noun} />
            <AlertBadge alert={item.alert} />
          </button>
        )
      })}
    </div>
  )
}

/** Keyboard-navigable tabs whose selection follows focus. */
export function SegmentedTabs({ label, items, selected, onSelect, idPrefix, panelPrefix, className = '', noun = '' }) {
  const refs = useRef([])
  const index = Math.max(0, items.findIndex((item) => item.id === selected))

  function onKeyDown(event) {
    const next = chipKeyTarget(event.key, index, items.length)
    if (next === null) return
    event.preventDefault()
    onSelect(items[next].id)
    refs.current[next]?.focus()
  }

  return (
    <div className={`stats-segments ${className}`.trim()} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, position) => {
        const active = position === index
        return (
          <button
            key={item.id}
            ref={(node) => {
              refs.current[position] = node
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-${item.id}`}
            aria-selected={active}
            aria-controls={`${panelPrefix}-${item.id}`}
            tabIndex={active ? 0 : -1}
            className={active ? 'stats-segment active' : 'stats-segment'}
            onClick={() => onSelect(item.id)}
          >
            <span className="stats-segment-label">{item.label}</span>
            {item.count !== undefined && <CountBadge className="stats-segment-count" count={item.count} noun={noun} />}
            <AlertBadge alert={item.alert} />
          </button>
        )
      })}
    </div>
  )
}
