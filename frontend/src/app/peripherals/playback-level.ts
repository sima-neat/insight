/**
 * The level of the microphone test's playback, read from Web Audio for the panel's meter while
 * the recording plays (`NeatLevelMeter`'s `sample`). It is raw Web Audio, kept here with its own
 * tests and outside change detection (AGENTS.md): the meter reads it once per animation frame.
 *
 * The level is the peak of the latest samples, as #170's playback meter read it and as the
 * backend measures the live level while recording (`mictest.chunk_level`): recording and
 * playback then read on one scale (ruling Q19).
 */

export interface PlaybackLevel {
  /** The playback's peak level now, in dBFS; null for silence, or with no Web Audio to read. */
  read(): number | null;
  /** Closes the audio context. The element then plays on its own; `read` answers null. */
  close(): void;
}

/** Samples per read: about 21 ms at 48 kHz, a little more than one frame of the meter. */
const WINDOW = 1024;

/** A level for a page without Web Audio, or one the browser refused: the meter stays dark. */
const NO_LEVEL: PlaybackLevel = { read: () => null, close: () => undefined };

/**
 * Routes `audio` through an analyser on its way to the speakers, so its level can be read on
 * demand.
 *
 * - **Call it inside the click handler:** browsers let a page start an `AudioContext` only on a
 *   user gesture, and a context made elsewhere stays suspended.
 * - **Once per element:** a media element accepts one `MediaElementSourceNode` in its lifetime, so
 *   a second level over the same element would fail. Make one and keep it for every playback of
 *   that element (ruling F11); close it when the element goes.
 * - **Only a running context carries the audio:** routed through a suspended one, the element
 *   would play silently. So the element is wired only once the context runs; until then, and
 *   whenever Web Audio refuses, the element plays on its own and the level reads null.
 */
export function createPlaybackLevel(audio: HTMLAudioElement): PlaybackLevel {
  let context: AudioContext;
  try {
    if (typeof AudioContext === 'undefined') return NO_LEVEL;
    context = new AudioContext();
  } catch {
    return NO_LEVEL;
  }

  const samples = new Float32Array(WINDOW);
  let analyser: AnalyserNode | null = null;
  let refused = false;
  let closed = false;

  const wire = () => {
    if (closed || refused || analyser || context.state !== 'running') return;
    try {
      const source = context.createMediaElementSource(audio);
      const node = context.createAnalyser();
      node.fftSize = WINDOW;
      source.connect(node);
      node.connect(context.destination);
      analyser = node;
    } catch {
      refused = true;
    }
    context.removeEventListener('statechange', wire);
  };

  context.addEventListener('statechange', wire);
  // Asked while the gesture lasts; a context the browser started suspended runs once this lands.
  context.resume().catch(() => undefined);
  wire();

  return {
    read() {
      if (closed || !analyser) return null;
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      return peak > 0 ? 20 * Math.log10(peak) : null;
    },
    close() {
      if (closed) return;
      closed = true;
      context.removeEventListener('statechange', wire);
      context.close().catch(() => undefined);
    },
  };
}
