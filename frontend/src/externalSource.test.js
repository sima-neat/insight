import assert from 'node:assert/strict'
import test from 'node:test'

import {
  codecWarningText, dimensionsText, externalChipText, formatBitrate, isExternal, liveFor,
  previewSrc, previewUrl, protocolLabel, readPreviewRate, readersText, writePreviewRate,
} from './externalSource.js'

const ext = { protocol: 'rtsp', address: '172.19.0.1', since: '2026-09-16T13:09:59Z', codec_supported: true, width: 640, height: 480, fps: 30, bitrate_bps: 1800000 }

test('isExternal only for the external state', () => {
  assert.equal(isExternal({ state: 'external' }), true)
  assert.equal(isExternal({ state: 'playing' }), false)
  assert.equal(isExternal(undefined), false)
})

test('chip text lists protocol, address and dimensions, omitting unknowns', () => {
  assert.equal(externalChipText(ext), '⇢ RTSP · 172.19.0.1 · 640×480 · 30 fps')
  assert.equal(externalChipText({ protocol: 'webrtc', address: null, width: null, height: null, fps: null }), '⇢ WebRTC')
  assert.equal(dimensionsText({ width: 1280, height: 720, fps: null }), '1280×720')
  assert.equal(dimensionsText({}), '')
})

test('protocol labels', () => {
  assert.equal(protocolLabel('srt'), 'SRT')
  assert.equal(protocolLabel('futureConn'), 'FUTURECONN')
  assert.equal(protocolLabel(undefined), '-')
})

test('codec warning only when unsupported', () => {
  assert.equal(codecWarningText(ext, 'H.264'), null)
  assert.match(codecWarningText({ codec_supported: false }, 'VP8'), /VP8 .*H\.264, H\.265 or MJPEG/)
})

test('preview rate persistence is safe and defaults to off', () => {
  const store = new Map()
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
  assert.equal(readPreviewRate(storage), 'off')
  writePreviewRate(storage, 'max')
  assert.equal(readPreviewRate(storage), 'max')
  // A rate stored by an older build (1 fps, 0.5 fps) is no longer offered.
  writePreviewRate(storage, '1')
  assert.equal(readPreviewRate(storage), 'off')
  writePreviewRate(storage, 'bogus')
  assert.equal(readPreviewRate(storage), 'off')
  assert.equal(readPreviewRate({ getItem() { throw new Error('blocked') } }), 'off')
  assert.doesNotThrow(() => writePreviewRate({ setItem() { throw new Error('blocked') } }, '5'))
})

test('preview url', () => {
  assert.equal(previewUrl(2, 'max'), '/stream/preview/src2.mjpg?fps=max')
  assert.equal(previewUrl(2, '5'), '/stream/preview/src2.mjpg?fps=5')
  assert.equal(previewUrl(2, 'off'), null)
})

test('preview src carries a remount token', () => {
  assert.equal(previewSrc(2, 'max', 1737000000000), '/stream/preview/src2.mjpg?fps=max&t=1737000000000')
  assert.equal(previewSrc(2, 'off', 1737000000000), null)
})

test('live-for, bitrate and readers formatting', () => {
  const t0 = Date.parse('2026-09-16T13:09:59Z')
  assert.equal(liveFor('2026-09-16T13:09:59Z', t0 + 724000), '12m 04s')
  assert.equal(liveFor('2026-09-16T13:09:59Z', t0 + 3720000), '1h 02m')
  assert.equal(liveFor(null, t0), '-')
  assert.equal(formatBitrate(1800000), '1.8 Mbit/s')
  assert.equal(formatBitrate(850000), '850 kbit/s')
  assert.equal(formatBitrate(null), '-')
  assert.equal(readersText([{ protocol: 'rtsp', address: '10.42.0.79' }, { protocol: 'rtsp', address: '127.0.0.1', label: 'insight preview' }]), '2 · 10.42.0.79, insight preview')
  assert.equal(readersText([]), '0')
})
