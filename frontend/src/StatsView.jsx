import { useEffect, useMemo, useRef, useState } from 'react'
import { countLabel } from './peripherals/model.js'
import { Callout, Pill } from './peripherals/ui.jsx'
import {
  compareRuns,
  deleteRun,
  fetchActiveTrace,
  fetchHostMetrics,
  fetchMetrics,
  fetchRun,
  fetchRuns,
  fetchSentinel,
  installSentinel,
  startTrace,
  stopTrace
} from './stats/api.js'
import {
  ALL_GROUPS,
  DELTA_ABSENCE,
  HOST_POLL_MS,
  MAX_COMPARE_RUNS,
  compareCsv,
  compareCsvFilename,
  compareTable,
  compareView,
  createRequestGuard,
  daemonInfo,
  failureNotice,
  formatPercentDelta,
  formatRelativeTime,
  formatTimestamp,
  formatValue,
  healthProblems,
  hostMetricsModel,
  metricsModel,
  pollDelay,
  runDetail,
  runList,
  runSubtitle,
  statusInfo,
  traceBar,
  traceExtrasSummary,
  traceModel,
  validateTrace
} from './stats/model.js'
import CompareOverlay from './stats/CompareOverlay.jsx'
import SentinelDashboard from './stats/Dashboard.jsx'
import { FailureCallout, KeyValueTable, OutputDetails, SegmentedTabs, downloadText, useStoredTab } from './stats/ui.jsx'

const RUNS_POLL_MS = 30000
const STATS_TABS = [
  { id: 'devkit', label: 'DevKit' },
  { id: 'host', label: 'Host' }
]
const EMPTY_FORM = { name: '', note: '', tags: '' }

function pollWhileVisible(run, delay) {
  let timer = null
  let stopped = false
  const cycle = async () => {
    timer = null
    if (stopped || document.visibilityState === 'hidden') return
    await run()
    if (!stopped && document.visibilityState !== 'hidden') {
      timer = setTimeout(cycle, typeof delay === 'function' ? delay() : delay)
    }
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(timer)
      timer = null
    } else if (timer === null) {
      cycle()
    }
  }
  onVisibility()
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

function DaemonPanel({ info, health, busy, installing, install, error, blocked, onInstall, onRetry }) {
  const problems = healthProblems(health)
  return (
    <section className="panel stats-daemon" aria-labelledby="stats-daemon-title" aria-busy={busy}>
      <div className="panel-topbar">
        <h2 id="stats-daemon-title">Sentinel daemon</h2>
        <div className="periph-actions">
          <button type="button" className="btn-ghost" onClick={onRetry} disabled={busy}>Re-check</button>
          {info.state !== 'ready' && (
            <button type="button" className="btn-tonal" onClick={onInstall} disabled={busy || !info.canInstall} title={info.installBlocked || undefined}>
              {installing ? 'Installing…' : 'Install Sentinel'}
            </button>
          )}
        </div>
      </div>
      <div className="periph-board-summary">
        <Pill tone={info.tone}>{info.label}</Pill>
        {info.version && <span className="stats-version">{info.version}</span>}
        {info.state === 'unknown' && blocked && <span className="hint">Sentinel cannot be checked until the board answers.</span>}
      </div>
      {installing && (
        <p className="hint" role="status">
          Running <code>sima-cli neat install sentinel</code> on the board. This can take several minutes.
        </p>
      )}
      <FailureCallout notice={error} detailLabel={error?.install ? 'Installer output' : undefined} />
      {!error && info.error && (
        <Callout tone={info.state === 'error' ? 'danger' : 'warn'} title={info.error.message}>
          {info.error.hint && <p>{info.error.hint}</p>}
          {info.installBlocked && info.state !== 'ready' && <p className="hint">{info.installBlocked}</p>}
        </Callout>
      )}
      {problems.length > 0 && (
        <Callout tone="warn" title="Sentinel reported collector errors">
          <ul className="periph-notes">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
        </Callout>
      )}
      {install?.log && <OutputDetails label="Installer output" text={install.log} />}
    </section>
  )
}

function TagPills({ tags }) {
  if (!tags.length) return null
  return <span className="periph-pills">{tags.map((tag) => <Pill key={tag} tone="periph-info">{tag}</Pill>)}</span>
}

function TraceBar({ trace, bar, now, field, extras, extrasShown, onToggleExtras, onStart, onStop }) {
  if (bar.recording) {
    return (
      <div className="stats-trace-bar">
        <Pill tone="ok">Recording</Pill>
        <span className="stats-trace-running">{trace.name}</span>
        {trace.startedAt && (
          <span className="hint">
            started <time dateTime={trace.startedAt} title={formatTimestamp(trace.startedAt)}>{formatRelativeTime(trace.startedAt, now)}</time>
          </span>
        )}
        <TagPills tags={trace.tags} />
        <button type="button" className="btn-tonal" onClick={onStop} disabled={bar.disabled}>{bar.stopLabel}</button>
      </div>
    )
  }
  return (
    <form id="stats-trace-form" className="stats-trace-bar" onSubmit={onStart} aria-label="Start a trace">
      <label className="stats-trace-name">
        <span className="sr-only">Trace name</span>
        <input {...field('name')} placeholder="Trace name (e.g. baseline)" spellCheck={false} required />
      </label>
      <button type="submit" className="btn-tonal" disabled={bar.disabled}>{bar.submitLabel}</button>
      <button type="button" className="btn-ghost" aria-expanded={extrasShown} aria-controls="stats-trace-extras" onClick={onToggleExtras}>
        Add note and tags
      </button>
      {!extrasShown && extras && <span className="hint">{extras}</span>}
    </form>
  )
}

function RunDetail({ openRef, detail, error, busy }) {
  const run = useMemo(() => (detail ? runDetail(detail) : null), [detail])
  return (
    <section className="stats-run-detail" aria-label={`Run ${openRef}`} aria-busy={busy}>
      <h3>{openRef}</h3>
      <FailureCallout notice={error} />
      {busy && <p className="hint" role="status">Reading the run from the board…</p>}
      {run && (
        <>
          <p className="hint stats-run-facts">
            {countLabel(run.sampleCount, 'sample')} · {countLabel(run.metrics.length, 'metric')}
            {run.range && ` · ${run.range}`}
            {run.crossed > 0 && ` · ${run.crossed} past a threshold`}
          </p>
          {run.metrics.length > 0 && (
            <div className="stats-table-scroll" role="region" aria-label={`Metrics of run ${openRef}`} tabIndex={0}>
              <table className="sysinfo-table stats-table stats-run-metrics">
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    <th scope="col">Group</th>
                    <th scope="col">Mean</th>
                    <th scope="col">Minimum</th>
                    <th scope="col">Maximum</th>
                  </tr>
                </thead>
                <tbody>
                  {run.metrics.map((metric) => (
                    <tr key={metric.key}>
                      <th scope="row" title={metric.description || undefined}>{metric.label}</th>
                      <td>{metric.group}</td>
                      <td className="stats-cell-value">{formatValue(metric.mean, metric.unit)}</td>
                      <td className="stats-cell-value">{formatValue(metric.minimum, metric.unit)}</td>
                      <td className="stats-cell-value">
                        {formatValue(metric.maximum, metric.unit)}
                        {metric.status !== 'ok' && <Pill tone={statusInfo(metric.status).tone}>{statusInfo(metric.status).label}</Pill>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {run.facts.length > 0 && (
            <details className="stats-detail">
              <summary>Run metadata</summary>
              <KeyValueTable rows={run.facts} caption={`Run ${openRef}`} />
            </details>
          )}
        </>
      )}
    </section>
  )
}

function Comparison({ compare, definitions, open, onToggle }) {
  const table = useMemo(() => compareTable(compare, definitions), [compare, definitions])
  const [group, setGroup] = useState(ALL_GROUPS)
  const [changesOnly, setChangesOnly] = useState(false)
  const view = compareView(table, { group, changesOnly })
  return (
    <section className="stats-compare" aria-labelledby="stats-compare-title">
      <div className="stats-compare-head">
        <h3 id="stats-compare-title">Comparison</h3>
        <div className="periph-actions">
          {table && (
            <button type="button" className="btn-ghost" onClick={() => downloadText(compareCsvFilename(table), compareCsv(table))}>
              Export CSV
            </button>
          )}
          <button type="button" className="btn-ghost" aria-expanded={open} aria-controls="stats-compare-body" onClick={onToggle}>
            {open ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </div>
      <div id="stats-compare-body" hidden={!open}>
        <CompareOverlay payload={compare} />
        {!table && <p className="hint">Sentinel returned no values to compare for these runs.</p>}
        {table && (
          <details className="dash-card dash-all stats-compare-metrics">
            <summary className="dash-card-title">
              Per-metric comparison
              <span className="dash-card-note">{table.rows.length} rows</span>
            </summary>
            <div className="stats-compare-filters">
              <SegmentedTabs
                label="Filter the comparison by metric group"
                items={view.groups}
                selected={view.group}
                onSelect={setGroup}
                idPrefix="stats-compare-tab"
                panelPrefix="stats-compare-panel"
                className="dash-subtabs"
                noun="row"
              />
              <label className="stats-toggle">
                <input type="checkbox" checked={changesOnly} onChange={(event) => setChangesOnly(event.target.checked)} />
                Changes only
              </label>
            </div>
            <p className="hint" role="status">{view.text}</p>
            <div id={`stats-compare-panel-${view.group}`} role="tabpanel" aria-labelledby={`stats-compare-tab-${view.group}`} className="stats-table-scroll" tabIndex={0}>
              <table className="sysinfo-table stats-table stats-compare-table">
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    {table.columns.map((column) => (
                      <th key={column.key} scope="col">
                        {column.label}
                        {column.baseline && <span className="hint">baseline</span>}
                        {column.note && <span className="hint">{column.note}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{row.label}</th>
                      {row.cells.map((cell) => (
                        <td key={cell.column} className="stats-cell-value">
                          {formatValue(cell.value, row.unit)}
                          {!cell.baseline && (
                            <span className={cell.deltaPct === null ? 'hint' : 'hint stats-delta'} title={DELTA_ABSENCE[cell.deltaAbsence]}>
                              {formatPercentDelta(cell.deltaPct)}
                              {cell.deltaAbsence && <span className="sr-only">{` no change shown, because ${DELTA_ABSENCE[cell.deltaAbsence]}`}</span>}
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </section>
  )
}

function RunsPanel({ trace, traceBusy, traceError, form, formError, onFormChange, onStart, onStop, now, runs, selected, busy, error, openRef, deleteBusy, deleteError, compareBusy, onToggle, onOpen, onCompare, onDelete, onClear, children }) {
  const [confirming, setConfirming] = useState(false)
  const [extrasOpen, setExtrasOpen] = useState(false)
  const headingRef = useRef(null)
  const bar = traceBar(trace, { busy: traceBusy })
  const extras = traceExtrasSummary(form)
  const extrasShown = !bar.recording && (extrasOpen || Boolean(formError && extras))
  const field = (name) => ({ value: form[name], onChange: (event) => onFormChange({ ...form, [name]: event.target.value }), autoComplete: 'off' })
  const commaRuns = selected.filter((ref) => ref.includes(','))
  const compareReady = selected.length >= 2 && !commaRuns.length

  function closeConfirm() {
    setConfirming(false)
    headingRef.current?.focus()
  }

  return (
    <section className="panel stats-runs" aria-labelledby="stats-runs-title" aria-busy={busy || traceBusy}>
      <div className="stats-runs-head">
        <h2 id="stats-runs-title" ref={headingRef} tabIndex={-1}>Runs</h2>
        <TraceBar
          trace={trace}
          bar={bar}
          now={now}
          field={field}
          extras={extras}
          extrasShown={extrasShown}
          onToggleExtras={() => setExtrasOpen(!extrasShown)}
          onStart={onStart}
          onStop={onStop}
        />
      </div>
      {bar.recording ? (
        <>
          {trace.note && <p className="hint stats-trace-note">{trace.note}</p>}
          <KeyValueTable rows={trace.facts} caption="Running trace summary" />
        </>
      ) : (
        <div id="stats-trace-extras" className="periph-form stats-trace-extras" hidden={!extrasShown}>
          <label>
            Note (optional)
            <input form="stats-trace-form" {...field('note')} placeholder="before the NMS change" />
          </label>
          <label>
            Tags (optional, comma separated)
            <input form="stats-trace-form" {...field('tags')} placeholder="compiler-v2, yolo26" spellCheck={false} />
          </label>
        </div>
      )}
      {formError && (
        <>
          <p className="sr-only" role="alert">{formError}</p>
          <Callout tone="danger" title={formError} />
        </>
      )}
      <p className="section-note stats-runs-note">A trace records a workload and is saved on the board as a run you can reopen and compare.</p>
      <FailureCallout notice={traceError} />
      <FailureCallout notice={error} />

      {runs.length === 0 && !error && <p className="hint">{busy ? 'Reading runs from the board…' : 'No runs yet. Start a trace to record one.'}</p>}
      {selected.length > 0 && (
        <div className="stats-selection-bar" role="toolbar" aria-label="Selected runs">
          <span className="stats-selection-count">{selected.length} selected</span>
          <button
            type="button"
            className="btn-tonal"
            onClick={onCompare}
            disabled={!compareReady || compareBusy || deleteBusy}
            title={commaRuns.length ? `${commaRuns.join(', ')} cannot be compared: Sentinel compares runs by a comma-separated list.` : compareReady ? undefined : 'Select at least two runs to compare them'}
          >
            {compareBusy ? 'Comparing…' : 'Compare'}
          </button>
          {confirming ? (
            <span className="stats-delete-confirm" role="group" aria-labelledby="stats-delete-prompt" onKeyDown={(event) => event.key === 'Escape' && closeConfirm()}>
              <span id="stats-delete-prompt" className="stats-delete-prompt">
                Delete {countLabel(selected.length, 'run')}?<span className="sr-only"> This cannot be undone.</span>
              </span>
              <button
                type="button"
                className="btn-ghost danger"
                onClick={() => {
                  closeConfirm()
                  onDelete()
                }}
              >
                Delete
              </button>
              <button type="button" className="btn-ghost" autoFocus onClick={closeConfirm}>Cancel</button>
            </span>
          ) : (
            <>
              <button type="button" className="btn-ghost danger" onClick={() => setConfirming(true)} disabled={deleteBusy || compareBusy}>
                {deleteBusy ? 'Deleting…' : 'Delete'}
              </button>
              <button type="button" className="btn-ghost" onClick={onClear} disabled={deleteBusy}>Clear</button>
            </>
          )}
        </div>
      )}
      <FailureCallout notice={deleteError} />

      {runs.length > 0 && (
        <table className="sysinfo-table stats-table stats-run-table">
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Compare</span></th>
              <th scope="col">Run</th>
              <th scope="col">Recorded</th>
              <th scope="col"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.ref} className={run.ref === openRef ? 'active' : undefined}>
                <td>
                  <label className="stats-check">
                    <input
                      type="checkbox"
                      checked={selected.includes(run.ref)}
                      onChange={() => onToggle(run.ref)}
                      disabled={deleteBusy || (!selected.includes(run.ref) && selected.length >= MAX_COMPARE_RUNS)}
                    />
                    <span className="sr-only">Select {run.label}</span>
                  </label>
                </td>
                <th scope="row">
                  {run.label}
                  {run.note && <span className="hint">{run.note}</span>}
                  <TagPills tags={run.tags} />
                </th>
                <td>{runSubtitle(run, now) || '—'}</td>
                <td>
                  <button type="button" className="btn-ghost" aria-expanded={run.ref === openRef} onClick={() => onOpen(run.ref === openRef ? '' : run.ref)}>
                    {run.ref === openRef ? 'Hide' : 'Open'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {children}
    </section>
  )
}

function HostPanel({ model, error, updatedAt, busy, now }) {
  return (
    <section className="panel stats-host" aria-labelledby="stats-host-title" aria-busy={busy}>
      <div className="stats-host-head">
        <h2 id="stats-host-title">Insight host</h2>
        <span className="hint">
          {model.sourceLabel}, not the board.
          {updatedAt > 0 && ` Read ${formatRelativeTime(new Date(updatedAt).toISOString(), now)}.`}
        </span>
      </div>
      <FailureCallout notice={error} />
      {model.notice ? (
        <p className="hint stats-host-notice">{model.notice}</p>
      ) : (
        <ul className="stats-host-rows" aria-label="Insight host readings">
          {model.rows.map((row) => (
            <li key={row.key}>
              <span className="stats-host-label">{row.label}</span>
              <span className="stats-host-value">{formatValue(row.value, row.unit)}</span>
              {row.percent !== null && (
                <span className="stats-host-bar" aria-hidden="true">
                  <span style={{ width: `${row.percent}%` }} />
                </span>
              )}
              {row.detail && <span className="hint">{row.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function StatsView({ board = null, boardError = null, onOpenBoardPanel, onReloadBoard, onError, onStatus, hostExtra = null }) {
  const [state, setState] = useState(null)
  const [stateError, setStateError] = useState(null)
  const [stateBusy, setStateBusy] = useState(true)
  const [installBusy, setInstallBusy] = useState(false)
  const [installError, setInstallError] = useState(null)
  const [installResult, setInstallResult] = useState(null)
  const [metrics, setMetrics] = useState(null)
  const [metricsError, setMetricsError] = useState(null)
  const [metricsBusy, setMetricsBusy] = useState(false)
  const [live, setLive] = useState(true)
  const [halted, setHalted] = useState(false)
  const [traces, setTraces] = useState(null)
  const [traceError, setTraceError] = useState(null)
  const [traceBusy, setTraceBusy] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [runs, setRuns] = useState(null)
  const [runsError, setRunsError] = useState(null)
  const [runsBusy, setRunsBusy] = useState(false)
  const [openRef, setOpenRef] = useState('')
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [selected, setSelected] = useState([])
  const [compare, setCompare] = useState(null)
  const [compareError, setCompareError] = useState(null)
  const [compareBusy, setCompareBusy] = useState(false)
  const [compareOpen, setCompareOpen] = useState(true)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const [host, setHost] = useState(null)
  const [hostError, setHostError] = useState(null)
  const [hostBusy, setHostBusy] = useState(false)
  const [hostReadAt, setHostReadAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [statsTab, setStatsTab] = useStoredTab('neat-insight:stats-tab', STATS_TABS)

  const mounted = useRef(false)
  // One request per endpoint at a time, each bound to the board it was asked of.
  const guard = useRef(createRequestGuard())
  const hostGuard = useRef(createRequestGuard())
  const tick = useRef(() => {})
  const failuresRef = useRef(0)
  const latest = useRef({})
  latest.current = { openRef, compare, selected }

  const info = useMemo(() => daemonInfo(state), [state])
  const model = useMemo(() => metricsModel(metrics), [metrics])
  const trace = useMemo(() => traceModel(traces), [traces])
  const runRows = useMemo(() => runList(runs), [runs])
  const hostModel = useMemo(() => hostMetricsModel(host), [host])
  const polling = info.available && live && !halted
  const generation = board?.generation ?? null

  function fresh(ticket, data = null) {
    if (!mounted.current || !guard.current.current(ticket, data)) {
      if (data && generation !== null && data.generation !== generation) onReloadBoard?.()
      return false
    }
    return true
  }

  async function send(name, { busy, call, done, fail, supersede = false }) {
    const ticket = guard.current.begin(name, { supersede })
    if (!ticket) return
    busy(true)
    try {
      const data = await call()
      if (fresh(ticket, data)) await done(data, ticket)
    } catch (err) {
      if (fresh(ticket)) fail(failureNotice(err))
    } finally {
      guard.current.end(ticket)
      if (fresh(ticket)) busy(false)
    }
  }

  function reset() {
    for (const setBusy of [setStateBusy, setInstallBusy, setMetricsBusy, setTraceBusy, setRunsBusy, setDetailBusy, setCompareBusy, setDeleteBusy]) setBusy(false)
    for (const clear of [setState, setMetrics, setMetricsError, setTraces, setTraceError, setRuns, setRunsError, setDetail, setDetailError, setCompare, setCompareError, setDeleteError, setInstallResult, setInstallError]) clear(null)
    setOpenRef('')
    setSelected([])
    failuresRef.current = 0
    setHalted(false)
  }

  // A run deleted elsewhere leaves the selection with the list.
  function applyRuns(data) {
    const refs = new Set(runList(data).map((run) => run.ref))
    const kept = latest.current.selected.filter((ref) => refs.has(ref))
    if (kept.length !== latest.current.selected.length) {
      guard.current.cancel('compare')
      setCompareBusy(false)
      setCompare(null)
      setCompareError(null)
    }
    setRuns(data)
    setRunsError(null)
    setSelected(kept)
  }

  function loadState({ quiet = false } = {}) {
    return send('state', {
      busy: quiet ? () => {} : setStateBusy,
      call: fetchSentinel,
      done: (data) => {
        setState(data)
        setStateError(null)
        if (data.available) {
          setHalted(false)
          loadTraces({ quiet: true })
          loadRuns()
        }
      },
      fail: (notice) => {
        setState(null)
        setStateError(notice)
      }
    })
  }

  function loadTraces({ quiet = false } = {}) {
    return send('traces', {
      busy: quiet ? () => {} : setTraceBusy,
      call: fetchActiveTrace,
      done: (data) => {
        setTraces(data)
        setTraceError(null)
      },
      fail: setTraceError
    })
  }

  function loadRuns() {
    return send('runs', { busy: setRunsBusy, call: fetchRuns, done: applyRuns, fail: setRunsError })
  }

  async function loadHost() {
    const ticket = hostGuard.current.begin('host')
    if (!ticket) return
    setHostBusy(true)
    try {
      const data = await fetchHostMetrics()
      if (!mounted.current) return
      setHost(data)
      setHostError(null)
      setHostReadAt(Date.now())
    } catch (err) {
      if (mounted.current) setHostError(failureNotice(err))
    } finally {
      hostGuard.current.end(ticket)
      if (mounted.current) setHostBusy(false)
    }
  }

  function pollMetrics({ manual = false } = {}) {
    return send('metrics', {
      busy: manual ? setMetricsBusy : () => {},
      call: fetchMetrics,
      done: (data) => {
        setMetrics(data)
        setMetricsError(null)
        failuresRef.current = 0
        setHalted(false)
        loadTraces({ quiet: true })
      },
      fail: (notice) => {
        setMetricsError(notice)
        failuresRef.current += 1
        // A missing board or stopped daemon will not answer the next tick either.
        if (notice.board || notice.daemon) {
          setHalted(true)
          loadState({ quiet: true })
        }
      }
    })
  }

  function install() {
    setInstallError(null)
    setInstallResult(null)
    return send('install', {
      busy: setInstallBusy,
      call: () => installSentinel(state?.generation),
      done: async (data, ticket) => {
        setInstallResult(data)
        onStatus?.(`Sentinel installed on ${data.board?.label || 'the board'}.`)
        await loadState({ quiet: true })
        if (fresh(ticket)) pollMetrics({ manual: true })
      },
      fail: (notice) => {
        setInstallError({ ...notice, install: true })
        onError?.(notice.message)
        loadState({ quiet: true })
      }
    })
  }

  async function onStartTrace(event) {
    event.preventDefault()
    const result = validateTrace(form)
    setFormError(result.error || '')
    if (result.error) return
    setTraceError(null)
    await send('trace-action', {
      busy: setTraceBusy,
      call: () => startTrace(result.body, traces?.generation),
      done: (data) => {
        setTraces(data)
        setForm(EMPTY_FORM)
        onStatus?.(`Recording trace “${result.body.name}”.`)
        loadRuns()
      },
      fail: setTraceError
    })
  }

  async function onStopTrace() {
    setTraceError(null)
    await send('trace-action', {
      busy: setTraceBusy,
      call: () => stopTrace(traces?.generation, trace.id),
      done: async () => {
        onStatus?.('Trace stopped and saved as a run.')
        await loadTraces({ quiet: true })
        loadRuns()
      },
      fail: setTraceError
    })
  }

  async function openRun(ref) {
    setOpenRef(ref)
    setDetail(null)
    setDetailError(null)
    if (!ref) {
      guard.current.cancel('run')
      setDetailBusy(false)
      return
    }
    await send('run', { busy: setDetailBusy, call: () => fetchRun(ref), done: setDetail, fail: setDetailError, supersede: true })
  }

  function runCompare() {
    setCompareError(null)
    return send('compare', {
      busy: setCompareBusy,
      call: () => compareRuns(selected),
      done: (data) => {
        setCompare(data)
        setCompareOpen(true)
      },
      fail: (notice) => {
        setCompare(null)
        setCompareError(notice)
      }
    })
  }

  function changeSelection(update) {
    guard.current.cancel('compare')
    setCompareBusy(false)
    setCompare(null)
    setCompareError(null)
    setSelected(update)
  }

  // One run at a time, bound to the generation the list was read under; the first failure stops the rest.
  async function deleteSelected() {
    const ticket = guard.current.begin('delete')
    if (!ticket) return
    setDeleteBusy(true)
    setDeleteError(null)
    const gone = new Set()
    let listing = null
    let deleted = 0
    try {
      for (const ref of selected) {
        try {
          listing = await deleteRun(ref, runs?.generation)
        } catch (err) {
          const notice = failureNotice(err)
          if (fresh(ticket)) setDeleteError({ ...notice, message: `Run ${ref} was not deleted: ${notice.message}` })
          break
        }
        if (!fresh(ticket)) return
        deleted += 1
        for (const value of [ref, listing.deleted?.id, listing.deleted?.name]) if (value) gone.add(String(value))
      }
    } finally {
      guard.current.end(ticket)
      if (fresh(ticket)) setDeleteBusy(false)
    }
    if (!fresh(ticket) || !listing) return
    if (gone.has(latest.current.openRef)) openRun('')
    if ((latest.current.compare?.sentinel?.runs || []).some((run) => gone.has(String((run?.metadata || run)?.id)))) setCompare(null)
    // A read already out answers from before the delete.
    guard.current.cancel('runs')
    applyRuns(listing)
    onStatus?.(`Deleted ${countLabel(deleted, 'run')} from the board.`)
    loadRuns()
  }

  useEffect(() => {
    if (!guard.current.switchTo(generation)) return
    reset()
    loadState()
  }, [generation])

  useEffect(() => {
    mounted.current = true
    onReloadBoard?.()
    loadState()
    return () => {
      mounted.current = false
    }
  }, [])

  tick.current = () => pollMetrics()

  useEffect(() => {
    if (!polling) return undefined
    return pollWhileVisible(() => tick.current(), () => pollDelay(failuresRef.current))
  }, [polling])

  useEffect(() => {
    if (statsTab !== 'host') return undefined
    return pollWhileVisible(() => loadHost(), HOST_POLL_MS)
  }, [statsTab])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(timer)
  }, [])

  const sentinelAvailable = Boolean(state?.available)
  useEffect(() => {
    if (!sentinelAvailable) return undefined
    return pollWhileVisible(loadRuns, RUNS_POLL_MS)
  }, [sentinelAvailable, generation])

  const boardProblem = boardError || (stateError?.board ? stateError : null)
  const daemonError = installError || (stateError && !stateError.board ? stateError : null)
  const daemonShown =
    info.state === 'unknown'
      ? Boolean(daemonError)
      : info.state !== 'ready' || Boolean(daemonError) || healthProblems(state?.health).length > 0 || Boolean(installResult?.log)

  return (
    <div className="periph-view stats-view">
      <SegmentedTabs label="Stats source" items={STATS_TABS} selected={statsTab} onSelect={setStatsTab} idPrefix="stats-tab" panelPrefix="stats-tabpanel" className="stats-subtabs" />

      <div id="stats-tabpanel-devkit" role="tabpanel" aria-labelledby="stats-tab-devkit" className="stats-tabpanel" hidden={statsTab !== 'devkit'}>
        {boardProblem && boardProblem.code !== 'no_target' && (
          <Callout tone="danger" title={boardProblem.message || 'The board could not be reached'}>
            {boardProblem.hint && <p>{boardProblem.hint}</p>}
            <button type="button" className="btn-ghost" onClick={onOpenBoardPanel}>Open board settings</button>
          </Callout>
        )}

        {stateBusy && !state && <p className="hint" role="status">Checking Sentinel on the board…</p>}

        {stateError?.code === 'no_target' ? (
          <Callout tone="info" title="Select a board to see its telemetry">
            <p>{stateError.message} {stateError.hint}</p>
            <button type="button" className="btn-ghost" onClick={onOpenBoardPanel}>Choose a board</button>
          </Callout>
        ) : (
          <>
            {daemonShown && (
              <DaemonPanel
                info={info}
                health={state?.health || null}
                busy={installBusy || stateBusy}
                installing={installBusy}
                install={installResult}
                error={daemonError}
                blocked={Boolean(boardProblem)}
                onInstall={install}
                onRetry={() => loadState()}
              />
            )}

            {/* Values already read stay on the page when Sentinel stops answering; a board switch clears them. */}
            {(info.available || metrics || traces || runs) && (
              <SentinelDashboard
                model={model}
                startedAt={state?.daemon?.started_at || null}
                now={now}
                live={live}
                polling={polling}
                error={metricsError}
                busy={metricsBusy}
                onToggleLive={() => setLive((value) => !value)}
                onRetry={() => {
                  setHalted(false)
                  failuresRef.current = 0
                  pollMetrics({ manual: true })
                }}
                runs={(
                  <RunsPanel
                    trace={trace}
                    traceBusy={traceBusy}
                    traceError={traceError}
                    form={form}
                    formError={formError}
                    onFormChange={setForm}
                    onStart={onStartTrace}
                    onStop={onStopTrace}
                    now={now}
                    runs={runRows}
                    selected={selected}
                    busy={runsBusy}
                    error={runsError}
                    openRef={openRef}
                    deleteBusy={deleteBusy}
                    deleteError={deleteError}
                    compareBusy={compareBusy}
                    onToggle={(ref) => changeSelection((current) => (current.includes(ref) ? current.filter((item) => item !== ref) : [...current, ref]))}
                    onOpen={openRun}
                    onCompare={runCompare}
                    onDelete={deleteSelected}
                    onClear={() => changeSelection([])}
                  >
                    {openRef && <RunDetail openRef={openRef} detail={detail} error={detailError} busy={detailBusy} />}
                    <FailureCallout notice={compareError} />
                    {compare && <Comparison compare={compare} definitions={model.byKey} open={compareOpen} onToggle={() => setCompareOpen((open) => !open)} />}
                  </RunsPanel>
                )}
              />
            )}
          </>
        )}
      </div>

      <div id="stats-tabpanel-host" role="tabpanel" aria-labelledby="stats-tab-host" className="stats-tabpanel" hidden={statsTab !== 'host'}>
        <HostPanel model={hostModel} error={hostError} updatedAt={hostReadAt} busy={hostBusy} now={now} />
        {hostExtra}
      </div>
    </div>
  )
}
