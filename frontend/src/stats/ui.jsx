import { useEffect, useRef, useState } from 'react'
import { ErrorNotice } from '../peripherals/ui.jsx'
import { chipKeyTarget } from './model.js'

export function OutputDetails({ label, text }) {
  return (
    <details className="stats-detail">
      <summary>{label}</summary>
      <pre className="periph-code" tabIndex={0}><code>{text}</code></pre>
    </details>
  )
}

export function FailureCallout({ notice, detailLabel = 'Output from the board', children }) {
  return (
    <ErrorNotice error={notice}>
      {notice?.detail && <OutputDetails label={detailLabel} text={notice.detail} />}
      {children}
    </ErrorNotice>
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

export function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function useStoredTab(key, tabs) {
  const [tab, setTab] = useState(() => {
    try {
      const saved = window.localStorage.getItem(key)
      return tabs.some((item) => item.id === saved) ? saved : tabs[0].id
    } catch {
      return tabs[0].id
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(key, tab)
    } catch {}
  }, [key, tab])
  return [tab, setTab]
}

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
