import { useId, useRef, useState } from 'react'
import {
  agoLabel,
  axisLabel,
  coreSummary,
  fixedValue,
  loadColor,
  elapsedPath,
  indexAt,
  lastNumber,
  linePath,
  scaleText,
  spanLabel,
  stackTotals,
  stackedPaths,
  unitAfter,
  valueNear
} from './dashboard.js'
import { formatValue } from './model.js'

// The plot is drawn in a 600 x 100 box and stretched to the card; labels and markers are HTML
// on top of it, so they keep their shape at any width.
const WIDTH = 600
const HEIGHT = 100

function percentOf(value, scale) {
  const span = scale.max - scale.min || 1
  return ((Math.min(scale.max, Math.max(scale.min, value)) - scale.min) / span) * 100
}

// The pointer's position across the plot is what is remembered, not the sample under it: new
// samples shift the data every poll, and the readout must follow what is under a still cursor.
function useHover(length) {
  const plot = useRef(null)
  const [fraction, setFraction] = useState(null)
  const onPointerMove = (event) => {
    const rect = plot.current?.getBoundingClientRect()
    if (rect?.width) setFraction(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)))
  }
  const index = fraction === null ? -1 : indexAt(fraction, length)
  return { plot, index, onPointerMove, onPointerLeave: () => setFraction(null) }
}

// Legends show the current reading and never follow the pointer: a hovered value would change
// their width on every move and reflow the card. The tooltip carries the hovered moment.
function Legend({ series, unit }) {
  return (
    <ul className="dash-legend">
      {series.map((item) => {
        const value = lastNumber(item.values)
        return (
          <li key={item.key} style={{ '--series': item.color }}>
            <span className="dash-swatch" aria-hidden="true" />
            <span>{item.label}</span>
            <strong>{formatValue(value ?? null, unit)}</strong>
          </li>
        )
      })}
    </ul>
  )
}

function Frame({ title, headline, scale, unit, timestamps, compact, tone, label, children, legend, hover, tooltip }) {
  return (
    <figure className={`dash-chart tone-${tone || 'ok'}${compact ? ' compact' : ''}`} aria-label={label}>
      <figcaption className="dash-chart-head">
        <span className="dash-chart-title">{title}</span>
        {headline !== undefined && headline !== null && headline !== '' && <span className="dash-chart-value">{headline}</span>}
        {!compact && (
          <span className="dash-chart-scale">Scale {scaleText(scale, unit)}</span>
        )}
      </figcaption>
      {legend}
      <div className="dash-chart-body">
        <div className="dash-chart-y" aria-hidden="true">
          <span>{axisLabel(scale.max)}</span>
          <span>{axisLabel(scale.min)}</span>
        </div>
        <div className="dash-chart-plot" ref={hover.plot} onPointerMove={hover.onPointerMove} onPointerLeave={hover.onPointerLeave}>
          {children}
          {hover.index >= 0 && (
            <>
              <span className="dash-crosshair" style={{ left: `${(hover.index / Math.max(1, (timestamps?.length || 1) - 1)) * 100}%` }} aria-hidden="true" />
              <span className={`dash-tooltip${hover.index > (timestamps?.length || 0) / 2 ? ' flip' : ''}`} style={{ left: `${(hover.index / Math.max(1, (timestamps?.length || 1) - 1)) * 100}%` }} aria-hidden="true">
                <span className="dash-tooltip-time">{agoLabel(timestamps, hover.index)}</span>
                {tooltip}
              </span>
            </>
          )}
        </div>
      </div>
      {!compact && (
        <div className="dash-chart-x" aria-hidden="true">
          <span>{spanLabel(timestamps)}</span>
          <span>Now</span>
        </div>
      )}
    </figure>
  )
}

const THRESHOLD_NAMES = { warn: 'Warning', critical: 'Critical' }

/**
 * A time chart on a fixed scale, the way Sentinel's ops view draws one: an area under each line,
 * the metric's warn and critical levels, the newest reading marked, and a crosshair on hover
 * that reads every series at that moment.
 */
export function TimeChart({ title, headline, series, scale, unit, timestamps, thresholds = [], height = 96, compact = false, tone }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const length = Math.max(0, ...series.map((item) => item.values.length))
  const hover = useHover(length)
  const paths = series.map((item) => linePath(item.values, scale, WIDTH, HEIGHT))
  const label = `${title}: ${headline ?? ''}${spanLabel(timestamps) ? `, over the last ${spanLabel(timestamps).replace(' ago', '')}` : ''}`
  return (
    <Frame
      title={title}
      headline={headline}
      scale={scale}
      unit={unit}
      timestamps={timestamps}
      compact={compact}
      tone={tone}
      label={label}
      hover={hover}
      legend={series.length > 1 ? <Legend series={series} unit={unit} /> : null}
      tooltip={series.map((item) => (
        <span key={item.key} className="dash-tooltip-row" style={{ '--series': item.color }}>
          {series.length > 1 && <span className="dash-swatch" />}
          {formatValue(item.values[hover.index] ?? null, unit)}
        </span>
      ))}
    >
      <svg className="dash-chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true" focusable="false">
        <defs>
          {series.map((item, index) => (
            <linearGradient key={item.key} id={`${id}-${index}`} x1="0" y1="0" x2="0" y2="1" style={{ color: item.color }}>
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
            </linearGradient>
          ))}
        </defs>
        {paths.map((path, index) => (
          <g key={series[index].key} style={{ color: series[index].color }}>
            {path.area && <path d={path.area} fill={`url(#${id}-${index})`} />}
            <path d={path.line} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </svg>
      {thresholds
        .filter((line) => line.value > scale.min && line.value < scale.max)
        .map((line) => (
          <span key={line.label || line.tone} className={`dash-threshold ${line.tone}`} style={{ bottom: `${percentOf(line.value, scale)}%` }} aria-hidden="true">
            {!compact && <span>{line.label || THRESHOLD_NAMES[line.tone] || line.tone} {axisLabel(line.value)}{unitAfter(unit)}</span>}
          </span>
        ))}
      {paths.map((path, index) => path.last && (
        <span
          key={series[index].key}
          className="dash-dot"
          style={{ left: `${(path.last.x / WIDTH) * 100}%`, top: `${(path.last.y / HEIGHT) * 100}%`, '--series': series[index].color }}
          aria-hidden="true"
        />
      ))}
    </Frame>
  )
}

/** Series stacked into one total, each band its own colour: where the board's power goes. */
export function StackedChart({ title, headline, series, scale, unit, timestamps, height = 150 }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const lists = series.map((item) => item.values)
  const length = Math.max(0, ...lists.map((list) => list.length))
  const hover = useHover(length)
  const areas = stackedPaths(lists, scale, WIDTH, HEIGHT)
  const totals = stackTotals(lists)
  const at = length - 1
  const total = totals[at] ?? null
  return (
    <Frame
      title={title}
      headline={headline}
      scale={scale}
      unit={unit}
      timestamps={timestamps}
      label={`${title}: ${headline ?? ''}`}
      hover={hover}
      legend={(
        <ul className="dash-legend dash-legend-grid">
          {series.map((item) => {
            const value = item.values[at]
            const share = total && typeof value === 'number' ? Math.round((value / total) * 100) : null
            return (
              <li key={item.key} style={{ '--series': item.color }}>
                <span className="dash-swatch" aria-hidden="true" />
                <span>{item.label}</span>
                <strong>{fixedValue(value ?? null, unit, 2)}</strong>
                {share !== null && <span className="dash-share">{share}%</span>}
              </li>
            )
          })}
        </ul>
      )}
      tooltip={(
        <>
          <span className="dash-tooltip-row dash-tooltip-total">Total {fixedValue(totals[hover.index] ?? null, unit, 2)}</span>
          {series.map((item) => (
            <span key={item.key} className="dash-tooltip-row" style={{ '--series': item.color }}>
              <span className="dash-swatch" />
              <span className="dash-tooltip-label">{item.label}</span>
              {fixedValue(item.values[hover.index] ?? null, unit, 2)}
            </span>
          ))}
        </>
      )}
    >
      <svg className="dash-chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true" focusable="false">
        {areas.map((d, index) => (
          <path key={series[index].key} id={`${id}-${index}`} d={d} fill={series[index].color} fillOpacity="0.78" stroke="var(--surface)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
    </Frame>
  )
}

/**
 * Per-core CPU as a heatmap, the way Grafana and Netdata show many cores: a row per core, a column
 * per slice of the window, one blue for load. Only the newest column changes as samples arrive, so
 * the view stays still; the figure beside each core is its one-minute average.
 */
export function CoreHeatmap({ cores, series, timestamps }) {
  const { rows, average, busiest } = coreSummary(cores, series)
  const [pointer, setPointer] = useState(null)
  const columns = Math.max(0, ...rows.map((row) => row.cells.length))
  const span = spanLabel(timestamps)
  const windowText = span.replace(' ago', '')
  const sampleCount = timestamps?.length || 0
  const onPointerMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width && rect.height) setPointer({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height })
  }
  // Worked out on every render from where the pointer is, so it follows new columns as they arrive.
  const cell = (at) => Math.min(at.count - 1, Math.max(0, Math.floor(at.fraction * at.count)))
  const hover = pointer && rows.length && columns
    ? { row: cell({ fraction: pointer.y, count: rows.length }), column: cell({ fraction: pointer.x, count: columns }) }
    : null
  const hovered = hover && rows[hover.row]
  // The newest sample in the hovered column, to say how long ago that slice of the window was.
  const sampleOf = (column) => Math.min(sampleCount - 1, Math.floor(((column + 1) / Math.max(1, columns)) * sampleCount) - 1)
  return (
    <figure className="dash-chart dash-cores" aria-label={`Per-core CPU load over the last ${windowText || 'samples'}; one-minute average ${formatValue(average, '%')}`}>
      <figcaption className="dash-chart-head">
        <span className="dash-chart-title">Per-core CPU</span>
        <span className="dash-chart-value">{formatValue(average, '%')}</span>
        <span className="dash-core-meta">
          1-minute average of {rows.length} cores{busiest ? ` · busiest ${busiest.name} at ${formatValue(busiest.recent, '%')}` : ''}
        </span>
        <span className="dash-heat-scale" aria-hidden="true">
          0%
          <span className="dash-heat-ramp" style={{ background: `linear-gradient(90deg, ${loadColor(0)}, ${loadColor(50)}, ${loadColor(100)})` }} />
          100%
        </span>
      </figcaption>
      <div className="dash-heat" style={{ '--rows': rows.length }}>
        <div className="dash-heat-names" aria-hidden="true">
          {rows.map((row) => <span key={row.key}>{row.name}</span>)}
        </div>
        <div className="dash-heat-grid" onPointerMove={onPointerMove} onPointerLeave={() => setPointer(null)}>
          <svg viewBox={`0 0 ${columns * 10} ${rows.length * 10}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
            {rows.map((row, r) => row.cells.map((value, c) => (
              <rect key={`${row.key}-${c}`} x={c * 10 + 0.6} y={r * 10 + 0.8} width="8.8" height="8.4" rx="1.2" fill={loadColor(value)} />
            )))}
            {hover && <rect className="dash-heat-focus" x={hover.column * 10 + 0.2} y={hover.row * 10 + 0.4} width="9.6" height="9.2" rx="1.4" />}
          </svg>
          {hovered && (
            <span className={`dash-tooltip${hover.column > columns / 2 ? ' flip' : ''}`} style={{ left: `${((hover.column + 0.5) / columns) * 100}%`, top: `${(hover.row / rows.length) * 100}%` }} aria-hidden="true">
              <span className="dash-tooltip-time">{hovered.name} · {agoLabel(timestamps, sampleOf(hover.column))}</span>
              <span className="dash-tooltip-row">{formatValue(hovered.cells[hover.column], '%')} average</span>
            </span>
          )}
        </div>
        <div className="dash-heat-values">
          {rows.map((row) => (
            <span key={row.key} className={`tone-${row.tone}`} title={`${row.label}: ${formatValue(row.recent, '%')}, 1-minute average`}>
              {formatValue(row.recent, '%')}
            </span>
          ))}
        </div>
      </div>
      <div className="dash-heat-foot" aria-hidden="true">
        <span className="dash-heat-axis">
          <span>{span}</span>
          <span>Now</span>
        </span>
      </div>
    </figure>
  )
}

/** One figure with its name: a headline number for a dashboard's top row. */
export function StatTile({ title, value, unit, digits = 1, tone }) {
  const text = fixedValue(value, unit, digits)
  return (
    <figure className={`dash-chart dash-stat tone-${tone || 'ok'}`} aria-label={`${title}: ${text}`}>
      <figcaption className="dash-chart-title">{title}</figcaption>
      <strong className="dash-stat-value">{text}</strong>
    </figure>
  )
}

/**
 * Compared runs of one series over elapsed time, as Sentinel's Compare Runs overlays them: the
 * window every run covers, the baseline drawn heavier, and a readout of each run on hover.
 */
export function ElapsedChart({ title, lines, window, scale, unit, height = 200 }) {
  const hover = useHover(101)
  const at = hover.index >= 0 ? (hover.index / 100) * window : null
  return (
    <figure className="dash-chart dash-elapsed" aria-label={`${title} for ${lines.length} runs over their common ${window.toFixed(1)} s`}>
      <figcaption className="dash-chart-head">
        <span className="dash-chart-title">{title}</span>
        <span className="dash-chart-scale">Common window · Scale {scaleText(scale, unit)}, fitted to the runs</span>
      </figcaption>
      <ul className="dash-legend">
        {lines.map((line) => (
          <li key={line.id} style={{ '--series': line.color }}>
            <span className="dash-swatch" aria-hidden="true" />
            {line.baseline && <span className="dash-baseline">B</span>}
            <span>{line.name}</span>
          </li>
        ))}
      </ul>
      <div className="dash-chart-body">
        <div className="dash-chart-y" aria-hidden="true">
          <span>{axisLabel(scale.max)}</span>
          <span>{axisLabel(scale.min)}</span>
        </div>
        <div className="dash-chart-plot" ref={hover.plot} onPointerMove={hover.onPointerMove} onPointerLeave={hover.onPointerLeave}>
          <svg className="dash-chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true" focusable="false">
            {lines.map((line) => (
              <path
                key={line.id}
                d={elapsedPath(line.points, window, scale, WIDTH, HEIGHT)}
                fill="none"
                stroke={line.color}
                strokeWidth={line.baseline ? 2.6 : 1.6}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {hover.index >= 0 && (
            <>
              <span className="dash-crosshair" style={{ left: `${hover.index}%` }} aria-hidden="true" />
              <span className={`dash-tooltip${hover.index > 50 ? ' flip' : ''}`} style={{ left: `${hover.index}%` }} aria-hidden="true">
                <span className="dash-tooltip-time">{at.toFixed(1)} s</span>
                {lines.map((line) => {
                  const near = valueNear(line.points, at)
                  return (
                    <span key={line.id} className="dash-tooltip-row" style={{ '--series': line.color }}>
                      <span className="dash-swatch" />
                      {near ? formatValue(near.v, unit) : '—'}
                    </span>
                  )
                })}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="dash-chart-x" aria-hidden="true">
        <span>0 s</span>
        <span>{window.toFixed(1)} s</span>
      </div>
    </figure>
  )
}
