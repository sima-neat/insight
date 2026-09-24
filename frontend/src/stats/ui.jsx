// Small presentational pieces shared by the Stats panels. They reuse the Peripherals
// callout and pill so both views keep one visual language.
import { Callout, Pill } from '../peripherals/ui.jsx'
import { formatValue, sparkline, sparklineLabel, statusInfo, thresholdText } from './model.js'

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
