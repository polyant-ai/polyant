// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { readLimitedBody, ResponseTooLargeError } from "./read-limited-body.js";

describe("readLimitedBody", () => {
  it("returns a body at or under the cap", async () => {
    expect((await readLimitedBody(new Response("12345"), 5)).toString()).toBe("12345");
  });

  it("refuses a body that grows past the cap", async () => {
    await expect(readLimitedBody(new Response("123456"), 5)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("refuses on a declared content-length without reading the body", async () => {
    const response = new Response("x", { headers: { "content-length": "100" } });
    await expect(readLimitedBody(response, 10)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("returns an empty buffer for a response without a body", async () => {
    expect(await readLimitedBody(new Response(null), 5)).toEqual(Buffer.alloc(0));
  });

  it("releases the reader lock whichever way it returns", async () => {
    const over = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(4));
        },
      }),
    );
    await expect(readLimitedBody(over, 10)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(over.body!.locked).toBe(false);

    const ok = new Response("abc");
    await readLimitedBody(ok, 5);
    expect(ok.body!.locked).toBe(false);
  });
});
