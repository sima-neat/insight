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

const POLL_MS = 500

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
// that isn't loaded is loaded first, which unloads others the board can't keep.
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

  async function waitForRun() {
    for (;;) {
      if (over()) return null
      let state = null
      try {
        state = await getJson('benchmark/status', { signal: runTicket.current.signal })
      } catch {
        state = null
      }
      if (over()) return null
      if (state) setLive(state)
      if (state && !state.running) return state
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  // What is loaded during a run: the tab's status at the start, then what this
  // run's own loads change (loading one model can unload the others).
  const runLoaded = useRef(new Set())

  async function benchmarkOne(model) {
    if (!runLoaded.current.has(model)) {
      setPhase(`Loading ${friendlyModelName(model)}: this takes a few minutes…`)
      try {
        await postJson('models/load', { name: model }, { signal: runTicket.current.signal })
        runLoaded.current = new Set([model])   // the other chat models may have been unloaded
        onModelsChanged?.()
      } catch (error) {
        if (over()) return null
        return { model, failed: `failed to load: ${error.message}` }
      }
    }
    if (over()) return null
    setPhase(`Benchmarking ${friendlyModelName(model)}`)
    try {
      const started = await postJson('benchmark/run', benchmarkRequest({ model, runs, maxTokens, prompt }), { signal: runTicket.current.signal })
      if (over()) {
        // Stop arrived while the run was starting, so the board's stop found
        // nothing to stop: stop the run that has now begun.
        if (stopRequested.current) postJson('benchmark/stop', {}).catch(() => {})
        return null
      }
      setLive(started)
    } catch (error) {
      if (over()) return null
      return { model, failed: error.message }
    }
    const final = await waitForRun()
    if (!final) return null
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
    }
    if (!runTicket.current.live()) return     // the tab closed or the board changed
    runTicket.current = null
    setPhase('')
    setRunning(false)
    onRunningChange?.(false)
    if (stopRequested.current) setNote('Benchmark stopped.')
    onModelsChanged?.()
  }

  async function stop() {
    stopRequested.current = true
    setPhase('Stopping…')
    try {
      await postJson('benchmark/stop', {}, { signal: runTicket.current ? runTicket.current.signal : undefined })
    } catch {
      // The board may have finished already; the loop stops either way.
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
