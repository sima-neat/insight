import { copyText } from './clipboard';

describe('copyText', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const setClipboard = (value: unknown) =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value });

  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('writes the text as plain text', async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard({ writeText });
    await copyText('ssh-copy-id -p 22 sima@192.168.1.20');
    expect(writeText).toHaveBeenCalledWith('ssh-copy-id -p 22 sima@192.168.1.20');
  });

  it('throws when the browser has no clipboard or refuses it', async () => {
    // Outside a secure context there is no clipboard at all.
    setClipboard(undefined);
    await expect(copyText('x')).rejects.toThrow();

    setClipboard({
      writeText: vi.fn(async () => Promise.reject(new DOMException('Denied', 'NotAllowedError'))),
    });
    await expect(copyText('x')).rejects.toThrow('Denied');
  });
});
