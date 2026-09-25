import { useEffect, useMemo, useState } from 'react'
import { Callout } from '../peripherals/ui.jsx'
import { CoreHeatmap, StackedChart, StatTile, TimeChart } from './Charts.jsx'
import {
  DASH_TABS,
  DASH_TAB_KEY,
  dashTabFrom,
  lastNumber,
  metricByKey,
  metricsMatching,
  niceCeil,
  scaleFor,
  seriesOf,
  stackTotals,
  thermalGroups,
  thermalMaxSeries,
  thresholdLines
} from './dashboard.js'
import { formatValue, isThermalMetric, metricAlert, metricSection, sparkline, sparklineLabel, sessionCsv, sessionCsvFilename, statusInfo, thresholdText, timeAgo } from './model.js'
import { FailureCallout, SegmentedTabs } from './ui.jsx'

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)']
const STORAGE_GROUP = /^(disk|diskio|network|storage|nvme)$/i
const SYSTEM_KEYS = /^(cpu_|linux_mem|mla_mem|ev74_)/

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.hidden = true
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function readTab() {
  try {
    return dashTabFrom(window.localStorage.getItem(DASH_TAB_KEY))
  } catch {
    return dashTabFrom(null)
  }
}

function saveTab(tab) {
  try {
    window.localStorage.setItem(DASH_TAB_KEY, tab)
  } catch {
    // A tab that is not remembered opens on Overview next time; nothing else depends on it.
  }
}

/** A chart for one metric, or nothing when the board does not report it. */
function MetricChart({ model, metricKey, title, ceiling, headline, height, compact, references = [] }) {
  const metric = metricByKey(model, metricKey)
  if (!metric) return null
  const values = seriesOf(model, metricKey)
  // Temperatures share the thermal colour, as the Thermal max chart does.
  const color = isThermalMetric(metric) ? 'var(--chart-thermal)' : COLORS[0]
  return (
    <TimeChart
      title={title || metric.label}
      headline={headline ?? formatValue(metric.value, metric.unit)}
      series={[{ key: metric.key, label: metric.short || metric.label, values, color }]}
      scale={scaleFor(metric.unit, [values, [metric.value]], ceiling)}
      unit={metric.unit}
      timestamps={model.timestamps}
      thresholds={[...thresholdLines(metric), ...references]}
      tone={metric.status}
      height={height}
      compact={compact}
    />
  )
}

/** Two or more metrics of one unit on one chart: network in and out, disk reads and writes. */
function PairChart({ model, keys, labels = [], title, height }) {
  const metrics = keys.map((key, index) => ({ metric: metricByKey(model, key), label: labels[index] })).filter((entry) => entry.metric)
  if (!metrics.length) return null
  const unit = metrics[0].metric.unit
  const series = metrics.map(({ metric, label }, index) => ({ key: metric.key, label: label || metric.short || metric.label, values: seriesOf(model, metric.key), color: COLORS[index] }))
  const total = metrics.reduce((sum, { metric }) => sum + (typeof metric.value === 'number' ? metric.value : 0), 0)
  return (
    <TimeChart
      title={title}
      headline={formatValue(total, unit)}
      series={series}
      scale={scaleFor(unit, series.map((item) => item.values))}
      unit={unit}
      timestamps={model.timestamps}
      height={height}
    />
  )
}

function ThermalMaxChart({ model, height }) {
  const sensors = model.metrics.filter(isThermalMetric)
  if (!sensors.length) return null
  const values = thermalMaxSeries(model)
  const now = lastNumber(values)
  const worst = sensors.reduce((hot, metric) => (typeof metric.value === 'number' && (!hot || metric.value > hot.value) ? metric : hot), null)
  return (
    <TimeChart
      title="Thermal max"
      headline={`${formatValue(now, 'C')}${worst ? ` (${worst.short || worst.label})` : ''}`}
      series={[{ key: 'thermal-max', label: 'Hottest sensor', values, color: 'var(--chart-thermal)' }]}
      scale={scaleFor('C', [values])}
      unit="C"
      timestamps={model.timestamps}
      thresholds={thresholdLines(sensors[0])}
      tone={worst?.status}
      height={height}
    />
  )
}

function powerCeiling(model) {
  const keys = ['power_current_watts', 'power_average_watts', 'power_peak_watts']
  const values = keys.flatMap((key) => [...seriesOf(model, key), metricByKey(model, key)?.value]).filter((value) => typeof value === 'number')
  return values.length ? niceCeil(Math.max(...values) * 1.1) : null
}

/**
 * Every metric as one list in Sentinel's order: short name, group, value, a history trace across
 * the row and a status. The long name, description and thresholds are on the name's tooltip.
 */
export function OpsList({ metrics, series, caption }) {
  return (
    <table className="stats-ops">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col">Group</th>
          <th scope="col" className="stats-ops-num">Value</th>
          <th scope="col" className="stats-ops-history">Trend</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {metrics.map((metric) => {
          const status = statusInfo(metric.status)
          const tip = [metric.label, metric.description, thresholdText(metric)].filter(Boolean).join(' — ')
          const spark = sparkline(series[metric.key], 400, 20)
          return (
            <tr key={metric.key} className={`tone-${metric.status}`}>
              <th scope="row" title={tip}>{metric.short || metric.label}</th>
              <td className="stats-ops-group">{metric.group}</td>
              <td className="stats-ops-num">{formatValue(metric.value, metric.unit)}</td>
              <td className="stats-ops-history">
                {spark ? (
                  <svg className="stats-ops-spark" viewBox="0 0 400 20" preserveAspectRatio="none" role="img" aria-label={sparklineLabel(metric, spark)} focusable="false">
                    <polyline points={spark.points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                  </svg>
                ) : (
                  <span className="stats-ops-spark empty" aria-hidden="true" />
                )}
              </td>
              <td className="stats-ops-status">{status.label}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Card({ title, note, children, className = '' }) {
  return (
    <section className={`dash-card ${className}`.trim()}>
      {title && (
        <h3 className="dash-card-title">
          {title}
          {note && <span className="dash-card-note">{note}</span>}
        </h3>
      )}
      {children}
    </section>
  )
}

function OverviewView({ model }) {
  return (
    <>
      <div className="dash-grid three">
        <ThermalMaxChart model={model} />
        <MetricChart model={model} metricKey="power_current_watts" title="Current power" ceiling={powerCeiling(model)} />
        <MetricChart model={model} metricKey="cpu_usage_pct" title="CPU" />
        <MetricChart model={model} metricKey="linux_mem_used_pct" title="Memory" />
        <MetricChart model={model} metricKey="mla_mem_allocated_mb" title="MLA memory" />
        <PairChart model={model} keys={['net_rx_mbps', 'net_tx_mbps']} labels={['Receive', 'Transmit']} title="Network" />
      </div>
      <details className="dash-card dash-all">
        <summary className="dash-card-title">
          All metrics
          <span className="dash-card-note">{model.metrics.length} metrics</span>
        </summary>
        <OpsList metrics={model.metrics} series={model.series} caption="All metrics" />
      </details>
    </>
  )
}

function ThermalView({ model }) {
  const groups = thermalGroups(model)
  const [chosen, setChosen] = useState(groups[0]?.name || '')
  const group = groups.find((entry) => entry.name === chosen) || groups[0]
  if (!groups.length) return <p className="hint">Sentinel reported no temperatures on this board.</p>
  const items = groups.map((entry) => ({ id: entry.name, label: entry.name, count: entry.metrics.length, alert: metricAlert(entry.metrics) }))
  return (
    <>
      <ThermalMaxChart model={model} height={150} />
      <Card className="dash-sensors">
        <SegmentedTabs
          label="Thermal sensor groups"
          items={items}
          selected={group.name}
          onSelect={setChosen}
          idPrefix="dash-thermal-tab"
          panelPrefix="dash-thermal"
          className="dash-subtabs"
          noun="sensor"
        />
        <div id={`dash-thermal-${group.name}`} role="tabpanel" aria-labelledby={`dash-thermal-tab-${group.name}`} className="dash-grid sensors">
          {group.metrics.map((metric) => (
            <MetricChart key={metric.key} model={model} metricKey={metric.key} title={metric.short || metric.label} height={54} compact />
          ))}
        </div>
      </Card>
    </>
  )
}

function PowerView({ model }) {
  const ceiling = powerCeiling(model)
  const current = metricByKey(model, 'power_current_watts')
  const average = metricByKey(model, 'power_average_watts')
  const peak = metricByKey(model, 'power_peak_watts')
  const rails = metricsMatching(model, /^power_rail_/)
  const railSeries = rails.map((metric, index) => ({ key: metric.key, label: metric.short || metric.label, values: seriesOf(model, metric.key), color: COLORS[index % COLORS.length] }))
  const railTotal = rails.reduce((sum, metric) => sum + (typeof metric.value === 'number' ? metric.value : 0), 0)
  const totals = stackTotals(railSeries.map((item) => item.values))
  const stats = [
    { metric: current, title: 'Current' },
    { metric: average, title: 'Session average' },
    { metric: peak, title: 'Session peak' }
  ].filter((entry) => entry.metric)
  return (
    <>
      {stats.length > 0 && (
        <div className="dash-grid three dash-stats">
          {stats.map(({ metric, title }) => <StatTile key={metric.key} title={title} value={metric.value} unit="W" />)}
        </div>
      )}
      <MetricChart
        model={model}
        metricKey="power_current_watts"
        title="Board power"
        headline=""
        ceiling={ceiling}
        height={150}
        references={typeof average?.value === 'number' ? [{ value: average.value, tone: 'reference', label: 'Session average' }] : []}
      />
      {rails.length > 0 && (
        <StackedChart
          title="Power rails"
          headline={`${railTotal.toFixed(2)} W across ${rails.length} rails`}
          series={railSeries}
          scale={scaleFor('W', [totals])}
          unit="W"
          timestamps={model.timestamps}
        />
      )}
    </>
  )
}

const SYSTEM_VIEWS = [
  { id: 'summary', label: 'CPU & memory' },
  { id: 'cores', label: 'Per-core CPU' }
]

function SystemView({ model }) {
  const [view, setView] = useState('summary')
  const cores = metricsMatching(model, /^cpu_core_\d+_usage_pct$/)
  const load = metricByKey(model, 'cpu_load_1')
  const memMb = metricByKey(model, 'linux_mem_used_mb')
  const cmaTotal = metricByKey(model, 'ev74_cma_total_mb')
  const loadPct = metricByKey(model, 'cpu_load_1_pct')
  const memPct = metricByKey(model, 'linux_mem_used_pct')
  // Per-core CPU is its own view: sixteen rows beside five charts was more than one glance holds.
  const views = cores.length ? SYSTEM_VIEWS.map((entry) => (entry.id === 'cores' ? { ...entry, count: cores.length } : entry)) : SYSTEM_VIEWS.slice(0, 1)
  const shown = views.some((entry) => entry.id === view) ? view : 'summary'
  return (
    <>
      {views.length > 1 && (
        <SegmentedTabs
          label="System views"
          items={views}
          selected={shown}
          onSelect={setView}
          idPrefix="dash-system-tab"
          panelPrefix="dash-system"
          className="dash-subtabs"
          noun="core"
        />
      )}
      <div id={`dash-system-${shown}`} role="tabpanel" aria-labelledby={`dash-system-tab-${shown}`} className="dash-panel">
        {shown === 'cores' ? (
          <CoreHeatmap cores={cores} series={model.series} timestamps={model.timestamps} />
        ) : (
          <div className="dash-grid three">
            <MetricChart model={model} metricKey="cpu_usage_pct" title="CPU usage" />
            <MetricChart
              model={model}
              metricKey="cpu_load_1_pct"
              title="Load average (1 minute)"
              headline={load && loadPct ? `${formatValue(load.value, '')} (${formatValue(loadPct.value, '%')})` : undefined}
            />
            <MetricChart
              model={model}
              metricKey="linux_mem_used_pct"
              title="Linux memory"
              headline={memMb && memPct ? `${formatValue(memPct.value, '%')} (${formatValue(memMb.value, 'MB')})` : undefined}
            />
            <MetricChart model={model} metricKey="mla_mem_allocated_mb" title="MLA memory" />
            <MetricChart model={model} metricKey="ev74_cma_used_mb" title="EV74 CMA used" ceiling={cmaTotal?.value} />
          </div>
        )}
      </div>
    </>
  )
}

function StorageView({ model }) {
  const nvme = model.metrics.find((metric) => /nvme/i.test(metric.key) && metric.unit === '%')
  const storage = model.metrics.filter((metric) => STORAGE_GROUP.test(metric.group || '') || /^(disk_|net_|nvme)/.test(metric.key))
  return (
    <>
      <div className="dash-grid three">
        <MetricChart model={model} metricKey="disk_emmc_used_pct" title="eMMC used" />
        {nvme && <MetricChart model={model} metricKey={nvme.key} title="NVMe used" />}
        <PairChart model={model} keys={['net_rx_mbps', 'net_tx_mbps']} labels={['Receive', 'Transmit']} title="Network" />
        <PairChart model={model} keys={['disk_emmc_read_mbps', 'disk_emmc_write_mbps']} labels={['Read', 'Write']} title="eMMC I/O" />
      </div>
      {storage.length > 0 && (
        <Card title="Storage and network metrics">
          <OpsList metrics={storage} series={model.series} caption="Storage and network metrics" />
        </Card>
      )}
    </>
  )
}

function tabAlert(model, id) {
  const metrics = model.metrics
  if (id === 'thermal') return metricAlert(metrics.filter(isThermalMetric))
  if (id === 'power') return metricAlert(metrics.filter((metric) => metricSection(metric) === 'power'))
  if (id === 'system') return metricAlert(metrics.filter((metric) => SYSTEM_KEYS.test(metric.key)))
  if (id === 'storage') return metricAlert(metrics.filter((metric) => STORAGE_GROUP.test(metric.group || '')))
  if (id === 'overview') return metricAlert(metrics)
  return null
}

/**
 * Sentinel on the board, as its own terminal dashboard lays it out: a status line, then
 * Overview, Thermal, Power, System, Storage & Network and Runs. Everything is charted over the
 * daemon's cached window, so each view opens full rather than filling while you watch.
 */
export default function SentinelDashboard({ model, startedAt, now, live, polling, stale, error, busy, onToggleLive, onRefresh, onRetry, runs }) {
  const [tab, setTab] = useState(readTab)
  useEffect(() => saveTab(tab), [tab])
  const items = useMemo(() => DASH_TABS.map((item) => ({ ...item, alert: item.id === 'runs' ? null : tabAlert(model, item.id) })), [model])
  const state = polling ? 'LIVE' : live ? 'NOT UPDATING' : 'PAUSED'
  const hasMetrics = model.metrics.length > 0
  return (
    <div className="dash">
      <section className="panel dash-bar" aria-labelledby="dash-title" aria-busy={busy}>
        <div className="dash-status">
          <span className={`dash-live${polling ? ' on' : ''}`} aria-hidden="true" />
          <h2 id="dash-title">Sentinel</h2>
          <span className={`dash-state${polling ? ' on' : ''}`}>{state}</span>
          {startedAt && (
            <span className="dash-session" title={`Sentinel started ${new Date(startedAt).toLocaleString()}`}>
              Session started {timeAgo(startedAt, now)}
            </span>
          )}
          <span className="dash-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => download(sessionCsvFilename(), sessionCsv(model))}
              disabled={!model.timestamps.length}
              title={`Every metric at each of the ${model.timestamps.length} samples Sentinel holds for this session`}
            >
              Export CSV
            </button>
            <button type="button" className="btn-tonal" onClick={onToggleLive}>
              {live ? 'Pause updates' : 'Resume updates'}
            </button>
          </span>
        </div>
        <p className="sr-only" role="status">
          {polling ? 'Metrics are updating live.' : live ? 'Metric updates are stopped.' : 'Metric updates are paused.'}
        </p>
        {stale && (
          <Callout tone="warn" title="These values are from the previous board">
            <p>The selected board changed after this sample was read. Refresh to read the board that is selected now.</p>
            <button type="button" className="btn-tonal" onClick={onRefresh}>Refresh now</button>
          </Callout>
        )}
        <FailureCallout notice={error}>
          {error?.retryable && <button type="button" className="btn-ghost" onClick={onRetry}>Retry</button>}
        </FailureCallout>
        <SegmentedTabs label="Sentinel views" items={items} selected={tab} onSelect={setTab} idPrefix="dash-tab" panelPrefix="dash-panel" className="dash-tabs" />
      </section>

      <div id={`dash-panel-${tab}`} role="tabpanel" aria-labelledby={`dash-tab-${tab}`} className="dash-panel">
        {tab === 'runs' && runs}
        {tab !== 'runs' && !hasMetrics && <p className="hint">Waiting for the first reading from Sentinel…</p>}
        {tab === 'overview' && hasMetrics && <OverviewView model={model} />}
        {tab === 'thermal' && hasMetrics && <ThermalView model={model} />}
        {tab === 'power' && hasMetrics && <PowerView model={model} />}
        {tab === 'system' && hasMetrics && <SystemView model={model} />}
        {tab === 'storage' && hasMetrics && <StorageView model={model} />}
      </div>
    </div>
  )
}
