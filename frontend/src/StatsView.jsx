import { useEffect, useMemo, useRef, useState } from 'react'
import BoardTargetCard from './peripherals/BoardTargetCard.jsx'
import { Callout, Pill } from './peripherals/ui.jsx'
import {
  compareRuns,
  fetchActiveTrace,
  fetchBoard,
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
  HOST_POLL_MS,
  MAX_COMPARE_RUNS,
  compareHint,
  compareLegend,
  compareReady,
  compareTable,
  countsSummary,
  createRequestGuard,
  daemonBusy,
  daemonFacts,
  daemonInfo,
  daemonNoticeNeeded,
  definitionsByKey,
  deltaAbsenceText,
  factRows,
  failureNotice,
  formatPercentDelta,
  formatRelativeTime,
  formatTimestamp,
  formatValue,
  healthFacts,
  healthProblems,
  hostMetricsModel,
  hostNotice,
  metricsModel,
  missingSelection,
  payloadBoardLabel,
  pollDelay,
  runDetail,
  runList,
  runSubtitle,
  staleFlags,
  staleNote,
  statusInfo,
  telemetryVisible,
  toggleSelection,
  traceModel,
  uncomparableRefs,
  validateTrace
} from './stats/model.js'
import { Facts, FailureCallout, KeyValueTable, MetricCard, Sparkline } from './stats/ui.jsx'

const BOARD_DESCRIPTION = 'Sentinel telemetry is read from this board over its own API socket.'

/**
 * Values that were read from a board that is no longer the selected one. They are kept
 * and labelled rather than hidden: a request in flight during a board switch resolves
 * afterwards, and nobody should read the previous board's numbers as the current ones.
 */
export function StaleBanner({ what, payload, onRefresh, refreshLabel = 'Refresh' }) {
  return (
    <Callout tone="warn" title="From the previous board" role="status">
      <p>{staleNote(what, payloadBoardLabel(payload))}</p>
      {onRefresh && <button type="button" className="btn-tonal" onClick={onRefresh}>{refreshLabel}</button>}
    </Callout>
  )
}

function DaemonPanel({ info, health, busy, installing, install, installStale, error, blocked, onInstall, onRetry }) {
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
              {installing ? 'Installing…' : 'Install Sentinel'}
            </button>
          )}
        </div>
      </div>

      <div className="periph-board-summary">
        <Pill tone={info.tone}>{info.label}</Pill>
        {info.version && <span className="stats-version">{info.version}</span>}
        {info.state === 'unknown' && (
          <span className="hint">
            {blocked
              ? 'Sentinel cannot be checked until the board answers; the Board panel above says why.'
              : 'Sentinel has not been checked on this board yet.'}
          </span>
        )}
      </div>
      {info.state !== 'unknown' && <Facts rows={[...daemonFacts(info), ...healthFacts(health)]} />}

      {installing && (
        <p className="hint" role="status">
          Running <code>sima-cli neat install sentinel</code> on the board. This downloads and unpacks an artifact and can take
          several minutes.
        </p>
      )}
      {/* Only an install attaches installer output; a failed read attaches the board's own. */}
      <FailureCallout
        notice={error}
        detailLabel={error?.action === 'install' ? 'Installer output' : 'Output from the board'}
      />
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
      {install?.log && (
        <>
          {installStale && <StaleBanner what="This installer output" payload={install} />}
          <details className="stats-detail">
            <summary>Installer output</summary>
            <pre className="periph-code" tabIndex={0}><code>{install.log}</code></pre>
          </details>
        </>
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

function TracePanel({ trace, stale, busy, form, formError, error, onFormChange, onStart, onStop, onRefreshTrace, now }) {
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
      {stale && <StaleBanner what="This trace" payload={trace.payload} onRefresh={onRefreshTrace} />}

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

export function RunsPanel({
  runs,
  runsPayload,
  definitions,
  stale,
  busy,
  error,
  selected,
  openRef,
  detail,
  detailError,
  detailBusy,
  detailStale,
  compare,
  compareError,
  compareBusy,
  compareStale,
  now,
  onRefresh,
  onToggle,
  onOpen,
  onCompare,
  onClearCompare,
  onDropMissing
}) {
  const table = useMemo(() => (compare ? compareTable(compare, definitions) : null), [compare, definitions])
  // Why the em dashes in the table are there, counted from the comparison itself.
  const legend = useMemo(() => compareLegend(table), [table])
  // Runs that were selected and are no longer on the board: their checkbox is gone.
  const missing = useMemo(() => missingSelection(selected, runs), [selected, runs])
  // Runs whose own name breaks the comma-separated compare query.
  const uncomparable = useMemo(() => uncomparableRefs(selected), [selected])
  const fallbackRows = useMemo(() => (compare && !table ? factRows(compare.sentinel, []) : []), [compare, table])
  const run = useMemo(() => runDetail(detail), [detail])
  // Only reached when the body is not the metadata/metrics/samples one the daemon sends.
  const detailRows = useMemo(() => (detail && !run ? factRows(detail.sentinel, ['samples']) : []), [detail, run])

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
      {stale && <StaleBanner what="These runs" payload={runsPayload} onRefresh={onRefresh} />}

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
                        aria-describedby="stats-compare-hint"
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
            <span className="hint" id="stats-compare-hint">{compareHint(selected)}</span>
          </div>

          {uncomparable.length > 0 && (
            <Callout tone="warn" title="Some selected runs cannot be compared by name">
              <p>
                Sentinel compares runs from one comma-separated list of names, so a name that contains a comma is read
                as two runs the board does not have. {uncomparable.join(' · ')}{' '}
                {uncomparable.length === 1 ? 'carries one' : 'carry one'}, so comparing would fail on a run nobody
                selected. Clear {uncomparable.length === 1 ? 'it' : 'them'}, or read{' '}
                {uncomparable.length === 1 ? 'that run' : 'those runs'} one at a time with Open.
              </p>
              <button type="button" className="btn-tonal" onClick={() => onDropMissing(uncomparable)}>
                {uncomparable.length === 1 ? 'Drop that run' : 'Drop those runs'} from the selection
              </button>
            </Callout>
          )}

          {missing.length > 0 && (
            <Callout tone="warn" title="Some selected runs are no longer on the board">
              <p>
                {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} not in the list Sentinel reports now, so there is
                no longer a checkbox to clear {missing.length === 1 ? 'it' : 'them'} with, and comparing will fail on{' '}
                {missing.length === 1 ? 'it' : 'them'}.
              </p>
              <button type="button" className="btn-tonal" onClick={() => onDropMissing(missing)}>
                {missing.length === 1 ? 'Drop that run' : 'Drop those runs'} from the selection
              </button>
            </Callout>
          )}
        </>
      )}

      {openRef && (
        <section className="stats-run-detail" aria-label={`Run ${openRef}`} aria-busy={detailBusy}>
          <h3>{openRef}</h3>
          <FailureCallout notice={detailError} />
          {detailStale && <StaleBanner what="This run" payload={detail} onRefresh={() => onOpen(openRef)} refreshLabel="Read it again" />}
          {detailBusy && <p className="hint" role="status">Reading the run from the board…</p>}
          {detail && !detailError && run && (
            <>
              <p className="hint">
                {run.sampleCount} sample{run.sampleCount === 1 ? '' : 's'} of {run.metricCount} metric
                {run.metricCount === 1 ? '' : 's'}
                {run.single && run.sampledAt && (
                  <>
                    {' '}taken <time dateTime={run.sampledAt}>{formatTimestamp(run.sampledAt)}</time>
                  </>
                )}
                {!run.single && run.firstSampleAt && run.lastSampleAt && (
                  <>
                    {' '}from <time dateTime={run.firstSampleAt}>{formatTimestamp(run.firstSampleAt)}</time> to{' '}
                    <time dateTime={run.lastSampleAt}>{formatTimestamp(run.lastSampleAt)}</time>
                  </>
                )}
                {run.crossed > 0 && `, ${run.crossed} of them crossing a threshold`}.
              </p>
              {run.metrics.length > 0 && (
                <>
                  <p className="hint">
                    {run.single
                      ? "This run holds one sample, so each metric's mean, minimum and maximum are that one value."
                      : "The smallest, largest and mean value of each metric over this run's samples."}{' '}
                    The labels, units and thresholds are the ones the run itself recorded.
                  </p>
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
                      {run.metrics.map((metric) => {
                        const peak = statusInfo(metric.status)
                        return (
                          <tr key={metric.key}>
                            <th scope="row">
                              {metric.label}
                              {metric.description && <span className="hint">{metric.description}</span>}
                            </th>
                            <td>{metric.group}</td>
                            <td className="stats-cell-value">{formatValue(metric.mean, metric.unit)}</td>
                            <td className="stats-cell-value">{formatValue(metric.minimum, metric.unit)}</td>
                            <td className="stats-cell-value">
                              {formatValue(metric.maximum, metric.unit)}
                              {metric.status !== 'ok' && <Pill tone={peak.tone}>{peak.label}</Pill>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </>
              )}
              {run.undefinedKeys.length > 0 && (
                <p className="hint">
                  This run also recorded {run.undefinedKeys.length} value
                  {run.undefinedKeys.length === 1 ? '' : 's'} it carries no definition for:{' '}
                  {run.undefinedKeys.join(', ')}.
                </p>
              )}
              {run.facts.length > 0 && (
                <details className="stats-detail">
                  <summary>Run metadata</summary>
                  <KeyValueTable rows={run.facts} caption={`Run ${openRef}`} />
                </details>
              )}
              {run.facts.length === 0 && <p className="hint">Sentinel recorded no metadata for this run.</p>}
              {run.extras.length > 0 && (
                <details className="stats-detail">
                  <summary>Other fields Sentinel returned</summary>
                  <KeyValueTable rows={run.extras} />
                </details>
              )}
            </>
          )}
          {detail && !detailError && !run && (
            detailRows.length > 0 ? (
              <>
                <p className="hint">
                  This Sentinel build answered with a run body Insight does not know; its values are listed as they came
                  from the board.
                </p>
                <KeyValueTable rows={detailRows} caption={`Run ${openRef}`} />
              </>
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
          {compareStale && <StaleBanner what="This comparison" payload={compare} onRefresh={onCompare} refreshLabel="Compare again" />}
          {table ? (
            <>
              <p className="hint">
                Each value is that metric's {table.statistic} over the run, and the change beside it is against the
                baseline{table.baselineLabel ? ` ${table.baselineLabel}` : ''}.
                {table.generatedAt && (
                  <>
                    {' '}Compared <time dateTime={table.generatedAt}>{formatTimestamp(table.generatedAt)}</time>.
                  </>
                )}
              </p>
              {legend.length > 0 && (
                <ul className="periph-notes stats-compare-legend">
                  {legend.map((line) => <li key={line}>{line}</li>)}
                </ul>
              )}
              {table.columns.some((column) => !column.summarised) && (
                <Callout tone="warn" title="Sentinel summarised only some of these runs">
                  <p>
                    {table.columns.filter((column) => !column.summarised).map((column) => column.label).join(', ')} came back
                    with no summary, so every value in that column is “—”. Re-record the run, or compare the runs Sentinel did
                    summarise.
                  </p>
                </Callout>
              )}
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
                  {table.rows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{row.label}</th>
                      {row.cells.map((cell) => (
                        <td key={`${row.key}-${cell.column}`} className="stats-cell-value">
                          {formatValue(cell.value, row.unit)}
                          {!cell.baseline && (
                            <span
                              className={cell.deltaPct === null ? 'hint' : 'hint stats-delta'}
                              title={deltaAbsenceText(cell.deltaAbsence) || undefined}
                            >
                              {formatPercentDelta(cell.deltaPct)}
                              {cell.deltaAbsence && (
                                <span className="sr-only">
                                  {` no change shown, because ${deltaAbsenceText(cell.deltaAbsence)}`}
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
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

/**
 * The machine Insight runs on, from /api/metrics. It is deliberately the smallest panel
 * in this view and sits below the board's: it answers "is my SDK container out of disk",
 * which is a different question from what the board is doing, and the two must not be
 * read as one set of numbers.
 */
function HostPanel({ model, error, updatedAt, busy, now, onRefresh }) {
  // An endpoint that answered with nothing has no rows worth drawing; it has a sentence.
  const notice = hostNotice(model, updatedAt > 0)
  return (
    <section className="panel stats-host" aria-labelledby="stats-host-title" aria-busy={busy}>
      <div className="panel-topbar">
        <div>
          <h2 id="stats-host-title">Insight host</h2>
          <p className="section-note">{model.sourceLabel}, not the board above.</p>
        </div>
        <button type="button" className="btn-ghost" onClick={onRefresh} disabled={busy}>
          {busy ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      <FailureCallout notice={error} />
      {notice ? (
        <p className="hint">{notice}</p>
      ) : (
        <ul className="stats-host-rows">
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
      {updatedAt > 0 && <p className="hint">Read {formatRelativeTime(new Date(updatedAt).toISOString(), now)}.</p>}
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
  const [installResult, setInstallResult] = useState(null)
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
  const [host, setHost] = useState(null)
  const [hostError, setHostError] = useState(null)
  const [hostBusy, setHostBusy] = useState(false)
  const [hostReadAt, setHostReadAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  const mounted = useRef(false)
  // One in-flight request per endpoint: a second click must not run a second command
  // on the board while the first is still out.
  const guard = useRef(createRequestGuard())
  const tick = useRef(() => {})
  const detailSeq = useRef(0)

  const info = useMemo(() => daemonInfo(state), [state])
  const model = useMemo(() => metricsModel(metrics), [metrics])
  const trace = useMemo(() => traceModel(traces), [traces])
  const runRows = useMemo(() => runList(runs), [runs])
  const hostModel = useMemo(() => hostMetricsModel(host), [host])
  // The board's own metric definitions, used to label saved runs and comparisons, which
  // carry metric keys but no labels or units of their own.
  const definitions = useMemo(() => definitionsByKey(metrics), [metrics])
  // Everything the board answered is judged against the board selected now, including
  // the failures: an SSH round trip can outlive a board switch.
  const stalePayloads = staleFlags(board, {
    state,
    metrics,
    metricsError,
    traces,
    traceError,
    runs,
    runsError,
    detail,
    detailError,
    compare,
    compareError,
    install: installResult,
    installError
  })
  const stale = stalePayloads.metrics || stalePayloads.state
  const polling = info.available && live && !halted && !stale
  const delay = pollDelay(failures)
  const generation = board?.generation ?? null

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
    setInstallResult(null)
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
      if (mounted.current) setBoardError(failureNotice(err, generation))
      return null
    }
  }

  async function loadState({ quiet = false } = {}) {
    if (!guard.current.begin('state')) return null
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
        setStateError(failureNotice(err, generation))
      }
      return null
    } finally {
      guard.current.end('state')
      if (mounted.current && !quiet) setStateBusy(false)
    }
  }

  async function loadTraces({ quiet = false } = {}) {
    if (!guard.current.begin('traces')) return
    if (!quiet) setTraceBusy(true)
    try {
      const data = await fetchActiveTrace()
      if (!mounted.current) return
      setTraces(data)
      setTraceError(null)
    } catch (err) {
      if (mounted.current) setTraceError(failureNotice(err, generation))
    } finally {
      guard.current.end('traces')
      if (mounted.current && !quiet) setTraceBusy(false)
    }
  }

  async function loadRuns() {
    if (!guard.current.begin('runs')) return
    setRunsBusy(true)
    try {
      const data = await fetchRuns()
      if (!mounted.current) return
      setRuns(data)
      setRunsError(null)
    } catch (err) {
      if (mounted.current) setRunsError(failureNotice(err, generation))
    } finally {
      guard.current.end('runs')
      if (mounted.current) setRunsBusy(false)
    }
  }

  async function loadHost() {
    if (!guard.current.begin('host')) return
    setHostBusy(true)
    try {
      const data = await fetchHostMetrics()
      if (!mounted.current) return
      setHost(data)
      setHostError(null)
      setHostReadAt(Date.now())
    } catch (err) {
      // The host snapshot belongs to Insight itself, so a board generation means nothing here.
      if (mounted.current) setHostError(failureNotice(err))
    } finally {
      guard.current.end('host')
      if (mounted.current) setHostBusy(false)
    }
  }

  async function pollMetrics({ manual = false } = {}) {
    if (manual) setMetricsBusy(true)
    // A refresh asked for while a poll is already out is that poll: it clears the busy
    // flag when it lands, so the button reports the wait instead of doing nothing.
    if (!guard.current.begin('metrics')) return
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
      const notice = failureNotice(err, generation)
      setMetricsError(notice)
      setFailures((count) => count + 1)
      // A missing board or a stopped daemon will not answer the next tick either:
      // stop polling it and re-read the daemon state so the page says why.
      if (notice.board || notice.daemon) {
        setHalted(true)
        loadState({ quiet: true })
      }
    } finally {
      guard.current.end('metrics')
      if (mounted.current) setMetricsBusy(false)
    }
  }

  async function install() {
    if (!guard.current.begin('install')) return
    setInstallBusy(true)
    setInstallError(null)
    setInstallResult(null)
    try {
      const data = await installSentinel()
      if (!mounted.current) return
      setInstallResult(data)
      onStatus?.(`Sentinel installed on ${data.board?.label || 'the board'}.`)
      await loadState({ quiet: true })
      if (mounted.current) pollMetrics({ manual: true })
    } catch (err) {
      if (!mounted.current) return
      const notice = failureNotice(err, generation, { action: 'install' })
      setInstallError(notice)
      onError?.(notice.message)
      loadState({ quiet: true })
    } finally {
      guard.current.end('install')
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
    if (!guard.current.begin('trace-action')) return
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
      if (mounted.current) setTraceError(failureNotice(err, generation))
    } finally {
      guard.current.end('trace-action')
      if (mounted.current) setTraceBusy(false)
    }
  }

  async function onStopTrace() {
    if (!guard.current.begin('trace-action')) return
    setTraceBusy(true)
    setTraceError(null)
    try {
      await stopTrace()
      if (!mounted.current) return
      onStatus?.('Trace stopped and saved as a run.')
      await loadTraces({ quiet: true })
      loadRuns()
    } catch (err) {
      if (mounted.current) setTraceError(failureNotice(err, generation))
    } finally {
      guard.current.end('trace-action')
      if (mounted.current) setTraceBusy(false)
    }
  }

  async function openRun(ref) {
    setOpenRef(ref)
    setDetail(null)
    setDetailError(null)
    if (!ref || !guard.current.begin('run')) return
    const seq = ++detailSeq.current
    setDetailBusy(true)
    try {
      const data = await fetchRun(ref)
      if (!mounted.current || seq !== detailSeq.current) return
      setDetail(data)
    } catch (err) {
      if (mounted.current && seq === detailSeq.current) setDetailError(failureNotice(err, generation))
    } finally {
      guard.current.end('run')
      if (mounted.current && seq === detailSeq.current) setDetailBusy(false)
    }
  }

  async function runCompare() {
    if (!guard.current.begin('compare')) return
    setCompareBusy(true)
    setCompareError(null)
    try {
      const data = await compareRuns(selected)
      if (mounted.current) setCompare(data)
    } catch (err) {
      if (mounted.current) {
        setCompare(null)
        setCompareError(failureNotice(err, generation))
      }
    } finally {
      guard.current.end('compare')
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

  // The host moves slowly and costs a psutil read, so it is polled far less often than
  // the board, and like the board poll it stops with the view and with a hidden tab.
  useEffect(() => {
    let timer = null
    const run = () => loadHost()
    const start = () => {
      if (timer !== null) return
      run()
      timer = setInterval(run, HOST_POLL_MS)
    }
    const stop = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start())
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

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
          {/* Nothing to say about a daemon that is working: the telemetry below is the proof. */}
          {daemonNoticeNeeded(info, { error: installError || sentinelProblem, health: state?.health || null, install: installResult }) && (
          <DaemonPanel
            info={info}
            health={state?.health || null}
            busy={daemonBusy({ installBusy, stateBusy })}
            installing={installBusy}
            install={installResult}
            installStale={stalePayloads.install}
            error={installError || sentinelProblem}
            blocked={Boolean(boardProblem)}
            onInstall={install}
            onRetry={() => loadState()}
          />
          )}

          {/* Sentinel not answering now does not unmake what this board already gave. */}
          {telemetryVisible(info, { metrics, traces, runs }) && (
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
                stale={stalePayloads.traces || stalePayloads.traceError}
                busy={traceBusy}
                form={form}
                formError={formError}
                error={traceError}
                now={now}
                onFormChange={setForm}
                onStart={onStartTrace}
                onStop={onStopTrace}
                onRefreshTrace={() => loadTraces()}
              />

              <RunsPanel
                runs={runRows}
                runsPayload={runs}
                definitions={definitions}
                stale={stalePayloads.runs || stalePayloads.runsError}
                busy={runsBusy}
                error={runsError}
                selected={selected}
                openRef={openRef}
                detail={detail}
                detailError={detailError}
                detailBusy={detailBusy}
                detailStale={stalePayloads.detail || stalePayloads.detailError}
                compare={compare}
                compareError={compareError}
                compareBusy={compareBusy}
                compareStale={stalePayloads.compare || stalePayloads.compareError}
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
                onDropMissing={(gone) => setSelected((current) => current.filter((ref) => !gone.includes(ref)))}
              />
            </>
          )}
        </>
      )}

      <HostPanel
        model={hostModel}
        error={hostError}
        updatedAt={hostReadAt}
        busy={hostBusy}
        now={now}
        onRefresh={loadHost}
      />
    </div>
  )
}
