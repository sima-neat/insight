import { useEffect, useRef, useState } from 'react'
import ConfirmDialog from './ConfirmDialog.jsx'
import ModelMarkdown from './ModelMarkdown.jsx'
import { chatModels, friendlyModelName } from './genai/backendState.js'
import {
  BENCH_LIMITS,
  benchProgress,
  benchmarkCsv,
  benchmarkFilename,
  benchmarkJson,
  benchmarkRequest,
  comparisonRows,
  defaultChoice,
  firstWordTime,
  firstWordVerdict,
  formatNumber,
  resultBadge,
  resultsSummary,
  runCount,
  runsText,
  settingsText,
  speedVerdict,
  wordsPerSecondText
} from './genai/benchmark.js'
import { getJson, postJson } from './genai/client.js'
import { benchmarkLoadQuestion } from './genai/confirmations.js'
import { afterLoad, unloadChoice } from './genai/models.js'

const POLL_MS = 500
const STATUS_FAILURES_MAX = 20     // about 10 s of failing status polls

function download(name, text, type) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([text], { type }))
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(link.href), 1500)
}

// The standalone Studio's benchmark: time to first token and tokens per second
// for one or more chat models on the board, run one model at a time. A model
// that isn't loaded is loaded first. A board that keeps several loaded refuses
// a load past its limit or its memory (409); the run then unloads the models
// the board names, as a board that keeps one does on its own. A run that loads
// a model says so first, in the page (ConfirmDialog).
// ticket: the tab's board session (genai/boardSession.js); leaving the tab or
// changing boards ends the run. boardNow(): which board the tab is on, so a stop only goes to the
// board that runs the benchmark. onRunningChange tells the tab's rule table.
export default function GenAIBenchmark({ status, ticket, boardNow, onClose, onModelsChanged, onRunningChange }) {
  const models = chatModels(status)
  const loaded = new Set((status && status.loaded) || [])
  const [chosen, setChosen] = useState(() => defaultChoice(models, loaded))
  const [runs, setRuns] = useState(String(BENCH_LIMITS.runs.default))
  const [maxTokens, setMaxTokens] = useState(String(BENCH_LIMITS.maxTokens.default))
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState('')          // what is happening now, in words
  const [live, setLive] = useState(null)          // latest /benchmark/status
  const [results, setResults] = useState([])      // [{model, summary, runs, failed}]
  const [note, setNote] = useState('')
  const [ask, setAsk] = useState(null)            // the question before a run that loads a model
  const [current, setCurrent] = useState(0)       // which of the chosen models is being tested
  const [reviewing, setReviewing] = useState(false)   // the results replace the setup until "Change models"
  const stopRequested = useRef(false)
  // The settings the shown results were measured with, fixed when the run
  // starts: the inputs can change afterwards, the record must not.
  const [runConfig, setRunConfig] = useState(null)
  // The run's ticket: when it is no longer live (the tab closed, the board
  // changed), the loop ends and nothing more is shown.
  const runTicket = useRef(null)
  const over = () => stopRequested.current || !runTicket.current || !runTicket.current.live()

  const runBoard = useRef(null)

  // Closing the panel or leaving the tab mid-run stops the board's benchmark too. After a board
  // change the relay reaches the new board, whose own run isn't this one to stop.
  useEffect(() => () => {
    if (runTicket.current && !stopRequested.current && runBoard.current === boardNow?.()) {
      stopRequested.current = true
      postJson('benchmark/stop', {}).catch(() => {})
    }
  }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !running && !ask) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, ask, onClose])

  function toggle(name) {
    setChosen((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))
  }

  // Polls the board's run. A status that keeps failing (about 10 s of errors in
  // a row) ends the wait with that error instead of "running" forever.
  async function waitForRun() {
    let failures = 0
    for (;;) {
      if (over()) return null
      let state = null
      try {
        state = await getJson('benchmark/status', { signal: runTicket.current.signal })
        failures = 0
      } catch (error) {
        failures += 1
        if (failures >= STATUS_FAILURES_MAX) return { error: error.message }
      }
      if (over()) return null
      if (state) setLive(state)
      if (state && !state.running) return state
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  // What is loaded during a run: the tab's status at the start, then what this
  // run's own loads change (each answer names the models it unloaded).
  const runLoaded = useRef(new Set())

  async function loadForRun(model) {
    const options = { signal: runTicket.current.signal }
    try {
      return await postJson('models/load', { name: model }, options)
    } catch (error) {
      const choice = unloadChoice(error)
      if (!choice || !choice.candidates.length || over()) throw error
      return await postJson('models/load', { name: model, unload: choice.candidates }, options)
    }
  }

  async function benchmarkOne(model) {
    setLive(null)
    if (!runLoaded.current.has(model)) {
      setPhase(`Loading ${friendlyModelName(model)}: this takes a few minutes…`)
      try {
        const answer = await loadForRun(model)
        runLoaded.current = afterLoad(runLoaded.current, model, answer)
        onModelsChanged?.()
      } catch (error) {
        // A failed load may already have unloaded others: what is loaded is
        // unknown now, so every later model is loaded before its run.
        runLoaded.current = new Set()
        if (over()) return null
        return { model, failed: `failed to load: ${error.message}`, stage: 'load' }
      }
    }
    if (over()) return null
    setPhase(`Testing ${friendlyModelName(model)}`)
    try {
      const started = await postJson('benchmark/run', benchmarkRequest({ model, runs, maxTokens, prompt }), { signal: runTicket.current.signal })
      if (over()) {
        // Stop arrived while the run was starting, so the board's stop found
        // nothing to stop: stop the run that has now begun.
        if (stopRequested.current) {
          const earlier = stopDone.current
          stopDone.current = (async () => {
            await earlier
            await stopBoardRun(runTicket.current)
          })()
        }
        return null
      }
      setLive(started)
    } catch (error) {
      if (over()) return null
      return { model, failed: error.message, stage: 'run' }
    }
    const final = await waitForRun()
    if (!final) return null
    if (final.error) {
      // The board's run may still be going: stop it and end the benchmark here,
      // so no next model starts beside it.
      stopDone.current = stopBoardRun(runTicket.current)
      return { model, failed: `lost track of the run: ${final.error}`, stage: 'run', abort: true }
    }
    return { model, summary: final.summary || null, runs: final.runs || [], prompt: final.prompt }
  }

  // `agreedTo` is the plan a yes answered: the status poll can change what a
  // run loads or unloads while the question is open, so a plan that differs by
  // then is asked about again.
  function requestRun(agreedTo = null) {
    if (!chosen.length || running) return
    const question = benchmarkLoadQuestion(status, chosen)
    if (question && question.plan !== agreedTo) {
      setAsk({ ...question, ticket: ticket() })
      return
    }
    run()
  }

  // A board change while the question is open drops the answer.
  function answerAsk(yes) {
    const asked = ask
    setAsk(null)
    if (yes && asked.ticket.live()) requestRun(asked.plan)
  }

  async function run() {
    stopRequested.current = false
    runTicket.current = ticket()
    runBoard.current = boardNow?.()
    runLoaded.current = new Set((status && status.loaded) || [])
    setRunConfig({ runs, maxTokens, prompt })
    setRunning(true)
    onRunningChange?.(true)
    setResults([])
    setNote('')
    setReviewing(false)
    const done = []
    for (const [index, model] of chosen.entries()) {
      if (over()) break
      setCurrent(index)
      const result = await benchmarkOne(model)
      if (!result) break
      done.push(result)
      setResults([...done])
      if (result.abort) {
        setNote('The benchmark ended early: the board stopped answering about the run.')
        break
      }
    }
    // Unlock only once a Stop has reached the board and its run has ended.
    if (stopDone.current) await stopDone.current
    if (!runTicket.current.live()) return     // the tab closed or the board changed
    stopDone.current = null
    // The run's loads may have changed which model is loaded: fetch that
    // before the tab unlocks, so nothing is sent to a model that is gone.
    setPhase('Updating the model list…')
    try {
      await onModelsChanged?.()
    } catch {
      // The tab's own polling catches up.
    }
    if (!runTicket.current.live()) return
    runTicket.current = null
    setPhase('')
    setRunning(false)
    setReviewing(done.length > 0)
    onRunningChange?.(false)
    if (stopRequested.current) setNote('Benchmark stopped.')
  }

  // Stop: ask the board to stop, then wait (up to about 10 s) until its run has
  // ended; run() keeps the tab locked until this settles.
  const stopDone = useRef(null)
  function stop() {
    if (stopRequested.current) return
    stopRequested.current = true
    setPhase('Stopping…')
    stopDone.current = stopBoardRun(runTicket.current)
  }

  // Asks the board to stop its run, then waits (up to about 10 s) until it has.
  async function stopBoardRun(ticketNow) {
    try {
      await postJson('benchmark/stop', {}, { signal: ticketNow ? ticketNow.signal : undefined })
    } catch {
      // The board may have finished already.
    }
    for (let i = 0; i < 20 && ticketNow && ticketNow.live(); i += 1) {
      try {
        const state = await getJson('benchmark/status', { signal: ticketNow.signal })
        if (!state.running) return
      } catch {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  const progress = benchProgress(live)
  const rows = comparisonRows(results)
  const last = results.length ? results[results.length - 1] : null
  // Only a run with at least one measured model can be exported.
  const exportable = results.some((r) => r.summary)
  const measured = rows.filter((r) => !r.failed).length
  const summary = resultsSummary(rows)
  const upNext = chosen.slice(current + 1)

  return (
    <div className="genai-bench genai-bench-guided" role="dialog" aria-modal="true" aria-label="Benchmark">
      <div className="genai-bench-top">
        <h2>Benchmark</h2>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={running} title={running ? 'Stop the benchmark first' : 'Close (Esc)'}>Close</button>
      </div>

      <div className="genai-bench-body">
        {!running && !reviewing && (
          <>
            <h3 className="genai-bench-title">How fast is a model on this board?</h3>
            <p className="genai-bench-lead">Each model you choose answers the same question {runCount(runs) === 1 ? 'once' : `${runCount(runs)} times`} while Insight times it. You get two numbers:</p>
            <div className="genai-bench-pair">
              <div className="genai-bench-explain">
                <h4>Time to first word</h4>
                <p>How long you wait before the reply starts.</p>
              </div>
              <div className="genai-bench-explain">
                <h4>Reply speed</h4>
                <p>How fast the reply comes once it starts, in tokens per second. A token is about ¾ of a word.</p>
              </div>
            </div>

            <fieldset className="genai-bench-card genai-bench-models">
              <legend>Choose the models to test</legend>
              {models.length === 0 && <p className="hint">No chat models on the board. Download one in Settings.</p>}
              {models.map((m) => (
                <label key={m.name} title={m.name} className={chosen.includes(m.name) ? 'chosen' : ''}>
                  <input type="checkbox" checked={chosen.includes(m.name)} onChange={() => toggle(m.name)} />
                  <span className="genai-bench-grow">{friendlyModelName(m.name)}</span>
                  {m.supported === false
                    ? <span className="genai-bench-chip warn" title={m.unsupportedReason}>Can't run here</span>
                    : loaded.has(m.name)
                      ? <span className="genai-bench-chip ok">Loaded, ready to test</span>
                      : <span className="genai-bench-chip">Not loaded</span>}
                </label>
              ))}
            </fieldset>

            <details className="genai-bench-more">
              <summary>Advanced options <span>{settingsText({ runs, maxTokens, prompt })}</span></summary>
              <div className="genai-bench-advanced">
                <label className="genai-bench-field">
                  <span>Runs</span>
                  <input type="number" min={BENCH_LIMITS.runs.min} max={BENCH_LIMITS.runs.max} value={runs} onChange={(e) => setRuns(e.target.value)} />
                  <small>How many times each model answers. More runs give a steadier average.</small>
                </label>
                <label className="genai-bench-field">
                  <span>Output tokens</span>
                  <input type="number" min={BENCH_LIMITS.maxTokens.min} max={BENCH_LIMITS.maxTokens.max} step="8" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
                  <small>The longest each answer can be.</small>
                </label>
                <label className="genai-bench-field">
                  <span>Prompt</span>
                  <input type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Leave blank for the standard prompt" />
                  <small>The question each model answers.</small>
                </label>
              </div>
            </details>

            <div className="genai-bench-actions">
              <button type="button" className="genai-bench-run" onClick={() => requestRun()} disabled={!chosen.length}>Run benchmark</button>
              <span className="hint">{chosen.length ? 'The defaults are fine. You can stop at any time.' : 'Choose at least one model.'}</span>
            </div>
          </>
        )}

        {running && (
          <>
            <h3 className="genai-bench-title">Testing {chosen.length === 1 ? '1 model' : `${chosen.length} models`}</h3>
            <p className="genai-bench-lead">Stay on this page. Leaving the GenAI tab stops the test.</p>
            <section className="genai-bench-card" aria-live="polite">
              <div className="genai-bench-actions">
                <p className="genai-bench-phase genai-bench-grow">{phase}</p>
                <span className="hint">Model {Math.min(current + 1, chosen.length)} of {chosen.length}</span>
              </div>
              {live && live.total > 0 && (
                <div className="genai-progress" role="progressbar" aria-label="Benchmark progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.pct ?? undefined}>
                  <div className="genai-progress-fill" style={{ width: `${progress.pct || 0}%` }} />
                </div>
              )}
              {progress.text && <p className="hint">{progress.text}</p>}
              {live && live.current && live.current.text && (
                <div className="genai-bench-metric">
                  <span className="genai-bench-label">The model's reply so far</span>
                  <div className="genai-bench-text"><ModelMarkdown>{live.current.text}</ModelMarkdown></div>
                </div>
              )}
            </section>
            {upNext.length > 0 && (
              <section className="genai-bench-card genai-bench-models" aria-label="Up next">
                <h4>Up next</h4>
                {upNext.map((name) => (
                  <div key={name} className="genai-bench-next" title={name}>
                    <span className="genai-bench-grow">{friendlyModelName(name)}</span>
                    {!runLoaded.current.has(name) && <span className="genai-bench-chip warn">Loads first: a few minutes</span>}
                  </div>
                ))}
              </section>
            )}
            <div className="genai-bench-actions">
              <button type="button" className="btn-ghost danger" onClick={stop}>Stop</button>
            </div>
          </>
        )}

        {note && <p className="hint">{note}</p>}

        {rows.length > 0 && (running || reviewing) && (
          <section className="genai-bench-report" aria-label="Results">
            <h3 className={running ? 'genai-bench-subtitle' : 'genai-bench-title'}>{running ? 'Results so far' : 'Results'}</h3>
            {summary && <p className="genai-bench-lead">{summary}</p>}
            {rows.map((r) => <ResultCard key={r.model} row={r} measured={measured} />)}
            {measured > 0 && <p className="hint">The labels are rules of thumb for chat: under 1 second feels instant, and most people read about 5 tokens a second.</p>}

            <details className="genai-bench-more">
              <summary>All numbers</summary>
              <div className="genai-bench-advanced">
                <div className="genai-bench-scroll">
                  <table className="genai-bench-table">
                    <thead>
                      <tr><th>Model</th><th>Average speed</th><th>Top speed (p90)</th><th>Variation (σ)</th><th>First word</th><th>Reply length</th><th>Runs</th></tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.model}>
                          <td title={r.model}>{friendlyModelName(r.model)}</td>
                          {r.failed ? (
                            <td colSpan={6} className="genai-error">{r.failed}</td>
                          ) : (
                            <>
                              <td className={r.bestTps ? 'genai-bench-best' : ''}>{formatNumber(r.tpsMean)}</td>
                              <td>{formatNumber(r.tpsP90)}</td>
                              <td>{formatNumber(r.tpsStdev, 2)}</td>
                              <td className={r.bestTtft ? 'genai-bench-best' : ''}>{formatNumber(r.ttftMean, 0)} ms</td>
                              <td>{formatNumber(r.tokensMean, 0)}</td>
                              <td>{r.runs}{r.errors ? ` · ${r.errors} failed` : ''}</td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details className="genai-bench-meanings">
                  <summary>What these numbers mean</summary>
                  <dl className="genai-bench-glossary">
                    <dt>Average speed</dt><dd>Tokens per second, averaged over the runs.</dd>
                    <dt>Top speed (p90)</dt><dd>9 in 10 runs were at or below this speed.</dd>
                    <dt>Variation (σ)</dt><dd>How much the speed changed between runs. Smaller is steadier.</dd>
                    <dt>First word</dt><dd>Average wait before the reply starts, in milliseconds.</dd>
                    <dt>Reply length</dt><dd>Average tokens per reply.</dd>
                    <dt>Runs</dt><dd>Runs that finished, and how many failed.</dd>
                  </dl>
                </details>
              </div>
            </details>

            {last && last.runs && last.runs.length > 0 && (
              <details className="genai-bench-more">
                <summary>Each run of {friendlyModelName(last.model)}</summary>
                <div className="genai-bench-advanced">
                  <div className="genai-bench-scroll">
                    <table className="genai-bench-table">
                      <thead><tr><th>#</th><th>First word</th><th>Speed (tokens/s)</th><th>Reply length</th></tr></thead>
                      <tbody>
                        {last.runs.map((r, i) => (
                          <tr key={i}>
                            <td>{i + 1}</td>
                            {r.error ? <td colSpan={3} className="genai-error">{r.error}</td> : (
                              <>
                                <td>{formatNumber(r.ttftMs, 0)} ms</td>
                                <td>{formatNumber(r.tps)}</td>
                                <td>{r.tokens}</td>
                              </>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {last.prompt && <p className="hint">Prompt: {last.prompt}</p>}
                </div>
              </details>
            )}

            <div className="genai-bench-actions">
              {!running && <button type="button" className="genai-bench-run" onClick={() => requestRun()} disabled={!chosen.length}>Run again</button>}
              {!running && <button type="button" className="btn-ghost" onClick={() => setReviewing(false)}>Change models</button>}
              <button type="button" className="btn-ghost" disabled={running || !exportable} onClick={() => download(benchmarkFilename('csv'), benchmarkCsv(results), 'text/csv')}>Download CSV</button>
              <button type="button" className="btn-ghost" disabled={running || !exportable} onClick={() => download(benchmarkFilename('json'), benchmarkJson(results, runConfig), 'application/json')}>Download JSON</button>
            </div>
          </section>
        )}
      </div>

      {ask && (
        <ConfirmDialog
          title={ask.title}
          message={ask.message}
          confirmLabel={ask.confirmLabel}
          onConfirm={() => answerAsk(true)}
          onCancel={() => answerAsk(false)}
        />
      )}
    </div>
  )
}

// One model's two numbers, each with what it means and a label for whether it's
// good; or why the model has none.
function ResultCard({ row, measured }) {
  const badge = row.failed ? '' : resultBadge(row, measured)
  const firstWord = row.failed ? null : firstWordVerdict(row.ttftMean)
  const wait = row.failed ? null : firstWordTime(row.ttftMean)
  const speed = row.failed ? null : speedVerdict(row.tpsMean)
  return (
    <article className="genai-bench-card">
      <div className="genai-bench-actions">
        <h4 className="genai-bench-grow" title={row.model}>{friendlyModelName(row.model)}</h4>
        {badge && <span className="genai-bench-chip best">{badge}</span>}
      </div>
      {row.failed ? <p className="genai-error">{row.failed}</p> : (
        <>
          <div className="genai-bench-pair">
            <div className="genai-bench-metric">
              <span className="genai-bench-label">Time to first word</span>
              <span className="genai-bench-number">{wait.value} <small>{wait.unit}</small></span>
              <span className={`genai-bench-chip ${firstWord.tone}`}>{firstWord.label}</span>
              <span className="hint">How long you wait before the reply starts.</span>
            </div>
            <div className="genai-bench-metric">
              <span className="genai-bench-label">Reply speed</span>
              <span className="genai-bench-number">{formatNumber(row.tpsMean)} <small>tokens/s</small></span>
              <span className={`genai-bench-chip ${speed.tone}`}>{speed.label}</span>
              <span className="hint">{wordsPerSecondText(row.tpsMean)}</span>
            </div>
          </div>
          {row.errors > 0 && <p className="hint">{runsText(row.errors)} of this model failed and {row.errors === 1 ? 'is' : 'are'} left out.</p>}
        </>
      )}
    </article>
  )
}
