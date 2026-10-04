import { useEffect, useReducer, useRef, useState } from 'react'
import { getMicrophoneTest, startMicrophoneTest, stopMicrophoneTest } from './api.js'
import {
  MIC_TEST_IDLE,
  apiError,
  availabilityInfo,
  captureModes,
  formatClock,
  micLevelNotice,
  micTestBlock,
  micTestAction,
  micTestErrorAction,
  meterSegments,
  microphoneRows,
  microphoneSubtitle,
  microphoneSummaryLine,
  nextMicTestState,
  normalizeError,
  segmentTone
} from './model.js'
import { ErrorNotice, Pill } from './ui.jsx'

export { microphoneSubtitle }

function CaptureModes({ modes }) {
  return (
    <fieldset className="periph-modes periph-capture">
      <legend>Capture</legend>
      {modes === null ? (
        <p className="hint">This device does not report its capture formats.</p>
      ) : !modes.length ? (
        <p className="hint">No capture formats listed.</p>
      ) : (
        modes.map((mode) => (
          <span key={mode.key} className="periph-capture-badges" role="group" aria-label={mode.badges.join(', ')}>
            {mode.badges.map((badge) => <span key={badge}>{badge}</span>)}
          </span>
        ))
      )}
    </fieldset>
  )
}

const METER_SEGMENTS = 28
const POLL_MS = 100

function LevelMeter({ level }) {
  const lit = meterSegments(level, METER_SEGMENTS)
  return (
    <span className="periph-meter" aria-hidden="true">
      {Array.from({ length: METER_SEGMENTS }, (_, index) => (
        <span key={index} className={index < lit ? `on ${segmentTone(index, METER_SEGMENTS)}` : undefined} />
      ))}
    </span>
  )
}

// Playback is routed through Web Audio so the meter can follow it. The context is created on the
// click that starts the test: browsers only let a page start audio from a user gesture.
function useAudioMeter() {
  const context = useRef(null)
  const analyser = useRef(null)
  const wired = useRef(null)

  const prepare = () => {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) return
    try {
      if (!context.current) context.current = new AudioContext()
      context.current.resume().catch(() => {})
    } catch {
      context.current = null
    }
  }

  // Only a running context may carry the audio: routed through a suspended one it would be silent.
  // Anything Web Audio refuses leaves the element playing on its own, without the meter.
  const attach = (audio) => {
    if (!context.current || context.current.state !== 'running' || !audio || wired.current === audio) return
    try {
      const source = context.current.createMediaElementSource(audio)
      const node = context.current.createAnalyser()
      node.fftSize = 1024
      source.connect(node)
      node.connect(context.current.destination)
      analyser.current = node
      wired.current = audio
    } catch {
      analyser.current = null
    }
  }

  const read = () => {
    if (!analyser.current) return null
    const samples = new Float32Array(analyser.current.fftSize)
    analyser.current.getFloatTimeDomainData(samples)
    const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    return peak > 0 ? 20 * Math.log10(peak) : null
  }

  useEffect(() => () => { context.current?.close().catch(() => {}) }, [])
  return { prepare, attach, read }
}

function MicTest({ mic }) {
  const [state, dispatch] = useReducer(nextMicTestState, MIC_TEST_IDLE)
  const [level, setLevel] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const [stopping, setStopping] = useState(false)
  const audioRef = useRef(null)
  const mounted = useRef(true)
  const meter = useAudioMeter()
  useEffect(() => () => { mounted.current = false }, [])

  const poll = async (token) => {
    let answer
    try {
      answer = (await getMicrophoneTest()).test
    } catch (err) {
      if (mounted.current) dispatch({ type: 'failed', error: normalizeError(err) })
      return
    }
    if (!mounted.current) return
    if (!answer || answer.token !== token) {
      dispatch({ type: 'failed', error: { message: 'The test ended before it finished.', hint: 'Test again.' } })
    } else if (answer.state === 'recording') {
      setLevel(answer.level_dbfs)
      setElapsed(answer.elapsed_ms)
      setTimeout(() => poll(token), POLL_MS)
    } else if (answer.state === 'ready') {
      dispatch({ type: 'recorded', test: answer })
    } else {
      dispatch({ type: 'failed', error: normalizeError(apiError(answer.error, 409)) })
    }
  }

  const record = async () => {
    meter.prepare()
    setLevel(null)
    setElapsed(0)
    setStopping(false)
    dispatch({ type: 'record' })
    try {
      const { test } = await startMicrophoneTest(mic.id)
      if (mounted.current) poll(test.token)
    } catch (err) {
      if (mounted.current) dispatch({ type: 'failed', error: normalizeError(err) })
    }
  }

  // Stop recording: the backend ends arecord and the poll picks the result up as usual.
  const stopRecording = async () => {
    setStopping(true)
    try {
      await stopMicrophoneTest()
    } catch (err) {
      if (mounted.current) dispatch({ type: 'failed', error: normalizeError(err) })
    }
  }

  const stopPlaying = () => {
    audioRef.current?.pause()
    dispatch({ type: 'played' })
  }

  const replay = () => {
    meter.prepare()
    dispatch({ type: 'replay' })
  }

  // Playing: start the recording from the top and let the meter follow it.
  useEffect(() => {
    if (state.status !== 'playing') return undefined
    const audio = audioRef.current
    if (!audio) return undefined
    meter.attach(audio)
    try {
      audio.currentTime = 0
    } catch {
      // Some browsers refuse a seek before the file has loaded; it then starts at 0 anyway.
    }
    audio.play().catch(() => dispatch({ type: 'played' }))
    let frame
    const tick = () => {
      setLevel(meter.read())
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      setLevel(null)
    }
  }, [state.status])

  const status = state.status
  const recording = status === 'recording'
  const playing = status === 'playing'
  const block = micTestBlock(mic, state)
  const notice = status === 'done' ? micLevelNotice(state.test?.level) : ''
  const button = micTestAction(status, stopping)
  const onButton = { record, stop: stopRecording, 'stop-playing': stopPlaying }[button.action]
  const caption = recording ? `Recording · ${formatClock(elapsed / 1000)}` : playing ? 'Recording playing' : ''

  return (
    <section className="periph-mic-test" aria-labelledby="periph-mic-test-title">
      <div className="periph-mic-test-head">
        <h4 id="periph-mic-test-title">Test Microphone</h4>
      </div>
      <p className="sr-only" role="status">
        {recording ? 'Recording. Speak now, then press Stop recording.' : playing ? 'Recording playing.' : ''}
      </p>

      <div className="periph-mic-row">
        <button
          type="button"
          className="btn-tonal periph-mic-button"
          onClick={onButton}
          disabled={button.disabled || (button.action === 'record' && Boolean(block))}
          aria-describedby={block ? 'periph-mic-test-block' : undefined}
        >
          {button.label}
        </button>
        <LevelMeter level={recording || playing ? level : null} />
        <span className="periph-mic-caption">
          {caption || (status === 'done' && (
            <button type="button" className="btn-ghost" onClick={replay}>Replay</button>
          ))}
        </span>
      </div>

      {block && <p className="hint" id="periph-mic-test-block">{block}</p>}
      {notice && <p className="hint periph-mic-warning" role="alert">{notice}</p>}
      {status === 'error' && <ErrorNotice error={{ ...state.error, hint: micTestErrorAction(state.error) }} />}

      {state.test?.audio_url && (
        <audio ref={audioRef} src={state.test.audio_url} preload="auto" onEnded={() => dispatch({ type: 'played' })} />
      )}
    </section>
  )
}

// Neat Core has no audio input node, so there is no mode to pick and nothing to export: the pane
// shows what the board reports, whether a process holds the device, and a recording to listen to.
export default function MicrophoneDetail({ mic }) {
  const availability = availabilityInfo(mic.availability)
  const summary = microphoneSummaryLine(mic)
  const subtitle = microphoneSubtitle(mic)

  return (
    <section className="periph-detail" aria-labelledby="periph-detail-title">
      <div className="periph-detail-head">
        <div>
          <h3 id="periph-detail-title">{mic.name}</h3>
          {subtitle && <p className="hint">{subtitle}</p>}
        </div>
        <span className="periph-pills">
          <Pill tone={availability.tone}>{availability.label}</Pill>
        </span>
      </div>

      {summary && <p className="periph-summary-line">{summary}</p>}

      {(mic.errors || []).map((error, index) => (
        <ErrorNotice key={`${error.code || 'error'}-${index}`} error={error} />
      ))}

      <details className="periph-identity">
        <summary>Device details</summary>
        <table className="sysinfo-table key-value">
          <tbody>
            {microphoneRows(mic).map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {mic.notes?.length > 0 && (
          <ul className="periph-notes">
            {mic.notes.map((note, index) => <li key={index}>{note}</li>)}
          </ul>
        )}
      </details>

      <CaptureModes modes={captureModes(mic)} />
      <MicTest key={mic.id} mic={mic} />
    </section>
  )
}
