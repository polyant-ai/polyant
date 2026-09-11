// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The attachment download route over REAL HTTP, through a real Nest router.
 *
 * This file exists because of what the unit tests could not see. Every other
 * test of this controller calls the handler directly and hands it a STRING, so
 * the route's actual param shape was never exercised — and Express 5 /
 * path-to-regexp 8 hand a `*key` wildcard to the handler as an array of decoded
 * segments. The regex was therefore tested against `"attachments,a,c,f.pdf"`,
 * failed, and the endpoint refused every attachment that had ever been stored:
 * as a 404 reading "no such file", which is why nobody read it as a crash.
 *
 * A unit test cannot catch that class of defect by construction — it supplies
 * the very value the framework was getting wrong. So the router is real here and
 * only the leaves are stubbed: the S3 read and the tenancy check.
 *
 * Authorization is NOT the subject: `@RequirePermission` is inert without the
 * guards, and the guard chain has its own real-HTTP file (`server/guard-chain.test.ts`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { getAttachmentStream, callerMayAccessAgent } = vi.hoisted(() => ({
  getAttachmentStream: vi.fn(),
  callerMayAccessAgent: vi.fn(),
}));

vi.mock("../../attachments/agent-storage.js", () => ({ getAttachmentStream }));
vi.mock("../../authz/agent-tenancy.js", () => ({ callerMayAccessAgent }));

import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Readable } from "node:stream";
import { AttachmentsController } from "./attachments.controller.js";

@Module({ controllers: [AttachmentsController] })
class TestModule {}

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  callerMayAccessAgent.mockResolvedValue(true);
  getAttachmentStream.mockResolvedValue({
    body: Readable.from([Buffer.from("PDF-BYTES")]),
    contentType: "application/pdf",
    contentLength: 9,
  });
});

describe("GET /api/attachments/*key over HTTP", () => {
  it("serves a well-formed key, and hands the store the recomposed string", async () => {
    const res = await fetch(`${baseUrl}/api/attachments/attachments/agent-a/conv-1/report.pdf`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PDF-BYTES");
    // The whole defect in one assertion: the store must receive the key as a
    // slash-joined string, never the router's array nor its comma coercion.
    expect(getAttachmentStream).toHaveBeenCalledWith(
      "agent-a",
      "attachments/agent-a/conv-1/report.pdf",
    );
    expect(callerMayAccessAgent).toHaveBeenCalledWith("agent-a", undefined);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
  });

  it("serves an image inline rather than as a download", async () => {
    getAttachmentStream.mockResolvedValue({
      body: Readable.from([Buffer.from("PNG")]),
      contentType: "image/png",
      contentLength: 3,
    });

    const res = await fetch(`${baseUrl}/api/attachments/attachments/agent-a/conv-1/shot.png`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('inline; filename="shot.png"');
  });

  /*
    A filename the panel used to interpolate raw. `%23` and `%3F` are what a
    correctly-encoded link sends; the router decodes them back into ONE segment,
    so the key must still parse and the store must still see the real name.
  */
  it.each([
    ["a hash", "report%20%2312.pdf", "report #12.pdf"],
    ["a dot run", "report..pdf", "report..pdf"],
    ["a question mark", "report%3F.pdf", "report?.pdf"],
    ["a space", "my%20report.pdf", "my report.pdf"],
  ])("serves a filename carrying %s", async (_label, encoded, decoded) => {
    const res = await fetch(`${baseUrl}/api/attachments/attachments/agent-a/conv-1/${encoded}`);

    expect(res.status).toBe(200);
    expect(getAttachmentStream).toHaveBeenCalledWith(
      "agent-a",
      `attachments/agent-a/conv-1/${decoded}`,
    );
  });

  /*
    Every refusal is the same 404 and none of them reaches S3. `%2F` is the one
    that recomposing-then-validating would have let through: the router decodes
    it INSIDE a single segment, so the joined string looks like a well-formed
    four-segment key while the segment count says otherwise.
  */
  it.each([
    ["too few segments", "attachments/agent-a/report.pdf"],
    ["too many segments", "attachments/agent-a/conv-1/sub/report.pdf"],
    ["the wrong prefix", "uploads/agent-a/conv-1/report.pdf"],
    ["a literal traversal", "attachments/agent-a/../conv-1/report.pdf"],
    ["an encoded separator inside a segment", "attachments/agent-a/conv-1/a%2Fb.pdf"],
    ["an encoded traversal as the whole segment", "attachments/agent-a/conv-1/%2E%2E"],
  ])("refuses %s with a 404 and no S3 read", async (_label, path) => {
    const res = await fetch(`${baseUrl}/api/attachments/${path}`);

    expect(res.status).toBe(404);
    expect(getAttachmentStream).not.toHaveBeenCalled();
  });

  it("refuses a caller the tenancy check rejects, without reading S3", async () => {
    callerMayAccessAgent.mockResolvedValue(false);

    const res = await fetch(`${baseUrl}/api/attachments/attachments/agent-b/conv-1/report.pdf`);

    expect(res.status).toBe(404);
    expect(getAttachmentStream).not.toHaveBeenCalled();
  });
});
