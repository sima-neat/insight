/**
 * Hands `text` to the browser as a CSV file called `filename`, through a Blob URL that is let go
 * once the download has started. Both Stats exports (the Live session and a comparison) save
 * this way.
 */
export function downloadCsv(document: Document, text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
