import { downloadCsv } from './csv-download';

describe('downloadCsv', () => {
  it('hands the text over as a text/csv file with the name, then lets the URL go', async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:csv';
    });
    const revokeObjectURL = vi.fn();
    const { createObjectURL: create, revokeObjectURL: revoke } = URL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    onTestFinished(() => {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    });
    const downloads: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ href: this.href, download: this.download });
      // The download has not started until the click returns, so the URL must still be good.
      expect(revokeObjectURL).not.toHaveBeenCalled();
    });

    downloadCsv(document, 'a,b\r\n1,2\r\n', 'sentinel-test.csv');

    expect(downloads).toEqual([{ href: 'blob:csv', download: 'sentinel-test.csv' }]);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:csv');
    expect(blobs[0].type).toBe('text/csv');
    // jsdom reads a Blob on a timer.
    vi.useRealTimers();
    expect(await blobs[0].text()).toBe('a,b\r\n1,2\r\n');
  });
});
