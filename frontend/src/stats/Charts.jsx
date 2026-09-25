import { useId, useRef, useState } from 'react'
import {
  agoLabel,
  axisLabel,
  downsample,
  elapsedPath,
  heatColor,
  indexAt,
  lastNumber,
  linePath,
  spanLabel,
  stackTotals,
  stackedPaths,
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

function useHover(length) {
  const plot = useRef(null)
  const [index, setIndex] = useState(-1)
  const onPointerMove = (event) => {
    const rect = plot.current?.getBoundingClientRect()
    if (rect?.width) setIndex(indexAt((event.clientX - rect.left) / rect.width, length))
  }
  return { plot, index, onPointerMove, onPointerLeave: () => setIndex(-1) }
}

function Legend({ series, unit, index }) {
  return (
    <ul className="dash-legend">
      {series.map((item) => {
        const value = index >= 0 ? item.values[index] : lastNumber(item.values)
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
        {headline !== undefined && <span className="dash-chart-value">{headline}</span>}
        {!compact && (
          <span className="dash-chart-scale">
            scale {axisLabel(scale.min)}–{axisLabel(scale.max)} {unit}
          </span>
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
          <span>now</span>
        </div>
      )}
    </figure>
  )
}

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
      legend={series.length > 1 ? <Legend series={series} unit={unit} index={hover.index} /> : null}
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
          <span key={line.tone} className={`dash-threshold ${line.tone}`} style={{ bottom: `${percentOf(line.value, scale)}%` }} aria-hidden="true">
            {!compact && <span>{line.tone} {axisLabel(line.value)}</span>}
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
  const at = hover.index >= 0 ? hover.index : length - 1
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
                <strong>{formatValue(value ?? null, unit)}</strong>
                {share !== null && <span className="dash-share">{share}%</span>}
              </li>
            )
          })}
        </ul>
      )}
      tooltip={<span className="dash-tooltip-row">Total {formatValue(totals[hover.index] ?? null, unit)}</span>}
    >
      <svg className="dash-chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true" focusable="false">
        {areas.map((d, index) => (
          <path key={series[index].key} id={`${id}-${index}`} d={d} fill={series[index].color} fillOpacity="0.78" stroke="var(--surface)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
    </Frame>
  )
}

const HEAT_CELLS = 60

/** One row per CPU core: its load over the window as a heat strip, then its load now. */
export function CoreHeatmap({ cores, series, timestamps }) {
  return (
    <figure className="dash-chart dash-heatmap" aria-label={`Per-core CPU load over the last ${spanLabel(timestamps).replace(' ago', '') || 'samples'}`}>
      <figcaption className="dash-chart-head">
        <span className="dash-chart-title">Per-core CPU</span>
        <span className="dash-chart-scale">load over time · 0–100 %</span>
      </figcaption>
      <div className="dash-heat-rows">
        {cores.map((core) => {
          const values = series[core.key] || []
          const cells = downsample(values, HEAT_CELLS)
          const now = lastNumber(values)
          return (
            <div key={core.key} className="dash-heat-row" title={`${core.label}: ${formatValue(now, '%')}`}>
              <span className="dash-heat-label">{core.short || core.label}</span>
              <svg className="dash-heat-strip" viewBox={`0 0 ${cells.length || 1} 1`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
                {cells.map((value, index) => (
                  <rect key={index} x={index} y="0" width="1.02" height="1" fill={heatColor(value)} />
                ))}
              </svg>
              <span className="dash-heat-bar" aria-hidden="true">
                <span style={{ width: `${Math.min(100, Math.max(0, now ?? 0))}%`, background: heatColor(now) }} />
              </span>
              <span className="dash-heat-value">{formatValue(now, '%')}</span>
            </div>
          )
        })}
      </div>
      <div className="dash-chart-x" aria-hidden="true">
        <span>{spanLabel(timestamps)}</span>
        <span>now</span>
      </div>
    </figure>
  )
}

/** A single reading against its scale: the session peak, as the ops view's Power tab shows it. */
export function PeakGauge({ title, value, unit, scale, caption }) {
  const share = typeof value === 'number' ? Math.round(percentOf(value, scale)) : null
  return (
    <figure className="dash-chart dash-peak" aria-label={`${title}: ${formatValue(value, unit)}`}>
      <figcaption className="dash-chart-head">
        <span className="dash-chart-title">{title}</span>
      </figcaption>
      <strong className="dash-peak-value">{formatValue(value, unit)}</strong>
      <span className="dash-peak-bar" aria-hidden="true">
        <span style={{ width: `${share ?? 0}%` }} />
      </span>
      <span className="dash-peak-share">{share !== null ? `${share}% of the ${axisLabel(scale.max)} ${unit} scale` : 'Not reported'}</span>
      {caption && <span className="hint">{caption}</span>}
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
        <span className="dash-chart-scale">common overlap · elapsed time · scale {axisLabel(scale.min)}–{axisLabel(scale.max)} {unit}, fitted to the runs</span>
      </figcaption>
      <ul className="dash-legend">
        {lines.map((line) => {
          const near = at === null ? null : valueNear(line.points, at)
          return (
            <li key={line.id} style={{ '--series': line.color }}>
              <span className="dash-swatch" aria-hidden="true" />
              {line.baseline && <span className="dash-baseline">B</span>}
              <span>{line.name}</span>
              {near && <strong>{formatValue(near.v, unit)}</strong>}
            </li>
          )
        })}
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
