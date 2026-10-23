import { TestBed } from '@angular/core/testing';
import type { NeatRoiPolygon } from '@sima/neat-ui/video';
import { FakeLocalStorage } from './fake-storage.testing';
import { RoiStore } from './roi-store';

type Failures = Partial<Pick<FakeLocalStorage, 'failWrites' | 'unavailable'>>;

let fake: FakeLocalStorage;

const SQUARE: NeatRoiPolygon = {
  type: 'inclusion',
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.9 },
    { x: 0.1, y: 0.9 },
  ],
};
const TRIANGLE: NeatRoiPolygon = {
  type: 'exclusion',
  points: [
    { x: 0.2, y: 0.2 },
    { x: 0.4, y: 0.2 },
    { x: 0.3, y: 0.4 },
  ],
};

/** The stored form of a list, as the store writes it. */
const stored = (regions: readonly NeatRoiPolygon[]) => ({ version: 1, regions });

/** A new browser session on storage holding `entries` (names without the viewer prefix). */
function load(entries: Record<string, unknown> = {}, failures: Failures = {}): RoiStore {
  fake = new FakeLocalStorage();
  fake.seed(entries);
  Object.assign(fake, failures);
  vi.stubGlobal('localStorage', fake);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [RoiStore] });
  return TestBed.inject(RoiStore);
}

function points(count: number): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, index) => ({ x: index / count, y: 0.5 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RoiStore', () => {
  it('own() is null for a scope with nothing stored and [] for an explicit empty list', () => {
    const store = load({ 'roi:channel:2': stored([]) });

    expect(store.own('global')()).toBeNull();
    expect(store.own(1)()).toBeNull();
    expect(store.own(2)()).toStrictEqual([]);
  });

  it('effective(n) is the channel list, else the global list, else []', () => {
    const store = load({ 'roi:global': stored([SQUARE]), 'roi:channel:2': stored([TRIANGLE]) });

    expect(store.effective(2)()).toStrictEqual([TRIANGLE]);
    expect(store.effective(1)()).toStrictEqual([SQUARE]);
    expect(load().effective(1)()).toStrictEqual([]);
  });

  it('effective(n) keeps a channel list that is empty: no regions here, whatever global has', () => {
    const store = load({ 'roi:global': stored([SQUARE]), 'roi:channel:2': stored([]) });

    expect(store.effective(2)()).toStrictEqual([]);
  });

  it('effective(n) follows later writes to the channel and to global', () => {
    const store = load();
    const effective = store.effective(1);

    store.set('global', [SQUARE]);
    expect(effective()).toStrictEqual([SQUARE]);

    store.set(1, [TRIANGLE]);
    expect(effective()).toStrictEqual([TRIANGLE]);

    store.useGlobal(1);
    expect(effective()).toStrictEqual([SQUARE]);
  });

  it('editable(channel) starts from the global list for a channel that inherits', () => {
    const store = load({ 'roi:global': stored([SQUARE]), 'roi:channel:2': stored([TRIANGLE]) });

    expect(store.editable(1)()).toStrictEqual([SQUARE]);
    expect(store.editable(2)()).toStrictEqual([TRIANGLE]);
    expect(store.editable('global')()).toStrictEqual([SQUARE]);
    expect(load().editable('global')()).toStrictEqual([]);
    // Global's own list is what a global edit starts from, not the channels'.
    expect(load({ 'roi:channel:2': stored([TRIANGLE]) }).editable('global')()).toStrictEqual([]);
  });

  it('set and useGlobal write and remove roi:channel:<n>, and channelsWithOwn follows', () => {
    const store = load();
    const owners = store.channelsWithOwn();
    expect(owners()).toStrictEqual([]);

    store.set(3, [SQUARE]);
    store.set(1, []);
    expect(fake.readStored('roi:channel:3')).toStrictEqual(stored([SQUARE]));
    expect(fake.readStored('roi:channel:1')).toStrictEqual(stored([]));
    expect(owners()).toStrictEqual([1, 3]);
    expect(store.own(3)()).toStrictEqual([SQUARE]);

    store.useGlobal(3);
    expect(fake.readRaw('roi:channel:3')).toBeNull();
    expect(fake.readRaw('roi:channel:1')).not.toBeNull();
    expect(store.own(3)()).toBeNull();
    expect(owners()).toStrictEqual([1]);

    store.set('global', [TRIANGLE]);
    expect(fake.readStored('roi:global')).toStrictEqual(stored([TRIANGLE]));
    expect(owners()).toStrictEqual([1]);
  });

  it('opens with the channels that store a list, ascending, and ignores other names', () => {
    const store = load({
      'roi:channel:10': stored([SQUARE]),
      'roi:channel:2': stored([]),
      'roi:channel:x': stored([SQUARE]),
      'roi:channel:4': 'not json',
      'settings:channel:7': { version: 10 },
    });

    expect(store.channelsWithOwn()()).toStrictEqual([2, 10]);
  });

  describe('after another tab stores a channel list', () => {
    // The fake storage stands for the other tab: its write reaches storage, not this store.
    it('the next write picks it up: own, effective, the owners and useGlobal agree', () => {
      const store = load({ 'roi:global': stored([SQUARE]) });
      expect(store.effective(3)()).toStrictEqual([SQUARE]);
      fake.seed({ 'roi:channel:3': stored([TRIANGLE]) });

      store.set(1, [SQUARE]);

      expect(store.channelsWithOwn()()).toStrictEqual([1, 3]);
      expect(store.own(3)()).toStrictEqual([TRIANGLE]);
      expect(store.effective(3)()).toStrictEqual([TRIANGLE]);

      store.useGlobal(3);
      expect(fake.readRaw('roi:channel:3')).toBeNull();
      expect(store.own(3)()).toBeNull();
      expect(store.effective(3)()).toStrictEqual([SQUARE]);
      expect(store.channelsWithOwn()()).toStrictEqual([1]);
    });

    it('useGlobal removes it even before this store has seen it', () => {
      const store = load();
      store.own(3);
      fake.seed({ 'roi:channel:3': stored([TRIANGLE]) });

      store.useGlobal(3);

      expect(fake.readRaw('roi:channel:3')).toBeNull();
      expect(store.channelsWithOwn()()).toStrictEqual([]);
      expect(load({ 'roi:channel:3': 'x' }).channelsWithOwn()()).toStrictEqual([]);
    });

    it('keeps the lists it holds, so a write to one channel does not re-resolve the others', () => {
      const store = load({ 'roi:channel:2': stored([SQUARE]) });
      const held = store.own(2)();
      fake.seed({ 'roi:channel:2': stored([TRIANGLE]) });

      store.set(1, []);

      expect(store.own(2)()).toBe(held);
    });
  });

  it("ignores a channel name with leading zeros, which is not any channel's name", () => {
    const store = load({ 'roi:channel:007': stored([SQUARE]), 'roi:channel:7': stored([]) });

    expect(store.own(7)()).toStrictEqual([]);
    expect(store.channelsWithOwn()()).toStrictEqual([7]);
    store.set(1, []);
    expect(store.channelsWithOwn()()).toStrictEqual([1, 7]);
  });

  it('useGlobal on a channel without a list writes nothing', () => {
    const store = load();

    store.useGlobal(5);

    expect(fake.writes).toStrictEqual([]);
  });

  it('writes the whole list, replacing the previous one, and nothing else', () => {
    const store = load({ 'roi:global': stored([SQUARE]) });

    store.set('global', [TRIANGLE, SQUARE]);

    expect(fake.readStored('roi:global')).toStrictEqual(stored([TRIANGLE, SQUARE]));
    expect(fake.writes).toStrictEqual([{ op: 'set', key: 'neat-insight:viewer:roi:global' }]);
  });

  describe('reading what is stored', () => {
    it('drops non-JSON, wrong shapes and unknown types; clamps coordinates; drops regions under 3 points', () => {
      const store = load({
        'roi:global': 'not json',
        'roi:channel:1': { version: 2, regions: [SQUARE] },
        'roi:channel:2': { version: 1 },
        'roi:channel:3': { version: 1, regions: 'square' },
        'roi:channel:4': [SQUARE],
        'roi:channel:5': 'null',
        'roi:channel:6': {
          version: 1,
          regions: [
            SQUARE,
            { type: 'diagonal', points: TRIANGLE.points },
            { type: 'inclusion', points: TRIANGLE.points.slice(0, 2) },
            { type: 'exclusion' },
            'region',
            null,
            {
              type: 'exclusion',
              points: [
                { x: -0.5, y: 0.5 },
                { x: 1.5, y: 0.5 },
                { x: 0.5, y: 2 },
                { x: Number.NaN, y: 0.5 },
                { x: '0.5', y: 0.5 },
                { x: 0.5 },
                null,
                { x: 0.25, y: 0.75, extra: true },
              ],
            },
          ],
        },
      });

      for (const scope of ['global', 1, 2, 3, 4, 5] as const) {
        expect(store.own(scope)()).toBeNull();
      }
      expect(store.own(6)()).toStrictEqual([
        SQUARE,
        {
          type: 'exclusion',
          points: [
            { x: 0, y: 0.5 },
            { x: 1, y: 0.5 },
            { x: 0.5, y: 1 },
            { x: 0.25, y: 0.75 },
          ],
        },
      ]);
    });

    it('drops a point with an infinite coordinate instead of storing it', () => {
      const store = load();
      store.set('global', [
        {
          type: 'inclusion',
          points: [...TRIANGLE.points, { x: Number.POSITIVE_INFINITY, y: 0.5 }],
        },
      ]);

      expect(store.own('global')()).toStrictEqual([{ type: 'inclusion', points: TRIANGLE.points }]);
    });

    it('counts the points left after dropping invalid ones against the minimum', () => {
      const store = load({
        // JSON stores NaN as null and 1e999 as Infinity, which reads back as one.
        'roi:global': `{"version":1,"regions":[{"type":"inclusion","points":[{"x":0.1,"y":0.1},{"x":0.9,"y":0.1},{"x":1e999,"y":0.5}]}]}`,
      });

      expect(store.own('global')()).toStrictEqual([]);
    });

    it('does not count invalid points against the cap of 256', () => {
      const invalid = Array.from({ length: 100 }, () => ({ x: null, y: 0.5 }));
      const store = load({
        'roi:global': stored([
          { type: 'inclusion', points: [...invalid, ...points(256)] },
        ] as unknown as NeatRoiPolygon[]),
      });

      expect(store.own('global')()![0].points).toStrictEqual(points(256));
    });

    it('keeps at most 64 regions of at most 256 points', () => {
      const store = load({
        'roi:global': stored(
          Array.from({ length: 70 }, () => ({ type: 'inclusion', points: points(300) })),
        ),
      });

      const regions = store.own('global')()!;
      expect(regions).toHaveLength(64);
      expect(regions.every((region) => region.points.length === 256)).toBe(true);
    });

    it('counts only valid points and regions against the caps', () => {
      const invalid = { type: 'inclusion', points: [{ x: 0, y: 0 }] };
      const store = load({
        'roi:global': stored([
          ...Array.from({ length: 100 }, () => invalid),
          ...Array.from({ length: 64 }, () => SQUARE),
        ] as NeatRoiPolygon[]),
      });

      expect(store.own('global')()).toHaveLength(64);
    });
  });

  describe('writing', () => {
    it('stores a list the way it would be read back: clamped, capped, without short regions', () => {
      const store = load();

      store.set(1, [
        { type: 'inclusion', points: points(300) },
        { type: 'exclusion', points: TRIANGLE.points.slice(0, 2) },
        {
          type: 'exclusion',
          points: [
            { x: -1, y: 2 },
            { x: 0.5, y: 0.5 },
            { x: 0.7, y: 0.5 },
          ],
        },
      ]);

      const held = store.own(1)()!;
      expect(held.map((region) => region.points.length)).toStrictEqual([256, 3]);
      expect(held[1].points[0]).toStrictEqual({ x: 0, y: 1 });
      const reloaded = load(
        Object.fromEntries([['roi:channel:1', fake.readStored('roi:channel:1')]]),
      );
      expect(reloaded.own(1)()).toStrictEqual(held);
    });
  });

  describe('when storage fails', () => {
    it('runs on [] when storage is unavailable', () => {
      const store = load({}, { unavailable: true });

      expect(store.effective(1)()).toStrictEqual([]);
      expect(store.channelsWithOwn()()).toStrictEqual([]);
    });

    it('keeps changes for the session when storage throws', () => {
      const store = load({}, { unavailable: true });

      store.set('global', [SQUARE]);
      store.set(2, [TRIANGLE]);

      expect(store.effective(1)()).toStrictEqual([SQUARE]);
      expect(store.effective(2)()).toStrictEqual([TRIANGLE]);
      expect(store.channelsWithOwn()()).toStrictEqual([2]);

      // The session copy outlives the store: the Viewer page makes a new one on each visit.
      const next = TestBed.runInInjectionContext(() => new RoiStore());
      expect(next.effective(1)()).toStrictEqual([SQUARE]);
      expect(next.channelsWithOwn()()).toStrictEqual([2]);

      store.useGlobal(2);
      expect(store.channelsWithOwn()()).toStrictEqual([]);
      expect(TestBed.runInInjectionContext(() => new RoiStore()).own(2)()).toBeNull();
    });

    it('keeps changes for the session when a write is refused', () => {
      const store = load({}, { failWrites: true });

      store.set(1, [SQUARE]);

      expect(store.effective(1)()).toStrictEqual([SQUARE]);
      expect(store.channelsWithOwn()()).toStrictEqual([1]);
    });
  });
});
