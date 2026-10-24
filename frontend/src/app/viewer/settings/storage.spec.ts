import { TestBed } from '@angular/core/testing';
import { FakeLocalStorage, VIEWER_PREFIX } from '../../fake-storage.testing';
import { ViewerStorage } from './storage';

describe('ViewerStorage', () => {
  let fake: FakeLocalStorage;

  beforeEach(() => {
    fake = new FakeLocalStorage();
    vi.stubGlobal('localStorage', fake);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const storage = () => TestBed.inject(ViewerStorage);

  it('keeps every value under the viewer prefix and lists only its own names', () => {
    fake.values.set('neat-ui:color-scheme', 'dark');
    storage().set('layout', '{}');
    storage().set('settings:global', '{"version":10}');

    expect(fake.values.get(`${VIEWER_PREFIX}layout`)).toBe('{}');
    expect(storage().get('settings:global')).toBe('{"version":10}');
    expect(storage().names().sort()).toEqual(['layout', 'settings:global']);

    storage().remove('layout');
    expect(storage().get('layout')).toBeNull();
    expect(storage().names()).toEqual(['settings:global']);
  });

  it('keeps writes the browser refuses for the session, for every instance that reads them', () => {
    fake.seed({ layout: 'stored' });
    fake.failWrites = true;

    expect(() => storage().set('layout', 'session')).not.toThrow();
    expect(() => storage().set('settings:global', 'new')).not.toThrow();
    expect(storage().get('layout')).toBe('session');
    expect(storage().names().sort()).toEqual(['layout', 'settings:global']);
    expect(fake.readRaw('layout')).toBe('stored');

    // A refused removal hides the stored value for the session too.
    expect(() => storage().remove('layout')).not.toThrow();
    expect(storage().get('layout')).toBeNull();
    expect(storage().names()).toEqual(['settings:global']);

    // Once the browser accepts writes again, the stored value takes over from the session copy.
    fake.failWrites = false;
    storage().set('layout', 'persisted');
    expect(fake.readRaw('layout')).toBe('persisted');
    expect(storage().get('layout')).toBe('persisted');
  });

  it('works on the session alone when storage cannot be reached at all', () => {
    fake.seed({ layout: 'stored' });
    fake.unavailable = true;

    expect(storage().get('layout')).toBeNull();
    expect(storage().names()).toEqual([]);
    expect(() => storage().set('layout', 'session')).not.toThrow();
    expect(storage().get('layout')).toBe('session');
    expect(storage().names()).toEqual(['layout']);
  });

  it('survives a missing localStorage global', () => {
    vi.stubGlobal('localStorage', undefined);

    expect(storage().get('layout')).toBeNull();
    storage().set('layout', 'session');
    expect(storage().get('layout')).toBe('session');
  });
});
