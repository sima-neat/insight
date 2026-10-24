import { createPlaybackLevel } from './playback-level';

/** An `AudioNode` that records what it is connected to. */
class FakeNode {
  readonly connected: unknown[] = [];
  connect(destination: unknown): void {
    this.connected.push(destination);
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  /** What the analyser hears now, repeated over its window. */
  signal: (index: number) => number = () => 0;
  getFloatTimeDomainData(target: Float32Array): void {
    for (let index = 0; index < target.length; index++) target[index] = this.signal(index);
  }
}

/** Web Audio's `AudioContext` as far as the playback level uses it, under the test's control. */
class FakeAudioContext extends EventTarget {
  static made: FakeAudioContext[] = [];
  static refuseSource = false;
  static startSuspended = false;

  state: AudioContextState = FakeAudioContext.startSuspended ? 'suspended' : 'running';
  readonly destination = new FakeNode();
  readonly sources: { element: HTMLMediaElement; node: FakeNode }[] = [];
  readonly analysers: FakeAnalyser[] = [];
  readonly close = vi.fn(async () => this.setState('closed'));
  readonly resume = vi.fn(async () => undefined);

  constructor() {
    super();
    FakeAudioContext.made.push(this);
  }

  createMediaElementSource(element: HTMLMediaElement): FakeNode {
    if (FakeAudioContext.refuseSource)
      throw new DOMException('Already connected', 'InvalidStateError');
    const node = new FakeNode();
    this.sources.push({ element, node });
    return node;
  }

  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }

  setState(state: AudioContextState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

describe('createPlaybackLevel', () => {
  let audio: HTMLAudioElement;

  beforeEach(() => {
    FakeAudioContext.made = [];
    FakeAudioContext.refuseSource = false;
    FakeAudioContext.startSuspended = false;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    audio = document.createElement('audio');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('createPlaybackLevel reads peak dBFS from the analyser and closes its context', () => {
    const level = createPlaybackLevel(audio);
    const [context] = FakeAudioContext.made;
    // The element plays through an analyser to the speakers.
    expect(context.sources.map((source) => source.element)).toEqual([audio]);
    const [analyser] = context.analysers;
    expect(context.sources[0].node.connected).toEqual([analyser]);
    expect(analyser.connected).toEqual([context.destination]);

    // Silence has no level: the meter is dark.
    expect(level.read()).toBeNull();
    // A constant half scale is -6 dBFS; a full-scale square wave is 0 dBFS.
    analyser.signal = () => 0.5;
    expect(level.read()).toBeCloseTo(20 * Math.log10(0.5), 6);
    analyser.signal = (index) => (index % 2 ? 1 : -1);
    expect(level.read()).toBeCloseTo(0, 6);
    // The peak, not the RMS (ruling Q19): a full-scale sine reads 0 dBFS, not -3.
    analyser.signal = (index) => Math.sin((2 * Math.PI * index) / 64);
    expect(level.read()).toBeCloseTo(0, 6);
    // A negative peak counts as much as a positive one: -0.25 is -12 dBFS.
    analyser.signal = (index) => (index === 100 ? -0.25 : 0.1);
    expect(level.read()).toBeCloseTo(20 * Math.log10(0.25), 6);

    level.close();
    level.close();
    expect(context.close).toHaveBeenCalledTimes(1);
    // A closed level reads nothing rather than throw: the meter keeps calling until told to stop.
    expect(level.read()).toBeNull();
  });

  it('a suspended context carries the audio only once it runs', () => {
    FakeAudioContext.startSuspended = true;
    const level = createPlaybackLevel(audio);
    const [context] = FakeAudioContext.made;
    // Asked to run while the click's gesture lasts; routed through it now, the audio would be silent.
    expect(context.resume).toHaveBeenCalled();
    expect(context.sources).toEqual([]);
    expect(level.read()).toBeNull();

    context.setState('running');
    expect(context.sources.map((source) => source.element)).toEqual([audio]);
    context.analysers[0].signal = () => 0.5;
    expect(level.read()).toBeCloseTo(20 * Math.log10(0.5), 6);
    // Wired once: a media element takes one source node only.
    context.setState('suspended');
    context.setState('running');
    expect(context.sources.length).toBe(1);
  });

  it('what Web Audio refuses leaves the element playing on its own, without a level', () => {
    FakeAudioContext.refuseSource = true;
    const refused = createPlaybackLevel(audio);
    expect(refused.read()).toBeNull();
    refused.close();
    expect(FakeAudioContext.made[0].close).toHaveBeenCalledTimes(1);

    // A browser without Web Audio (and jsdom) gets a level that reads nothing.
    vi.stubGlobal('AudioContext', undefined);
    const none = createPlaybackLevel(audio);
    expect(none.read()).toBeNull();
    expect(() => none.close()).not.toThrow();

    // Nor does a context the browser will not make (too many open) fail the click.
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new DOMException('Too many contexts', 'NotSupportedError');
        }
      },
    );
    const failed = createPlaybackLevel(audio);
    expect(failed.read()).toBeNull();
  });
});
