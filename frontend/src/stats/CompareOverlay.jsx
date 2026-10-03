import { useState } from 'react'
import { ElapsedChart } from './Charts.jsx'
import { compareOverlay, tightScale } from './dashboard.js'
import { formatPercentDelta, formatValue } from './model.js'
import { SegmentedTabs } from './ui.jsx'

const RUN_COLORS = ['var(--chart-1)', 'var(--chart-4)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-5)', 'var(--chart-8)']

/**
 * The compared runs overlaid, as Sentinel's Compare Runs tab shows them: pick a series, see every
 * run over the time they all cover, and read each run's spread against the baseline below.
 */
export default function CompareOverlay({ payload }) {
  const [seriesId, setSeriesId] = useState('power')
  const overlay = compareOverlay(payload, seriesId)
  if (!overlay) return null
  const { spec, available, unit, overlap, rows } = overlay
  const lines = overlay.lines.map((line, index) => ({ ...line, color: RUN_COLORS[index % RUN_COLORS.length] }))
  const scale = tightScale(lines.map((line) => line.points.map((point) => point.v)))
  return (
    <div className="dash dash-compare">
      <SegmentedTabs
        label="Series to compare"
        items={available.map((entry) => ({ id: entry.id, label: entry.label }))}
        selected={spec.id}
        onSelect={setSeriesId}
        idPrefix="dash-compare-tab"
        panelPrefix="dash-compare"
        className="dash-subtabs"
      />
      <div id={`dash-compare-${spec.id}`} role="tabpanel" aria-labelledby={`dash-compare-tab-${spec.id}`} className="dash-panel">
        <ElapsedChart title={spec.label} lines={lines} window={overlap} scale={scale} unit={unit} />
        <table className="sysinfo-table stats-table dash-compare-summary">
          <caption className="sr-only">{spec.label} summary per run</caption>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col" className="stats-ops-num">Samples</th>
              <th scope="col" className="stats-ops-num">Min</th>
              <th scope="col" className="stats-ops-num">Mean</th>
              <th scope="col" className="stats-ops-num">Median</th>
              <th scope="col" className="stats-ops-num">P95</th>
              <th scope="col" className="stats-ops-num">Max</th>
              <th scope="col" className="stats-ops-num">vs. baseline</th>
              <th scope="col" className="stats-ops-num">Energy</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id}>
                <th scope="row">
                  <span className="dash-swatch" style={{ '--series': lines[index]?.color }} aria-hidden="true" />
                  {row.baseline && <span className="dash-baseline" title="Baseline">B</span>}
                  {row.name}
                </th>
                <td className="stats-ops-num">{row.samples}</td>
                <td className="stats-ops-num">{formatValue(row.minimum, unit)}</td>
                <td className="stats-ops-num">{formatValue(row.mean, unit)}</td>
                <td className="stats-ops-num">{formatValue(row.median, unit)}</td>
                <td className="stats-ops-num">{formatValue(row.p95, unit)}</td>
                <td className="stats-ops-num">{formatValue(row.maximum, unit)}</td>
                <td className="stats-ops-num">{row.baseline ? 'Baseline' : formatPercentDelta(row.delta)}</td>
                <td className="stats-ops-num">{formatValue(row.energy, 'J')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
