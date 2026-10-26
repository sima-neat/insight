import { readResume, writeResume } from './webcam-resume';

const KEY = 'neat-insight:webcams';

describe('webcam resume storage', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('reads nothing where nothing was written', () => {
    expect(readResume().size).toBe(0);
  });

  it('keeps each slot’s camera and whether it was sending, as JSON under one key', () => {
    writeResume(2, { deviceId: 'cam-desk', sending: true });
    writeResume(5, { deviceId: 'cam-laptop', sending: false });

    expect(JSON.parse(sessionStorage.getItem(KEY) ?? 'null')).toEqual({
      '2': { deviceId: 'cam-desk', sending: true },
      '5': { deviceId: 'cam-laptop', sending: false },
    });
    expect(new Map(readResume())).toEqual(
      new Map([
        [2, { deviceId: 'cam-desk', sending: true }],
        [5, { deviceId: 'cam-laptop', sending: false }],
      ]),
    );
  });

  it('replaces a slot’s entry, and null removes it and the key with the last one', () => {
    writeResume(2, { deviceId: 'cam-desk', sending: false });
    writeResume(2, { deviceId: 'cam-laptop', sending: true });
    expect(readResume().get(2)).toEqual({ deviceId: 'cam-laptop', sending: true });

    writeResume(2, null);
    expect(readResume().size).toBe(0);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    writeResume(7, null); // nothing to remove is not an error
  });

  it('is per tab: it never touches localStorage', () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    writeResume(1, { deviceId: 'cam-desk', sending: true });
    expect(local.mock.instances.every((storage) => storage === sessionStorage)).toBe(true);
    local.mockRestore();
  });

  it('skips what is not an entry and keeps what is', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        '1': { deviceId: 'cam-desk', sending: true },
        '2': { deviceId: '', sending: true },
        '3': { deviceId: 'cam-laptop' },
        '4': { deviceId: 7, sending: false },
        '5': null,
        x: { deviceId: 'cam-desk', sending: true },
        '-1': { deviceId: 'cam-desk', sending: true },
        '1.5': { deviceId: 'cam-desk', sending: true },
      }),
    );

    expect([...readResume().keys()]).toEqual([1]);
  });

  it('reads nothing from text that is not an object of entries', () => {
    for (const text of ['not json', '[1]', '"x"', 'null', '7']) {
      sessionStorage.setItem(KEY, text);
      expect(readResume().size).toBe(0);
    }
  });

  it('reads and writes nothing, and says nothing, where storage throws', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });

    expect(readResume().size).toBe(0);
    expect(() => writeResume(1, { deviceId: 'cam-desk', sending: true })).not.toThrow();
    expect(() => writeResume(1, null)).not.toThrow();
  });

  it('reads nothing where the storage object itself is missing', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(readResume().size).toBe(0);
    expect(() => writeResume(1, { deviceId: 'cam-desk', sending: true })).not.toThrow();
  });
});
