import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NEAT_MIN_TILE_WIDTH } from '@sima/neat-ui';
import { FakeLocalStorage } from './fake-storage.testing';
import { LayoutPrefs } from './layout-prefs';

describe('LayoutPrefs', () => {
  let fake: FakeLocalStorage;

  beforeEach(() => {
    fake = new FakeLocalStorage();
    vi.stubGlobal('localStorage', fake);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The Viewer's prefs, opened again as a page visit in the same browser session would. */
  const open = () => TestBed.runInInjectionContext(() => new LayoutPrefs());

  /** A new browser session on the same storage: what a page reload sees. */
  function reload(): LayoutPrefs {
    TestBed.resetTestingModule();
    return open();
  }

  it('starts with bars on, all channels and the inspector closed', () => {
    const prefs = open();

    expect(prefs.bars()).toBe(true);
    expect(prefs.hideEmpty()).toBe(false);
    expect(prefs.inspector()).toBe(false);
  });

  it('keeps every choice across a reload under one viewer key', () => {
    const prefs = open();
    prefs.setBars(false);
    prefs.setHideEmpty(true);
    prefs.setInspector(true);
    prefs.rememberTileWidth(16, 240);

    expect(fake.readStored('layout')).toStrictEqual({
      bars: false,
      hideEmpty: true,
      inspector: true,
      tileWidths: { 16: 240 },
    });
    const reloaded = reload();
    expect(reloaded.bars()).toBe(false);
    expect(reloaded.hideEmpty()).toBe(true);
    expect(reloaded.inspector()).toBe(true);
    expect(reloaded.tileWidthFor(16)).toBe(240);
  });

  it('tileWidthFor(count) returns what rememberTileWidth stored for that count and null otherwise', () => {
    const prefs = open();
    expect(prefs.tileWidthFor(16)).toBeNull();

    prefs.rememberTileWidth(16, 240);
    prefs.rememberTileWidth(4, 610.5);
    prefs.rememberTileWidth(16, 260);

    expect(prefs.tileWidthFor(16)).toBe(260);
    expect(prefs.tileWidthFor(4)).toBe(610.5);
    expect(prefs.tileWidthFor(9)).toBeNull();
    expect(reload().tileWidthFor(16)).toBe(260);
  });

  it("forgetTileWidth(count) drops only that count's width, across a reload too", () => {
    const prefs = open();
    prefs.rememberTileWidth(16, 240);
    prefs.rememberTileWidth(4, 500);
    const width = computed(() => prefs.tileWidthFor(16));
    expect(width()).toBe(240);

    prefs.forgetTileWidth(16);

    expect(width()).toBeNull();
    expect(prefs.tileWidthFor(4)).toBe(500);
    expect((fake.readStored('layout') as { tileWidths: object }).tileWidths).toStrictEqual({
      4: 500,
    });
    expect(reload().tileWidthFor(16)).toBeNull();
  });

  it('forgetting a width that is not stored writes nothing', () => {
    const prefs = open();
    prefs.forgetTileWidth(16);
    expect(fake.writes).toStrictEqual([]);
  });

  it('tileWidthFor is reactive, so a computed width follows rememberTileWidth', () => {
    const prefs = open();
    const width = computed(() => prefs.tileWidthFor(16));

    expect(width()).toBeNull();
    prefs.rememberTileWidth(16, 300);
    expect(width()).toBe(300);
  });

  it('drops stored widths that are not finite or below the kit minimum, and refuses to store them', () => {
    fake.seed({
      layout: {
        bars: 'yes',
        hideEmpty: 1,
        inspector: null,
        tileWidths: {
          1: 'big',
          2: NEAT_MIN_TILE_WIDTH - 1,
          3: NEAT_MIN_TILE_WIDTH,
          4: null,
          0: 300,
          x: 300,
          2.5: 300,
        },
      },
    });
    const prefs = open();

    expect(prefs.bars()).toBe(true);
    expect(prefs.hideEmpty()).toBe(false);
    expect(prefs.inspector()).toBe(false);
    expect([1, 2, 3, 4, 0].map((count) => prefs.tileWidthFor(count))).toStrictEqual([
      null,
      null,
      NEAT_MIN_TILE_WIDTH,
      null,
      null,
    ]);

    prefs.rememberTileWidth(8, Number.NaN);
    prefs.rememberTileWidth(8, Number.POSITIVE_INFINITY);
    prefs.rememberTileWidth(8, NEAT_MIN_TILE_WIDTH - 1);
    expect(prefs.tileWidthFor(8)).toBeNull();
  });

  it('a layout stored with aspect "1:1" keeps its other choices, and the next write stores no aspect', () => {
    // Plan 2a stored the tile shape; tiles are 16:9 now, so the choice is dropped on the next write.
    fake.seed({ layout: { aspect: '1:1', bars: false, tileWidths: { 4: 300 } } });
    const prefs = open();

    expect(prefs.bars()).toBe(false);
    expect(prefs.tileWidthFor(4)).toBe(300);
    expect(fake.writes).toStrictEqual([]);

    prefs.setInspector(true);

    expect(fake.readStored('layout')).toStrictEqual({
      bars: false,
      hideEmpty: false,
      inspector: true,
      tileWidths: { 4: 300 },
    });
  });

  it("two viewer tabs keep each other's choices: bars in one does not wipe widths from the other", () => {
    const first = open();
    const second = open();

    first.rememberTileWidth(16, 240);
    second.setBars(false);
    second.rememberTileWidth(4, 500);

    expect(fake.readStored('layout')).toStrictEqual({
      bars: false,
      hideEmpty: false,
      inspector: false,
      tileWidths: { 4: 500, 16: 240 },
    });
    expect(second.tileWidthFor(16)).toBe(240);
  });

  it('choosing what is already chosen writes nothing', () => {
    const prefs = open();
    prefs.setBars(true);
    prefs.setHideEmpty(false);
    prefs.setInspector(false);
    expect(fake.writes).toStrictEqual([]);

    prefs.rememberTileWidth(16, 240);
    prefs.rememberTileWidth(16, 240);
    expect(fake.writes).toHaveLength(1);
  });

  it('runs on defaults and keeps changes for the session when storage throws or holds garbage', () => {
    fake.seed({ layout: '{"bars":' });
    expect(open().bars()).toBe(true);

    fake.unavailable = true;
    const prefs = reload();
    expect(prefs.bars()).toBe(true);
    expect(() => prefs.setBars(false)).not.toThrow();
    expect(() => prefs.rememberTileWidth(16, 240)).not.toThrow();
    expect(prefs.bars()).toBe(false);
    expect(open().bars()).toBe(false);
    expect(open().tileWidthFor(16)).toBe(240);
  });
});
