import { TestBed } from '@angular/core/testing';
import { AsidePrefs } from './aside-prefs';
import { FakeLocalStorage } from './fake-storage.testing';

describe('AsidePrefs', () => {
  let storage: FakeLocalStorage;

  beforeEach(() => {
    storage = new FakeLocalStorage();
    vi.stubGlobal('localStorage', storage);
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
});
