// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hand a Blob to the browser as a file download.
 *
 * The object URL is revoked on the next tick: revoking it synchronously can
 * cancel the download in some browsers, and never revoking leaks the blob.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
