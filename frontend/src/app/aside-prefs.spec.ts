import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NeatViewport } from '@sima/neat-ui';
import { AsidePage, AsidePrefs } from './aside-prefs';
import { FakeLocalStorage } from './fake-storage.testing';

describe('AsidePrefs', () => {
  let storage: FakeLocalStorage;
  /** Whether the screen is narrow, as the kit reports it; the tests outside "narrow" run wide. */
  const narrow = signal(false);

  beforeEach(() => {
    narrow.set(false);
    storage = new FakeLocalStorage();
    vi.stubGlobal('localStorage', storage);
    TestBed.configureTestingModule({
      providers: [{ provide: NeatViewport, useValue: { narrow } }],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens every page’s side panel until it is closed, and remembers each page on its own', () => {
    const prefs = TestBed.inject(AsidePrefs);
    expect(prefs.open('streaming')).toBe(true);
    expect(prefs.open('media')).toBe(true);
    expect(prefs.open('peripherals')).toBe(true);

    prefs.setOpen('media', false);
    expect(prefs.open('media')).toBe(false);
    expect(prefs.open('streaming')).toBe(true);
    expect(storage.values.get('neat-insight:media:aside')).toBe('closed');
    expect(storage.values.has('neat-insight:streaming:aside')).toBe(false);

    prefs.setOpen('peripherals', false);
    expect(prefs.open('peripherals')).toBe(false);
    expect(prefs.open('media')).toBe(false);
    expect(storage.values.get('neat-insight:peripherals:aside')).toBe('closed');
  });

  it('remembers the Stats panel as neat-insight:stats:aside', () => {
    const prefs = TestBed.inject(AsidePrefs);
    expect(prefs.open('stats')).toBe(true);
    prefs.setOpen('stats', false);
    expect(prefs.open('stats')).toBe(false);
    expect(prefs.open('peripherals')).toBe(true);
    expect(storage.values.get('neat-insight:stats:aside')).toBe('closed');

    prefs.setOpen('stats', true);
    expect(storage.values.get('neat-insight:stats:aside')).toBe('open');
  });

  it('reads what an earlier session stored, as after a reload', () => {
    storage.values.set('neat-insight:streaming:aside', 'closed');
    expect(TestBed.inject(AsidePrefs).open('streaming')).toBe(false);
  });

  it('runs on memory when storage refuses it', () => {
    storage.unavailable = true;
    const prefs = TestBed.inject(AsidePrefs);
    expect(prefs.open('streaming')).toBe(true);
    prefs.setOpen('streaming', false);
    expect(prefs.open('streaming')).toBe(false);
  });

  describe('on a narrow screen', () => {
    const PAGES: AsidePage[] = ['streaming', 'media', 'peripherals', 'stats'];
    beforeEach(() => narrow.set(true));

    it('starts every page’s panel closed although open is stored', () => {
      for (const page of PAGES) storage.values.set(`neat-insight:${page}:aside`, 'open');
      const prefs = TestBed.inject(AsidePrefs);
      for (const page of PAGES) expect(prefs.open(page)).toBe(false);
    });

    it('opens and closes the panel without touching storage', () => {
      storage.values.set('neat-insight:stats:aside', 'closed');
      const prefs = TestBed.inject(AsidePrefs);

      prefs.setOpen('stats', true);
      expect(prefs.open('stats')).toBe(true);
      prefs.setOpen('streaming', true);
      prefs.setOpen('streaming', false);

      expect(storage.values.get('neat-insight:stats:aside')).toBe('closed');
      expect(storage.values.has('neat-insight:streaming:aside')).toBe(false);
      expect(storage.writes).toEqual([]);
    });

    it('shows the remembered choice again on a wide screen', () => {
      storage.values.set('neat-insight:media:aside', 'closed');
      const prefs = TestBed.inject(AsidePrefs);
      prefs.setOpen('media', true);
      expect(prefs.open('media')).toBe(true);

      narrow.set(false);

      expect(prefs.open('media')).toBe(false);
      expect(prefs.open('streaming')).toBe(true);
    });
  });
});
