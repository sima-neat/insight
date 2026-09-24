// Small presentational pieces shared by the Stats panels. They reuse the Peripherals
// callout and pill so both views keep one visual language.
import { useRef, useState } from 'react'
import { Callout, Pill } from '../peripherals/ui.jsx'
import { chipKeyTarget, formatValue, sparkline, sparklineLabel, statusInfo, thresholdText } from './model.js'

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

/**
 * One backend failure, in the words the backend chose: its sentence as the title, its
 * hint below it, and any command output it attached behind a disclosure. A bare code or
 * a stack trace is never shown.
 */
export function FailureCallout({ notice, detailLabel = 'Output from the board', children }) {
  if (!notice) return null
  return (
    <>
      <p className="sr-only" role="alert">{`${notice.title}. ${notice.message}`}</p>
      <Callout tone="danger" title={notice.title}>
        <p>{notice.message}</p>
        {notice.hint && <p className="hint">{notice.hint}</p>}
        {notice.detail && (
          <details className="stats-detail">
            <summary>{detailLabel}</summary>
            <pre className="periph-code" tabIndex={0}><code>{notice.detail}</code></pre>
          </details>
        )}
        {children}
      </Callout>
    </>
  )
}

export function Sparkline({ metric, values }) {
  const spark = sparkline(values, 132, 30)
  if (!spark) return <span className="stats-spark-empty" aria-hidden="true" />
  return (
    <svg className="stats-spark" viewBox="0 0 132 30" role="img" aria-label={sparklineLabel(metric, spark)} focusable="false">
      <polyline points={spark.points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function MetricCard({ metric, values }) {
  const status = statusInfo(metric.status)
  const thresholds = thresholdText(metric)
  return (
    <div className={`stats-metric-card tone-${metric.status}`}>
      <div className="stats-metric-head">
        <span className="stats-metric-label" title={metric.description || undefined}>{metric.label}</span>
        {metric.status !== 'ok' && <Pill tone={status.tone}>{status.label}</Pill>}
      </div>
      <span className="stats-metric-value">{formatValue(metric.value, metric.unit)}</span>
      <Sparkline metric={metric} values={values} />
      {thresholds && <span className="hint">{thresholds}</span>}
    </div>
  )
}

/**
 * A single-select row of chips with tab semantics. The chips wrap onto further lines rather
 * than scroll or shrink. Focus is roving: Tab enters and leaves the row, the arrow keys, Home
 * and End move within it. With `automatic` the focused chip is selected as focus moves;
 * otherwise Enter or Space selects it. With `collapsible`, selecting the selected chip again
 * selects nothing, which closes its panel.
 */
export function ChipTabs({ label, items, selected, onSelect, idPrefix, panelId, noun = '', automatic = false, collapsible = false }) {
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
    if (automatic) onSelect(items[next].id)
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
            onClick={() => onSelect(collapsible && active ? null : item.id)}
          >
            <span className="stats-chip-label">{item.label}</span>
            <span className="stats-chip-count">
              {item.count}
              {noun && <span className="sr-only">{` ${noun}${item.count === 1 ? '' : 's'}`}</span>}
            </span>
            {item.alert && (
              <span className={`stats-chip-alert tone-${item.alert.tone}`}>
                {item.alert.count} {item.alert.tone === 'critical' ? 'critical' : `warning${item.alert.count === 1 ? '' : 's'}`}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A short row of tabs, each owning its own panel (`${panelPrefix}-${id}`). Selection follows
 * focus: the arrow keys, Home and End move to a tab and show its panel at once, since every
 * panel here is already in memory. Only the selected tab is in the Tab order. An item may
 * carry a count and a threshold alert, which are drawn after its label.
 */
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
            {item.hint && <span className="stats-segment-hint">{item.hint}</span>}
            {item.count !== undefined && (
              <span className="stats-segment-count">
                {item.count}
                {noun && <span className="sr-only">{` ${noun}${item.count === 1 ? '' : 's'}`}</span>}
              </span>
            )}
            {item.alert && (
              <span className={`stats-chip-alert tone-${item.alert.tone}`}>
                {item.alert.count} {item.alert.tone === 'critical' ? 'critical' : `warning${item.alert.count === 1 ? '' : 's'}`}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
