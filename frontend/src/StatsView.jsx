import { useEffect, useMemo, useRef, useState } from 'react'
import { Callout, Pill } from './peripherals/ui.jsx'
import {
  compareRuns,
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
  HOST_POLL_MS,
  MAX_COMPARE_RUNS,
  compareCsv,
  compareCsvFilename,
  compareGroups,
  compareHint,
  compareReady,
  compareTable,
  compareView,
  compareViewText,
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
  metricGroupChips,
  metricsModel,
  missingSelection,
  openGroup,
  payloadBoardLabel,
  pollDelay,
  RUNS_NOTE,
  runDetail,
  runList,
  runSubtitle,
  staleFlags,
  staleNote,
  statusInfo,
  telemetryVisible,
  toggleSelection,
  traceBar,
  traceExtrasSummary,
  traceModel,
  uncomparableRefs,
  validateTrace
} from './stats/model.js'
import { ChipTabs, Facts, FailureCallout, KeyValueTable, MetricCard, Sparkline } from './stats/ui.jsx'

/** Hands the browser a file to save. The object URL is released once the click has used it. */
// How often the saved-runs list is re-read while the Stats tab is visible.
const RUNS_POLL_MS = 30000

function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.hidden = true
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

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
              ? 'Sentinel cannot be checked until the board answers; the board control in the top right says why.'
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
  // Held by name, not by the group object: every poll builds new groups, and a refresh must
  // not close what the user opened.
  const [openName, setOpenName] = useState(null)
  const chips = useMemo(() => metricGroupChips(model.groups), [model.groups])
  const group = openGroup(model.groups, openName)
  return (
    <section className="panel stats-metrics" aria-labelledby="stats-metrics-title" aria-busy={busy}>
      <div className="panel-topbar">
        <div>
          {/* The pill is the only update state the section shows: Live, Paused, or Not updating. */}
          <div className="stats-title-row">
            <h2 id="stats-metrics-title">Live metrics</h2>
            <Pill tone={polling ? 'ok' : ''}>{polling ? 'Live' : paused ? 'Paused' : 'Not updating'}</Pill>
          </div>
          <p className="section-note">Sentinel live readings from the board.</p>
        </div>
        <div className="periph-actions">
          {/* Live metrics poll on their own; pausing is the only control they need. */}
          <button type="button" className="btn-tonal" onClick={onToggleLive}>
            {live ? 'Pause updates' : 'Resume updates'}
          </button>
        </div>
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

      {model.groups.length > 0 && (
        <>
          <ChipTabs
            label="Metric groups"
            items={chips}
            selected={group ? group.name : null}
            onSelect={setOpenName}
            idPrefix="stats-group-tab"
            panelId="stats-group-panel"
            noun="metric"
            collapsible
          />
          <div
            id="stats-group-panel"
            role="tabpanel"
            className="stats-group-panel"
            aria-labelledby={group ? `stats-group-tab-${chips.findIndex((chip) => chip.id === group.name)}` : undefined}
            hidden={!group}
          >
            {group && (
              <table className="sysinfo-table stats-table">
                <caption className="sr-only">{group.name} metrics</caption>
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
            )}
          </div>
        </>
      )}

      {!model.groups.length && !error && (
        <p className="hint">{busy ? 'Reading the first sample…' : 'Sentinel has not reported any metric yet.'}</p>
      )}
    </section>
  )
}

/**
 * The Runs panel's header row, less its title and Refresh: the trace form, or what is
 * recording and the control that stops it. The note and tags fields it can unfold, and
 * what a recording trace was started with, are rendered below the header by `TraceDetails`.
 */
function TraceBar({ bar, busy, form, extras, extrasShown, onToggleExtras, onFormChange, onStart, onStop }) {
  if (bar.recording) {
    return (
      <div className="stats-trace-bar">
        <Pill tone="ok">Recording</Pill>
        <span className="stats-trace-running">{bar.name}</span>
        {bar.started && (
          <span className="hint">
            started <time dateTime={bar.startedAt} title={formatTimestamp(bar.startedAt)}>{bar.started}</time>
          </span>
        )}
        {bar.tags.length > 0 && (
          <span className="periph-pills">
            {bar.tags.map((tag) => <Pill key={tag} tone="periph-info">{tag}</Pill>)}
          </span>
        )}
        <button type="button" className="btn-tonal" onClick={onStop} disabled={busy}>{bar.stopLabel}</button>
      </div>
    )
  }
  return (
    <form id="stats-trace-form" className="stats-trace-bar" onSubmit={onStart} aria-label="Start a trace">
      <label className="stats-trace-name">
        {/* One label, inside the box: a visible "Trace name" beside a "baseline" example said it twice.
            Screen readers still get the name from the hidden text, not from the placeholder. */}
        <span className="sr-only">Trace name</span>
        <input
          value={form.name}
          onChange={(event) => onFormChange({ ...form, name: event.target.value })}
          placeholder="Trace name (e.g. baseline)"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <button type="submit" className="btn-tonal" disabled={busy}>{bar.submitLabel}</button>
      <button
        type="button"
        className="btn-ghost"
        aria-expanded={extrasShown}
        aria-controls="stats-trace-extras"
        onClick={onToggleExtras}
      >
        Add note and tags
      </button>
      {!extrasShown && extras && <span className="hint">{extras}</span>}
    </form>
  )
}

/** What sits under the header row: the unfolded note and tags, or a recording trace's note and summary. */
function TraceDetails({ bar, trace, form, formError, extrasShown, onFormChange }) {
  if (bar.recording) {
    return (
      <>
        {bar.note && <p className="hint stats-trace-note">{bar.note}</p>}
        <KeyValueTable rows={trace.facts} caption="Running trace summary" />
      </>
    )
  }
  return (
    <>
      {/* Outside the form element so the header row stays one row; `form` keeps them in it. */}
      <div id="stats-trace-extras" className="periph-form stats-trace-extras" hidden={!extrasShown}>
        <label>
          Note (optional)
          <input
            form="stats-trace-form"
            value={form.note}
            onChange={(event) => onFormChange({ ...form, note: event.target.value })}
            placeholder="before the NMS change"
            autoComplete="off"
          />
        </label>
        <label>
          Tags (optional, comma separated)
          <input
            form="stats-trace-form"
            value={form.tags}
            onChange={(event) => onFormChange({ ...form, tags: event.target.value })}
            placeholder="compiler-v2, yolo26"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      {formError && (
        <>
          <p className="sr-only" role="alert">{formError}</p>
          <Callout tone="danger" title={formError} />
        </>
      )}
    </>
  )
}

export function RunsPanel({
  trace,
  traceStale,
  traceBusy,
  traceError,
  form,
  formError,
  onFormChange,
  onStart,
  onStop,
  onRefreshTrace,
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
  compareOpen,
  now,
  onRefresh,
  onToggle,
  onOpen,
  onCompare,
  onClearCompare,
  onDropMissing,
  onToggleCompare
}) {
  const table = useMemo(() => (compare ? compareTable(compare, definitions) : null), [compare, definitions])
  const [compareGroup, setCompareGroup] = useState(ALL_GROUPS)
  const [changesOnly, setChangesOnly] = useState(false)
  const groups = useMemo(() => compareGroups(table), [table])
  const view = useMemo(() => compareView(table, { group: compareGroup, changesOnly }), [table, compareGroup, changesOnly])

  // Everything the table holds, not what the filter shows: a filter is how it is being read.
  function exportCsv() {
    downloadText(compareCsvFilename(table), compareCsv(table), 'text/csv;charset=utf-8')
  }
  // Why the em dashes in the table are there, counted from the comparison itself.
  // Runs that were selected and are no longer on the board: their checkbox is gone.
  const missing = useMemo(() => missingSelection(selected, runs), [selected, runs])
  // Runs whose own name breaks the comma-separated compare query.
  const uncomparable = useMemo(() => uncomparableRefs(selected), [selected])
  const fallbackRows = useMemo(() => (compare && !table ? factRows(compare.sentinel, []) : []), [compare, table])
  const run = useMemo(() => runDetail(detail), [detail])
  // Only reached when the body is not the metadata/metrics/samples one the daemon sends.
  const detailRows = useMemo(() => (detail && !run ? factRows(detail.sentinel, ['samples']) : []), [detail, run])

  const bar = traceBar(trace, { busy: traceBusy, now })
  const [extrasOpen, setExtrasOpen] = useState(false)
  // Text left in the folded note and tags fields is still sent, so it is still said.
  const extras = traceExtrasSummary(form)
  // A refused note or tag list is shown where it can be fixed, not behind the fold.
  const extrasShown = extrasOpen || Boolean(formError && extras)

  return (
    <section className="panel stats-runs" aria-labelledby="stats-runs-title" aria-busy={busy || traceBusy}>
      <div className="stats-runs-head">
        <h2 id="stats-runs-title">Runs</h2>
        <TraceBar
          bar={bar}
          busy={traceBusy}
          form={form}
          extras={extras}
          extrasShown={extrasShown}
          onToggleExtras={() => setExtrasOpen(!extrasShown)}
          onFormChange={onFormChange}
          onStart={onStart}
          onStop={onStop}
        />
      </div>
      <TraceDetails
        bar={bar}
        trace={trace}
        form={form}
        formError={formError}
        extrasShown={extrasShown}
        onFormChange={onFormChange}
      />
      <p className="section-note stats-runs-note">{RUNS_NOTE}</p>

      <FailureCallout notice={traceError} />
      {traceStale && <StaleBanner what="This trace" payload={trace.payload} onRefresh={onRefreshTrace} />}
      <FailureCallout notice={error} />
      {stale && <StaleBanner what="These runs" payload={runsPayload} onRefresh={onRefresh} />}

      {runs.length === 0 && !error && (
        <p className="hint">{busy ? 'Reading runs from the board…' : 'No runs yet. Start a trace to record one.'}</p>
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
                  </div>
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
        <section className="stats-compare" aria-labelledby="stats-compare-title">
          <div className="stats-compare-head">
            <h3 id="stats-compare-title">Comparison</h3>
            <div className="periph-actions">
              {table && (
                <button type="button" className="btn-ghost" onClick={exportCsv} aria-describedby="stats-compare-export-note">
                  Export CSV
                </button>
              )}
              <button
                type="button"
                className="btn-ghost"
                aria-expanded={compareOpen}
                aria-controls="stats-compare-body"
                onClick={onToggleCompare}
              >
                {compareOpen ? 'Collapse' : 'Expand'}
              </button>
            </div>
          </div>
          {table && (
            <p id="stats-compare-export-note" className="sr-only">
              Exports all {table.rows.length} rows of the comparison, whichever group or changes filter is on screen.
            </p>
          )}
          {compareStale && <StaleBanner what="This comparison" payload={compare} onRefresh={onCompare} refreshLabel="Compare again" />}
          <div id="stats-compare-body" hidden={!compareOpen}>
            {table ? (
              <>
                {/* Each “—” carries its reason on hover, so the table needs no paragraph explaining them. */}
                {table.columns.some((column) => !column.summarised) && (
                  <Callout tone="warn" title="Sentinel summarised only some of these runs">
                    <p>
                      {table.columns.filter((column) => !column.summarised).map((column) => column.label).join(', ')} came back
                      with no summary, so every value in that column is “—”. Re-record the run, or compare the runs Sentinel did
                      summarise.
                    </p>
                  </Callout>
                )}
                <div className="stats-compare-filters">
                  <ChipTabs
                    label="Filter the comparison by metric group"
                    items={groups}
                    selected={view.group}
                    onSelect={(id) => setCompareGroup(id || ALL_GROUPS)}
                    idPrefix="stats-compare-tab"
                    panelId="stats-compare-panel"
                    noun="row"
                    automatic
                  />
                  <label className="stats-toggle">
                    <input type="checkbox" checked={changesOnly} onChange={(event) => setChangesOnly(event.target.checked)} />
                    Changes only
                  </label>
                </div>
                <p className="hint" role="status">
                  {compareViewText(view)}
                  {view.rows.length < view.total && ` Export CSV still writes all ${view.total}.`}
                </p>
                <div
                  id="stats-compare-panel"
                  role="tabpanel"
                  aria-labelledby={`stats-compare-tab-${groups.findIndex((item) => item.id === view.group)}`}
                >
                  <div className="stats-table-scroll" role="region" aria-label="Comparison table" tabIndex={0}>
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
                  </div>
                </div>
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
          </div>
        </section>
      )}
    </section>
  )
}

/**
 * The machine Insight runs on, from /api/metrics. It is deliberately the smallest panel
 * in this view and sits below the board's: it answers "is my SDK container out of disk",
 * which is a different question from what the board is doing, and the two must not be
 * read as one set of numbers. Its readings are always on screen, as one short row.
 */
function HostPanel({ model, error, updatedAt, busy, now }) {
  // An endpoint that answered with nothing has no rows worth drawing; it has a sentence.
  const notice = hostNotice(model, updatedAt > 0)
  return (
    <section className="panel stats-host" aria-labelledby="stats-host-title" aria-busy={busy}>
      <div className="stats-host-head">
        <h2 id="stats-host-title">Insight host</h2>
        {/* One run of text: the flex gap between two spans left a hole mid-sentence. */}
        <span className="hint">
          {model.sourceLabel}, not the board.
          {updatedAt > 0 && (
            <>
              {' '}Read <time dateTime={new Date(updatedAt).toISOString()}>{formatRelativeTime(new Date(updatedAt).toISOString(), now)}</time>.
            </>
          )}
        </span>
      </div>

      <FailureCallout notice={error} />
      {notice ? (
        <p className="hint stats-host-notice">{notice}</p>
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

export default function StatsView({ board = null, boardError = null, onOpenBoardPanel, onReloadBoard, onError, onStatus }) {
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
  // Collapsing keeps the comparison; only Compare reads the board again.
  const [compareOpen, setCompareOpen] = useState(true)
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

  function loadBoard() {
    return onReloadBoard ? onReloadBoard() : null
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
      if (mounted.current) {
        setCompare(data)
        setCompareOpen(true)
      }
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

  // The masthead changes the board; this page follows it. Another board means another daemon,
  // other runs and another history, so nothing read from the previous one is kept.
  const seenGeneration = useRef(generation)
  useEffect(() => {
    if (seenGeneration.current === generation) return
    const first = seenGeneration.current === null
    seenGeneration.current = generation
    if (first) return
    setState(null)
    reset()
    loadState({ quiet: true })
  }, [generation])

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

  // The run list keeps itself current, so the panel needs no Refresh button. Insight's own traces
  // already re-read it when they start and stop; this catches runs recorded or deleted elsewhere
  // (another Insight, the Sentinel CLI). Paused while the tab is hidden: each read runs on the board.
  const sentinelAvailable = Boolean(state?.available)
  useEffect(() => {
    if (!sentinelAvailable) return undefined
    const timer = setInterval(() => {
      if (!document.hidden) loadRuns()
    }, RUNS_POLL_MS)
    return () => clearInterval(timer)
  }, [sentinelAvailable, generation])


  const boardProblem = boardError || (stateError?.board ? stateError : null)
  const sentinelProblem = stateError && !stateError.board ? stateError : null

  return (
    <div className="periph-view stats-view">
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

              <RunsPanel
                trace={trace}
                traceStale={stalePayloads.traces || stalePayloads.traceError}
                traceBusy={traceBusy}
                traceError={traceError}
                form={form}
                formError={formError}
                onFormChange={setForm}
                onStart={onStartTrace}
                onStop={onStopTrace}
                onRefreshTrace={() => loadTraces()}
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
                compareOpen={compareOpen}
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
                onToggleCompare={() => setCompareOpen((open) => !open)}
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
      />
    </div>
  )
}
