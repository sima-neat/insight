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

  describe('width', () => {
    it('is the default (null) until the user drags the panel, and is kept per page', () => {
      const prefs = TestBed.inject(AsidePrefs);
      expect(prefs.width('streaming')).toBeNull();

      prefs.setWidth('streaming', 420);
      prefs.setWidth('stats', 360.5);

      expect(prefs.width('streaming')).toBe(420);
      expect(prefs.width('stats')).toBe(360.5);
      expect(prefs.width('media')).toBeNull();
      expect(storage.values.get('neat-insight:streaming:aside-width')).toBe('420');
      expect(storage.values.get('neat-insight:stats:aside-width')).toBe('360.5');
      expect(storage.values.has('neat-insight:media:aside-width')).toBe(false);
    });

    it('goes back to the default by removing the stored value', () => {
      const prefs = TestBed.inject(AsidePrefs);
      prefs.setWidth('peripherals', 400);

      prefs.setWidth('peripherals', null);

      expect(prefs.width('peripherals')).toBeNull();
      expect(storage.values.has('neat-insight:peripherals:aside-width')).toBe(false);
    });

    it('is read from an earlier session, as after a reload', () => {
      storage.values.set('neat-insight:media:aside-width', '480');
      expect(TestBed.inject(AsidePrefs).width('media')).toBe(480);
    });

    it.each(['', 'wide', '0', '-20', 'Infinity', 'NaN'])(
      'ignores %j in storage: the default applies',
      (stored) => {
        storage.values.set('neat-insight:media:aside-width', stored);
        expect(TestBed.inject(AsidePrefs).width('media')).toBeNull();
      },
    );

    it('writes nothing when the width is already the remembered one', () => {
      const prefs = TestBed.inject(AsidePrefs);
      prefs.setWidth('stats', 400);
      prefs.setWidth('media', null);
      storage.writes.length = 0;

      prefs.setWidth('stats', 400);
      prefs.setWidth('media', null);

      expect(storage.writes).toEqual([]);
    });

    it('stays independent of the open state, and of a narrow screen', () => {
      storage.values.set('neat-insight:stats:aside-width', '400');
      narrow.set(true);
      const prefs = TestBed.inject(AsidePrefs);

      expect(prefs.open('stats')).toBe(false);
      expect(prefs.width('stats')).toBe(400);
      prefs.setOpen('stats', false);
      expect(prefs.width('stats')).toBe(400);
    });

    it('runs on memory when storage refuses it', () => {
      storage.unavailable = true;
      const prefs = TestBed.inject(AsidePrefs);
      prefs.setWidth('streaming', 450);
      expect(prefs.width('streaming')).toBe(450);
      prefs.setWidth('streaming', null);
      expect(prefs.width('streaming')).toBeNull();
    });
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
