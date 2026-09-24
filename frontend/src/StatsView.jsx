import { useEffect, useMemo, useRef, useState } from 'react'
import BoardTargetCard from './peripherals/BoardTargetCard.jsx'
import { Callout, Pill } from './peripherals/ui.jsx'
import {
  compareRuns,
  fetchActiveTrace,
  fetchBoard,
  fetchMetrics,
  fetchRun,
  fetchRuns,
  fetchSentinel,
  installSentinel,
  startTrace,
  stopTrace
} from './stats/api.js'
import {
  MAX_COMPARE_RUNS,
  compareHint,
  compareReady,
  compareTable,
  countsSummary,
  daemonFacts,
  daemonInfo,
  factRows,
  failureNotice,
  formatDelta,
  formatRelativeTime,
  formatTimestamp,
  formatValue,
  healthFacts,
  healthProblems,
  isStale,
  metricsModel,
  pollDelay,
  runList,
  runSubtitle,
  statusInfo,
  toggleSelection,
  traceModel,
  validateTrace
} from './stats/model.js'
import { Facts, FailureCallout, KeyValueTable, MetricCard, Sparkline } from './stats/ui.jsx'

const BOARD_DESCRIPTION = 'Sentinel telemetry is read from this board over its own API socket.'

function DaemonPanel({ info, health, busy, log, error, onInstall, onRetry }) {
  return (
    <section className="panel stats-daemon" aria-labelledby="stats-daemon-title" aria-busy={busy}>
      <div className="panel-topbar">
        <div>
          <h2 id="stats-daemon-title">Sentinel daemon</h2>
          <p className="section-note">
            Sentinel samples power, temperature, CPU, memory and storage on the board and records them into runs.
          </p>
        </div>
        <div className="periph-actions">
          <button type="button" className="btn-ghost" onClick={onRetry} disabled={busy}>Re-check</button>
          {info.state !== 'ready' && (
            <button
              type="button"
              className="btn-tonal"
              onClick={onInstall}
              disabled={busy || !info.canInstall}
              title={info.canInstall ? undefined : info.installBlocked || undefined}
            >
              {busy ? 'Installing…' : 'Install Sentinel'}
            </button>
          )}
        </div>
      </div>

      <div className="periph-board-summary">
        <Pill tone={info.tone}>{info.label}</Pill>
        {info.version && <span className="stats-version">{info.version}</span>}
        {info.state === 'unknown' && <span className="hint">Sentinel has not been checked on this board yet.</span>}
      </div>
      {info.state !== 'unknown' && <Facts rows={[...daemonFacts(info), ...healthFacts(health)]} />}

      {busy && (
        <p className="hint" role="status">
          Running <code>sima-cli neat install sentinel</code> on the board. This downloads and unpacks an artifact and can take
          several minutes.
        </p>
      )}
      <FailureCallout notice={error} detailLabel="Installer output" />
      {!error && info.error && (
        <Callout tone={info.state === 'error' ? 'danger' : 'warn'} title={info.error.message}>
          {info.error.hint && <p>{info.error.hint}</p>}
          {!info.canInstall && info.installBlocked && info.state !== 'ready' && <p className="hint">{info.installBlocked}</p>}
        </Callout>
      )}
      {healthProblems(health).length > 0 && (
        <Callout tone="warn" title="Sentinel reported collector errors">
          <ul className="periph-notes">
            {healthProblems(health).map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        </Callout>
      )}
      {log && (
        <details className="stats-detail">
          <summary>Installer output</summary>
          <pre className="periph-code" tabIndex={0}><code>{log}</code></pre>
        </details>
      )}
    </section>
  )
}

function MetricsPanel({ model, live, polling, paused, stale, error, busy, now, onToggleLive, onRefresh, onRetry }) {
  const sampled = model.sampledAt ? formatRelativeTime(model.sampledAt, now) : ''
  return (
    <section className="panel stats-metrics" aria-labelledby="stats-metrics-title" aria-busy={busy}>
      <div className="panel-topbar">
        <div>
          <h2 id="stats-metrics-title">Live metrics</h2>
          <p className="section-note">
            Every value comes from Sentinel's latest sample; one it cannot measure shows as “—”, never as zero.
          </p>
        </div>
        <div className="periph-actions">
          <button type="button" className="btn-ghost" onClick={onRefresh} disabled={busy}>Refresh now</button>
          <button type="button" className="btn-tonal" onClick={onToggleLive}>
            {live ? 'Pause updates' : 'Resume updates'}
          </button>
        </div>
      </div>

      <div className="periph-board-summary">
        <Pill tone={polling ? 'ok' : ''}>{polling ? 'Live' : paused ? 'Paused' : 'Not updating'}</Pill>
        {sampled && (
          <span className="hint">
            sampled <time dateTime={model.sampledAt} title={formatTimestamp(model.sampledAt)}>{sampled}</time>
          </span>
        )}
        {model.groups.length > 0 && <span className="hint">{countsSummary(model.counts)}</span>}
      </div>
      <p className="sr-only" role="status">
        {polling ? 'Metrics are updating live.' : paused ? 'Metric updates are paused.' : 'Metric updates are stopped.'}
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

      {model.highlights.length > 0 && (
        <div className="stats-metric-grid">
          {model.highlights.map((metric) => (
            <MetricCard key={metric.key} metric={metric} values={model.series[metric.key]} />
          ))}
        </div>
      )}

      {model.groups.map((group) => (
        <details key={group.name} className="stats-group" open={group.metrics.some((metric) => metric.status === 'critical')}>
          <summary>{group.name} <span className="hint">({group.metrics.length})</span></summary>
          <table className="sysinfo-table stats-table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Value</th>
                <th scope="col">Status</th>
                <th scope="col">Recent</th>
              </tr>
            </thead>
            <tbody>
              {group.metrics.map((metric) => {
                const status = statusInfo(metric.status)
                return (
                  <tr key={metric.key}>
                    <th scope="row">
                      {metric.label}
                      {metric.description && <span className="hint">{metric.description}</span>}
                    </th>
                    <td className="stats-cell-value">{formatValue(metric.value, metric.unit)}</td>
                    <td><Pill tone={status.tone}>{status.label}</Pill></td>
                    <td className={`stats-cell-spark tone-${metric.status}`}>
                      <Sparkline metric={metric} values={model.series[metric.key]} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </details>
      ))}

      {!model.groups.length && !error && (
        <p className="hint">{busy ? 'Reading the first sample…' : 'Sentinel has not reported any metric yet.'}</p>
      )}
    </section>
  )
}

function TracePanel({ trace, busy, form, formError, error, onFormChange, onStart, onStop, now }) {
  const running = trace.active
  return (
    <section className="panel stats-trace" aria-labelledby="stats-trace-title" aria-busy={busy}>
      <div className="panel-topbar">
        <div>
          <h2 id="stats-trace-title">Trace capture</h2>
          <p className="section-note">
            A trace records every sample around a workload and is saved on the board as a run you can reopen and compare.
          </p>
        </div>
        {running && (
          <button type="button" className="btn-tonal" onClick={onStop} disabled={busy}>
            {busy ? 'Stopping…' : 'Stop trace'}
          </button>
        )}
      </div>

      <FailureCallout notice={error} />

      {running ? (
        <>
          <div className="periph-board-summary">
            <Pill tone="ok">Recording</Pill>
            <span className="periph-board-label">{trace.name}</span>
            {trace.startedAt && (
              <span className="hint">
                started <time dateTime={trace.startedAt} title={formatTimestamp(trace.startedAt)}>{formatRelativeTime(trace.startedAt, now)}</time>
              </span>
            )}
          </div>
          <KeyValueTable rows={trace.facts} caption="Running trace summary" />
        </>
      ) : (
        <form className="periph-form" onSubmit={onStart} aria-label="Start a trace">
          <div className="periph-form-fields stats-trace-fields">
            <label>
              Trace name
              <input
                value={form.name}
                onChange={(event) => onFormChange({ ...form, name: event.target.value })}
                placeholder="baseline"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </label>
            <label>
              Note (optional)
              <input
                value={form.note}
                onChange={(event) => onFormChange({ ...form, note: event.target.value })}
                placeholder="before the NMS change"
                autoComplete="off"
              />
            </label>
            <label>
              Tags (optional, comma separated)
              <input
                value={form.tags}
                onChange={(event) => onFormChange({ ...form, tags: event.target.value })}
                placeholder="compiler-v2, yolo26"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
          <p className="hint">Sentinel records one trace at a time and refuses a name a saved run already uses.</p>
          {formError && (
            <>
              <p className="sr-only" role="alert">{formError}</p>
              <Callout tone="danger" title={formError} />
            </>
          )}
          <div className="periph-actions">
            <button type="submit" className="btn-tonal" disabled={busy}>{busy ? 'Starting…' : 'Start trace'}</button>
          </div>
        </form>
      )}
    </section>
  )
}

function RunsPanel({
  runs,
  busy,
  error,
  selected,
  openRef,
  detail,
  detailError,
  detailBusy,
  compare,
  compareError,
  compareBusy,
  now,
  onRefresh,
  onToggle,
  onOpen,
  onCompare,
  onClearCompare
}) {
  const table = useMemo(() => (compare ? compareTable(compare) : null), [compare])
  const fallbackRows = useMemo(() => (compare && !table ? factRows(compare.sentinel, []) : []), [compare, table])
  // A run carries its raw samples; they belong in a chart, not in a fact list.
  const detailRows = useMemo(() => factRows(detail?.sentinel?.run ?? detail?.sentinel, ['samples']), [detail])

  return (
    <section className="panel stats-runs" aria-labelledby="stats-runs-title" aria-busy={busy}>
      <div className="panel-topbar">
        <div>
          <h2 id="stats-runs-title">Saved runs</h2>
          <p className="section-note">Runs live on the board and survive a daemon restart. The first run selected is the comparison baseline.</p>
        </div>
        <button type="button" className="btn-ghost" onClick={onRefresh} disabled={busy}>Refresh</button>
      </div>

      <FailureCallout notice={error} />

      {runs.length === 0 && !error && (
        <p className="hint">{busy ? 'Reading runs from the board…' : 'No runs yet. Start a trace above to record one.'}</p>
      )}

      {runs.length > 0 && (
        <>
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
                <tr key={run.key} className={run.ref === openRef ? 'active' : undefined}>
                  <td>
                    <label className="stats-check">
                      <input
                        type="checkbox"
                        checked={selected.includes(run.ref)}
                        onChange={() => onToggle(run.ref)}
                        disabled={!selected.includes(run.ref) && selected.length >= MAX_COMPARE_RUNS}
                      />
                      <span className="sr-only">Compare {run.label}</span>
                    </label>
                  </td>
                  <th scope="row">
                    {run.label}
                    {run.note && <span className="hint">{run.note}</span>}
                    {run.tags.length > 0 && (
                      <span className="periph-pills">
                        {run.tags.map((tag) => <Pill key={tag} tone="periph-info">{tag}</Pill>)}
                      </span>
                    )}
                  </th>
                  <td>{runSubtitle(run, now) || '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="btn-ghost"
                      aria-expanded={run.ref === openRef}
                      onClick={() => onOpen(run.ref === openRef ? '' : run.ref)}
                    >
                      {run.ref === openRef ? 'Hide' : 'Open'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="periph-actions stats-compare-bar">
            <button type="button" className="btn-tonal" onClick={onCompare} disabled={!compareReady(selected) || compareBusy}>
              {compareBusy ? 'Comparing…' : 'Compare selected'}
            </button>
            {selected.length > 0 && (
              <button type="button" className="btn-ghost" onClick={onClearCompare}>Clear selection</button>
            )}
            <span className="hint">{compareHint(selected)}</span>
          </div>
        </>
      )}

      {openRef && (
        <section className="stats-run-detail" aria-label={`Run ${openRef}`} aria-busy={detailBusy}>
          <h3>{openRef}</h3>
          <FailureCallout notice={detailError} />
          {detailBusy && <p className="hint" role="status">Reading the run from the board…</p>}
          {detail && !detailError && (
            detailRows.length > 0 ? (
              <KeyValueTable rows={detailRows} caption={`Run ${openRef}`} />
            ) : (
              <p className="hint">Sentinel returned no detail for this run.</p>
            )
          )}
        </section>
      )}

      <FailureCallout notice={compareError} />
      {compare && !compareError && (
        <section className="stats-compare" aria-label="Run comparison">
          <h3>Comparison</h3>
          {table ? (
            <table className="sysinfo-table stats-table">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  {table.columns.map((column) => (
                    <th key={column.key} scope="col">
                      {column.label}
                      {column.baseline && <span className="hint">baseline</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    {row.cells.map((cell, index) => (
                      <td key={`${row.key}-${index}`} className="stats-cell-value">
                        {formatValue(cell.value, row.unit)}
                        {cell.delta !== null && <span className="hint">{formatDelta(cell.delta, row.unit)}</span>}
                        {cell.delta === null && cell.deltaPct !== null && (
                          <span className="hint">{formatDelta(cell.deltaPct, '%')}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <>
              <p className="hint">
                This Sentinel build returned a comparison Insight cannot lay out as a table. Its values are listed as they came
                from the board.
              </p>
              <KeyValueTable rows={fallbackRows} caption="Comparison values" />
            </>
          )}
        </section>
      )}
    </section>
  )
}

export default function StatsView({ onError, onStatus }) {
  const [board, setBoard] = useState(null)
  const [boardError, setBoardError] = useState(null)
  const [state, setState] = useState(null)
  const [stateError, setStateError] = useState(null)
  const [stateBusy, setStateBusy] = useState(true)
  const [installBusy, setInstallBusy] = useState(false)
  const [installError, setInstallError] = useState(null)
  const [installLog, setInstallLog] = useState('')
  const [metrics, setMetrics] = useState(null)
  const [metricsError, setMetricsError] = useState(null)
  const [metricsBusy, setMetricsBusy] = useState(false)
  const [failures, setFailures] = useState(0)
  const [live, setLive] = useState(true)
  const [halted, setHalted] = useState(false)
  const [traces, setTraces] = useState(null)
  const [traceError, setTraceError] = useState(null)
  const [traceBusy, setTraceBusy] = useState(false)
  const [form, setForm] = useState({ name: '', note: '', tags: '' })
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
  const [now, setNow] = useState(() => Date.now())

  const mounted = useRef(false)
  const inFlight = useRef(false)
  const tick = useRef(() => {})
  const detailSeq = useRef(0)

  const info = useMemo(() => daemonInfo(state), [state])
  const model = useMemo(() => metricsModel(metrics), [metrics])
  const trace = useMemo(() => traceModel(traces), [traces])
  const runRows = useMemo(() => runList(runs), [runs])
  const stale = isStale(board, metrics) || isStale(board, state)
  const polling = info.available && live && !halted && !stale
  const delay = pollDelay(failures)

  function reset() {
    setMetrics(null)
    setMetricsError(null)
    setTraces(null)
    setTraceError(null)
    setRuns(null)
    setRunsError(null)
    setOpenRef('')
    setDetail(null)
    setDetailError(null)
    setSelected([])
    setCompare(null)
    setCompareError(null)
    setInstallLog('')
    setInstallError(null)
    setFailures(0)
    setHalted(false)
  }

  async function loadBoard() {
    try {
      const data = await fetchBoard()
      if (!mounted.current) return null
      setBoard(data)
      setBoardError(null)
      return data
    } catch (err) {
      if (mounted.current) setBoardError(failureNotice(err))
      return null
    }
  }

  async function loadState({ quiet = false } = {}) {
    if (!quiet) setStateBusy(true)
    try {
      const data = await fetchSentinel()
      if (!mounted.current) return null
      setState(data)
      setStateError(null)
      if (data.available) {
        setHalted(false)
        loadTraces({ quiet: true })
        loadRuns()
      }
      return data
    } catch (err) {
      if (mounted.current) {
        setState(null)
        setStateError(failureNotice(err))
      }
      return null
    } finally {
      if (mounted.current && !quiet) setStateBusy(false)
    }
  }

  async function loadTraces({ quiet = false } = {}) {
    if (!quiet) setTraceBusy(true)
    try {
      const data = await fetchActiveTrace()
      if (!mounted.current) return
      setTraces(data)
      setTraceError(null)
    } catch (err) {
      if (mounted.current) setTraceError(failureNotice(err))
    } finally {
      if (mounted.current && !quiet) setTraceBusy(false)
    }
  }

  async function loadRuns() {
    setRunsBusy(true)
    try {
      const data = await fetchRuns()
      if (!mounted.current) return
      setRuns(data)
      setRunsError(null)
    } catch (err) {
      if (mounted.current) setRunsError(failureNotice(err))
    } finally {
      if (mounted.current) setRunsBusy(false)
    }
  }

  async function pollMetrics({ manual = false } = {}) {
    if (inFlight.current) return
    inFlight.current = true
    if (manual) setMetricsBusy(true)
    try {
      const data = await fetchMetrics()
      if (!mounted.current) return
      setMetrics(data)
      setMetricsError(null)
      setFailures(0)
      setHalted(false)
      if (trace.active) loadTraces({ quiet: true })
    } catch (err) {
      if (!mounted.current) return
      const notice = failureNotice(err)
      setMetricsError(notice)
      setFailures((count) => count + 1)
      // A missing board or a stopped daemon will not answer the next tick either:
      // stop polling it and re-read the daemon state so the page says why.
      if (notice.board || notice.daemon) {
        setHalted(true)
        loadState({ quiet: true })
      }
    } finally {
      inFlight.current = false
      if (mounted.current && manual) setMetricsBusy(false)
    }
  }

  async function install() {
    setInstallBusy(true)
    setInstallError(null)
    setInstallLog('')
    try {
      const data = await installSentinel()
      if (!mounted.current) return
      setInstallLog(data.log || '')
      onStatus?.(`Sentinel installed on ${data.board?.label || 'the board'}.`)
      await loadState({ quiet: true })
      if (mounted.current) pollMetrics({ manual: true })
    } catch (err) {
      if (!mounted.current) return
      const notice = failureNotice(err)
      setInstallError(notice)
      onError?.(notice.message)
      loadState({ quiet: true })
    } finally {
      if (mounted.current) setInstallBusy(false)
    }
  }

  async function onStartTrace(event) {
    event.preventDefault()
    const result = validateTrace(form)
    if (result.error) {
      setFormError(result.error)
      return
    }
    setFormError('')
    setTraceBusy(true)
    setTraceError(null)
    try {
      const data = await startTrace(result.body)
      if (!mounted.current) return
      setTraces(data)
      setForm({ name: '', note: '', tags: '' })
      onStatus?.(`Recording trace “${result.body.name}”.`)
      loadRuns()
    } catch (err) {
      if (mounted.current) setTraceError(failureNotice(err))
    } finally {
      if (mounted.current) setTraceBusy(false)
    }
  }

  async function onStopTrace() {
    setTraceBusy(true)
    setTraceError(null)
    try {
      await stopTrace()
      if (!mounted.current) return
      onStatus?.('Trace stopped and saved as a run.')
      await loadTraces({ quiet: true })
      loadRuns()
    } catch (err) {
      if (mounted.current) setTraceError(failureNotice(err))
    } finally {
      if (mounted.current) setTraceBusy(false)
    }
  }

  async function openRun(ref) {
    setOpenRef(ref)
    setDetail(null)
    setDetailError(null)
    if (!ref) return
    const seq = ++detailSeq.current
    setDetailBusy(true)
    try {
      const data = await fetchRun(ref)
      if (!mounted.current || seq !== detailSeq.current) return
      setDetail(data)
    } catch (err) {
      if (mounted.current && seq === detailSeq.current) setDetailError(failureNotice(err))
    } finally {
      if (mounted.current && seq === detailSeq.current) setDetailBusy(false)
    }
  }

  async function runCompare() {
    setCompareBusy(true)
    setCompareError(null)
    try {
      const data = await compareRuns(selected)
      if (mounted.current) setCompare(data)
    } catch (err) {
      if (mounted.current) {
        setCompare(null)
        setCompareError(failureNotice(err))
      }
    } finally {
      if (mounted.current) setCompareBusy(false)
    }
  }

  function handleBoardChange(data) {
    setBoard(data)
    // Another board means another daemon, other runs and another history: keep nothing.
    setState(null)
    reset()
    loadState({ quiet: true })
  }

  useEffect(() => {
    mounted.current = true
    loadBoard()
    loadState()
    return () => {
      mounted.current = false
    }
  }, [])

  // The tick is read through a ref so a state change never restarts the interval.
  tick.current = () => pollMetrics()

  useEffect(() => {
    if (!polling) return undefined
    let timer = null
    const run = () => tick.current()
    const start = () => {
      if (timer !== null) return
      run()
      timer = setInterval(run, delay)
    }
    const stop = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }
    // A hidden tab must not keep running commands on the board.
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start())
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [polling, delay])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000)
    return () => clearInterval(timer)
  }, [])

  const boardProblem = boardError || (stateError?.board ? stateError : null)
  const sentinelProblem = stateError && !stateError.board ? stateError : null

  return (
    <div className="periph-view stats-view">
      <BoardTargetCard
        board={board}
        loading={stateBusy && !board}
        error={boardError}
        connectionError={boardProblem && boardProblem.code !== 'no_target' ? boardProblem : null}
        description={BOARD_DESCRIPTION}
        onBoardChange={handleBoardChange}
        onRetry={() => {
          loadBoard()
          loadState()
        }}
        onReload={loadBoard}
        onStatus={onStatus}
        onError={onError}
      />

      {stateBusy && !state && <p className="hint" role="status">Checking Sentinel on the board…</p>}

      {stateError?.code === 'no_target' ? (
        <Callout tone="info" title="Select a board to see its telemetry">
          <p>{stateError.message} {stateError.hint}</p>
        </Callout>
      ) : (
        <>
          <DaemonPanel
            info={info}
            health={state?.health || null}
            busy={installBusy || (stateBusy && Boolean(state))}
            log={installLog}
            error={installError || sentinelProblem}
            onInstall={install}
            onRetry={() => loadState()}
          />

          {info.available && (
            <>
              <MetricsPanel
                model={model}
                live={live}
                polling={polling}
                paused={!live}
                stale={stale}
                error={metricsError}
                busy={metricsBusy}
                now={now}
                onToggleLive={() => setLive((value) => !value)}
                onRefresh={() => {
                  loadBoard()
                  pollMetrics({ manual: true })
                }}
                onRetry={() => {
                  setHalted(false)
                  setFailures(0)
                  pollMetrics({ manual: true })
                }}
              />

              <TracePanel
                trace={trace}
                busy={traceBusy}
                form={form}
                formError={formError}
                error={traceError}
                now={now}
                onFormChange={setForm}
                onStart={onStartTrace}
                onStop={onStopTrace}
              />

              <RunsPanel
                runs={runRows}
                busy={runsBusy}
                error={runsError}
                selected={selected}
                openRef={openRef}
                detail={detail}
                detailError={detailError}
                detailBusy={detailBusy}
                compare={compare}
                compareError={compareError}
                compareBusy={compareBusy}
                now={now}
                onRefresh={() => loadRuns()}
                onToggle={(ref) => setSelected((current) => toggleSelection(current, ref))}
                onOpen={openRun}
                onCompare={runCompare}
                onClearCompare={() => {
                  setSelected([])
                  setCompare(null)
                  setCompareError(null)
                }}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}
