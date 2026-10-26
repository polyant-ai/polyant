// SPDX-License-Identifier: AGPL-3.0-or-later

export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response exceeds ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/** Reads a response body, refusing it as soon as it grows past `maxBytes`. */
export async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
