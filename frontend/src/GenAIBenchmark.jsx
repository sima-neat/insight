import { useEffect, useRef, useState } from 'react'
import { chatModels, friendlyModelName } from './genai/backendState.js'
import {
  BENCH_LIMITS,
  benchProgress,
  benchmarkCsv,
  benchmarkFilename,
  benchmarkJson,
  benchmarkRequest,
  comparisonRows,
  formatNumber
} from './genai/benchmark.js'
import { getJson, postJson } from './genai/client.js'
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
// the board names, as a board that keeps one does on its own.
// ticket: the tab's board session (genai/boardSession.js); leaving the tab or
// changing boards ends the run. onRunningChange tells the tab's rule table.
export default function GenAIBenchmark({ status, ticket, onClose, onModelsChanged, onRunningChange }) {
  const models = chatModels(status)
  const loaded = new Set((status && status.loaded) || [])
  const [chosen, setChosen] = useState(() => models.filter((m) => loaded.has(m.name)).map((m) => m.name).slice(0, 1))
  const [runs, setRuns] = useState(String(BENCH_LIMITS.runs.default))
  const [maxTokens, setMaxTokens] = useState(String(BENCH_LIMITS.maxTokens.default))
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState('')          // what is happening now, in words
  const [live, setLive] = useState(null)          // latest /benchmark/status
  const [results, setResults] = useState([])      // [{model, summary, runs, failed}]
  const [note, setNote] = useState('')
  const stopRequested = useRef(false)
  // The settings the shown results were measured with, fixed when the run
  // starts: the inputs can change afterwards, the record must not.
  const [runConfig, setRunConfig] = useState(null)
  // The run's ticket: when it is no longer live (the tab closed, the board
  // changed), the loop ends and nothing more is shown.
  const runTicket = useRef(null)
  const over = () => stopRequested.current || !runTicket.current || !runTicket.current.live()

  // Closing the panel or leaving the tab mid-run stops the board's benchmark too.
  useEffect(() => () => {
    if (runTicket.current && !stopRequested.current) {
      stopRequested.current = true
      postJson('benchmark/stop', {}).catch(() => {})
    }
  }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, onClose])

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
    setPhase(`Benchmarking ${friendlyModelName(model)}`)
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

  async function run() {
    if (!chosen.length || running) return
    stopRequested.current = false
    runTicket.current = ticket()
    runLoaded.current = new Set((status && status.loaded) || [])
    setRunConfig({ runs, maxTokens, prompt })
    setRunning(true)
    onRunningChange?.(true)
    setResults([])
    setNote('')
    const done = []
    for (const model of chosen) {
      if (over()) break
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

  return (
    <div className="genai-bench" role="dialog" aria-modal="true" aria-label="Benchmark">
      <div className="genai-bench-top">
        <h2>Benchmark</h2>
        <p>Time to first token and tokens per second on the board's accelerator.</p>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={running} title={running ? 'Stop the benchmark first' : 'Close (Esc)'}>Close</button>
      </div>

      <div className="genai-bench-body">
        <section className="genai-bench-config" aria-label="Benchmark settings">
          <fieldset className="genai-bench-models" disabled={running}>
            <legend>Models</legend>
            {models.length === 0 && <p className="hint">No chat models on the board. Download one in Settings.</p>}
            {models.map((m) => (
              <label key={m.name} title={m.name}>
                <input type="checkbox" checked={chosen.includes(m.name)} onChange={() => toggle(m.name)} />
                {friendlyModelName(m.name)}
                <span className="hint">{loaded.has(m.name) ? 'loaded' : 'loads first'}</span>
              </label>
            ))}
          </fieldset>
          <label className="genai-bench-field">
            <span>Runs</span>
            <input type="number" min={BENCH_LIMITS.runs.min} max={BENCH_LIMITS.runs.max} value={runs} onChange={(e) => setRuns(e.target.value)} disabled={running} />
          </label>
          <label className="genai-bench-field">
            <span>Output tokens</span>
            <input type="number" min={BENCH_LIMITS.maxTokens.min} max={BENCH_LIMITS.maxTokens.max} step="8" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} disabled={running} />
          </label>
          <label className="genai-bench-field genai-bench-prompt">
            <span>Prompt (optional)</span>
            <input type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Leave blank for the default benchmark prompt" disabled={running} />
          </label>
          {running ? (
            <button type="button" className="btn-ghost danger" onClick={stop}>Stop</button>
          ) : (
            <button type="button" className="btn-tonal" onClick={run} disabled={!chosen.length}>
              {chosen.length > 1 ? `Run benchmark · ${chosen.length} models` : 'Run benchmark'}
            </button>
          )}
          {chosen.some((name) => !loaded.has(name)) && !running && (
            <p className="hint genai-bench-wide">Models that aren't loaded are loaded first, which can unload the chat model; reload it from the Model menu afterwards.</p>
          )}
        </section>

        {(running || live) && (
          <section className="genai-bench-live" aria-live="polite">
            {phase && <p className="genai-bench-phase">{phase}</p>}
            {live && live.total > 0 && (
              <div className="genai-progress" role="progressbar" aria-label="Benchmark progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.pct ?? undefined}>
                <div className="genai-progress-fill" style={{ width: `${progress.pct || 0}%` }} />
              </div>
            )}
            {progress.text && <p className="hint">{progress.text}</p>}
            {running && live && live.current && live.current.text && <pre className="genai-bench-text">{live.current.text}</pre>}
          </section>
        )}

        {note && <p className="hint">{note}</p>}

        {rows.length > 0 && (
          <section className="genai-bench-results" aria-label="Results">
            <div className="genai-bench-results-head">
              <h3>Results</h3>
              <span className="genai-header-spacer" />
              <button type="button" className="btn-ghost genai-small" disabled={running || !exportable} onClick={() => download(benchmarkFilename('csv'), benchmarkCsv(results), 'text/csv')}>Download CSV</button>
              <button type="button" className="btn-ghost genai-small" disabled={running || !exportable} onClick={() => download(benchmarkFilename('json'), benchmarkJson(results, runConfig), 'application/json')}>Download JSON</button>
            </div>
            <div className="genai-bench-bars" aria-label="Tokens per second, mean (higher is better)">
              {rows.filter((r) => !r.failed).map((r) => {
                const top = Math.max(...rows.filter((x) => !x.failed).map((x) => x.tpsMean), 1)
                return (
                  <div key={r.model} className="genai-bench-bar">
                    <span title={r.model}>{friendlyModelName(r.model)}</span>
                    <div className="genai-bench-track"><div className={r.bestTps ? 'best' : ''} style={{ width: `${Math.max(2, (r.tpsMean / top) * 100)}%` }} /></div>
                    <span>{formatNumber(r.tpsMean)} tokens/s</span>
                  </div>
                )
              })}
            </div>
            <table className="genai-bench-table">
              <thead>
                <tr><th>Model</th><th>Tokens/s mean</th><th>Tokens/s p90</th><th>First token mean</th><th>Tokens mean</th><th>σ tokens/s</th><th>Runs</th></tr>
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
                        <td className={r.bestTtft ? 'genai-bench-best' : ''}>{formatNumber(r.ttftMean, 0)} ms</td>
                        <td>{formatNumber(r.tokensMean, 0)}</td>
                        <td>{formatNumber(r.tpsStdev, 2)}</td>
                        <td>{r.runs}{r.errors ? ` · ${r.errors} failed` : ''}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {last && last.runs && last.runs.length > 0 && (
              <details className="genai-bench-runs">
                <summary>Each run of {friendlyModelName(last.model)}</summary>
                <table className="genai-bench-table">
                  <thead><tr><th>#</th><th>First token</th><th>Tokens/s</th><th>Tokens</th></tr></thead>
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
                {last.prompt && <p className="hint">Prompt: {last.prompt}</p>}
              </details>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
