import { useEffect, useRef, useState } from 'react'

import { getMicrophoneTest, startMicrophoneTest, stopMicrophoneTest } from './api.js'
import { microphoneAvailability, microphoneModeLabel, normalizeError } from './model.js'
import { Callout, ErrorNotice, Pill } from './ui.jsx'

const POLL_MS = 100
const METER_SEGMENTS = 28
const METER_FLOOR_DBFS = -50

function LevelMeter({ level }) {
  const lit = Number.isFinite(level)
    ? Math.round(Math.max(0, Math.min(1, 1 - level / METER_FLOOR_DBFS)) * METER_SEGMENTS)
    : 0
  return (
    <span className="periph-meter" aria-hidden="true">
      {Array.from({ length: METER_SEGMENTS }, (_, index) => {
        const tone = index < 20 ? 'low' : index < 25 ? 'mid' : 'high'
        return <span key={index} className={index < lit ? `on ${tone}` : undefined} />
      })}
    </span>
  )
}

function usePlaybackMeter() {
  const context = useRef(null)
  const analyser = useRef(null)
  const wired = useRef(null)

  function prepare() {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) return
    try {
      if (!context.current) context.current = new AudioContext()
      context.current.resume().catch(() => {})
    } catch {
      context.current = null
    }
  }

  function attach(audio) {
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

  function read() {
    if (!analyser.current) return null
    const samples = new Float32Array(analyser.current.fftSize)
    analyser.current.getFloatTimeDomainData(samples)
    const peak = samples.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0)
    return peak > 0 ? 20 * Math.log10(peak) : null
  }

  useEffect(() => () => { context.current?.close().catch(() => {}) }, [])
  return { prepare, attach, read }
}

function MicrophoneTest({ device, catalog }) {
  const [test, setTest] = useState(null)
  const [error, setError] = useState(null)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [played, setPlayed] = useState(false)
  const [playbackLevel, setPlaybackLevel] = useState(null)
  const mounted = useRef(true)
  const activeToken = useRef(null)
  const recording = useRef(false)
  const audioRef = useRef(null)
  const meter = usePlaybackMeter()
  const availability = microphoneAvailability(device.microphone)
  const hasCaptureTarget = Boolean(device.microphone.capture_target?.selector)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (recording.current && activeToken.current) {
        stopMicrophoneTest(activeToken.current).catch(() => {})
      }
    }
  }, [])

  async function poll(token) {
    while (mounted.current && activeToken.current === token) {
      const answer = (await getMicrophoneTest(token)).test
      if (!mounted.current || activeToken.current !== token) return
      setTest(answer)
      recording.current = answer.state === 'recording'
      if (answer.state === 'failed') {
        setError(normalizeError(answer.error))
        return
      }
      if (answer.state === 'ready') return
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  async function start() {
    meter.prepare()
    audioRef.current?.pause()
    activeToken.current = null
    recording.current = false
    setTest(null)
    setStarting(true)
    setStopping(false)
    setPlaying(false)
    setPlayed(false)
    setPlaybackLevel(null)
    setError(null)
    try {
      const answer = await startMicrophoneTest({
        board_generation: catalog.board_generation,
        instance_id: catalog.instance_id,
        revision: catalog.revision,
        device_id: device.id
      })
      const next = answer.test
      if (!mounted.current) {
        stopMicrophoneTest(next.token).catch(() => {})
        return
      }
      activeToken.current = next.token
      recording.current = true
      setTest(next)
      await poll(next.token)
    } catch (nextError) {
      if (mounted.current) setError(normalizeError(nextError))
    } finally {
      if (mounted.current) setStarting(false)
    }
  }

  async function stop() {
    if (!activeToken.current) return
    setStopping(true)
    setError(null)
    try {
      const answer = await stopMicrophoneTest(activeToken.current)
      if (mounted.current) setTest(answer.test)
    } catch (nextError) {
      if (mounted.current) setError(normalizeError(nextError))
    } finally {
      if (mounted.current) setStopping(false)
    }
  }

  function play() {
    meter.prepare()
    const audio = audioRef.current
    if (!audio) return
    meter.attach(audio)
    try { audio.currentTime = 0 } catch {}
    audio.play().then(
      () => setPlaying(true),
      (nextError) => {
        setPlaying(false)
        setPlaybackLevel(null)
        setError(normalizeError(nextError))
      }
    )
  }

  function stopPlayback() {
    audioRef.current?.pause()
    setPlaying(false)
    setPlayed(true)
    setPlaybackLevel(null)
  }

  useEffect(() => {
    if (!playing) return undefined
    let frame
    const tick = () => {
      setPlaybackLevel(meter.read())
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  const isRecording = test?.state === 'recording'
  const isReady = test?.state === 'ready'
  const level = playing ? playbackLevel : isRecording ? test.level_dbfs : null
  const seconds = Math.floor((test?.elapsed_ms || 0) / 1000)
  return (
    <section className="periph-mic-test" aria-labelledby="periph-mic-test-title">
      <h4 id="periph-mic-test-title">Test microphone</h4>
      <p className="sr-only" role="status" aria-live="polite">
        {isRecording ? 'Recording. Speak now, then press Stop recording.' : playing ? 'Playing the microphone test recording.' : isReady ? 'Microphone test recording ready.' : ''}
      </p>
      <div className="periph-mic-row">
        {isRecording ? (
          <button type="button" className="btn-tonal" onClick={stop} disabled={stopping}>
            {stopping ? 'Stopping…' : 'Stop recording'}
          </button>
        ) : playing ? (
          <button type="button" className="btn-tonal" onClick={stopPlayback}>Stop playing</button>
        ) : (
          <button type="button" className="btn-tonal" onClick={start} disabled={starting || !availability.canTest || !hasCaptureTarget}>
            {starting ? 'Starting…' : 'Test microphone'}
          </button>
        )}
        <LevelMeter level={level} />
        <span className="periph-mic-caption">
          {isRecording && `Recording · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
          {playing && 'Playing recording'}
          {isReady && !playing && <button type="button" className="btn-ghost" onClick={play}>{played ? 'Replay' : 'Play recording'}</button>}
        </span>
      </div>
      {!availability.canTest && <p className="hint">Stop the application using this microphone before testing it.</p>}
      {!hasCaptureTarget && <p className="hint">The daemon did not report a safe capture selector for this device. Refresh after it finishes initializing.</p>}
      {isReady && test.level?.silent && <p className="periph-mic-warning" role="alert">Nothing was picked up. Check mute and gain, then test again.</p>}
      {error && <ErrorNotice error={error} />}
      {isReady && <audio ref={audioRef} src={test.audio_url} preload="auto" onEnded={() => { setPlaying(false); setPlayed(true); setPlaybackLevel(null) }} />}
    </section>
  )
}

function Identity({ microphone }) {
  const identity = microphone.identity || {}
  const usb = identity.usb || {}
  const rows = [
    ['Connection', microphone.connection],
    ['Backend', microphone.backend],
    ['Card', identity.card_name || identity.card_id],
    ['PCM', identity.pcm_name],
    ['Driver', identity.card_driver],
    ['Device node', identity.pcm_node],
    ['By-path link', identity.by_path],
    ['By-id link', identity.by_id],
    ['USB ID', usb.vendor_id && usb.product_id ? `${usb.vendor_id}:${usb.product_id}` : null],
    ['USB product', usb.product],
    ['USB serial', usb.serial],
    ['USB port', usb.bus_path]
  ].filter(([, value]) => value)
  if (!rows.length) return null
  return (
    <details className="periph-mic-identity">
      <summary>Device details</summary>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </details>
  )
}

export default function MicrophoneDetail({ device, catalog }) {
  const microphone = device.microphone
  const availability = microphoneAvailability(microphone)
  return (
    <>
      <dl className="periph-facts">
        <div><dt>Backend</dt><dd>{microphone.backend}</dd></div>
        <div><dt>Connection</dt><dd>{microphone.connection}</dd></div>
        <div><dt>Status</dt><dd><Pill tone={availability.tone}>{availability.label}</Pill></dd></div>
        <div><dt>Modes</dt><dd>{microphone.modes.length}</dd></div>
      </dl>
      <Identity microphone={microphone} />
      {(microphone.issues || []).map((issue, index) => (
        <Callout key={`${issue.code || 'microphone'}-${index}`} title={issue.code || 'Microphone detail unavailable'}>
          <p>{issue.reason}</p>
        </Callout>
      ))}
      <section className="periph-mic-modes" aria-label="Capture modes">
        <h4>Capture modes</h4>
        {microphone.modes.length ? (
          <ul>{microphone.modes.map((mode, index) => <li key={`${mode.interface}-${mode.altset}-${index}`}>{microphoneModeLabel(mode)}</li>)}</ul>
        ) : <p className="hint">This device did not report read-only capture modes.</p>}
      </section>
      <MicrophoneTest device={device} catalog={catalog} />
    </>
  )
}
