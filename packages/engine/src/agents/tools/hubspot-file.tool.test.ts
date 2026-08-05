// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import hubspotFileTool from "./hubspot-file.tool.js";
import { buildTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";
import { pdfHandleStore } from "./pdf-handle-store.js";

afterAll(() => {
  pdfHandleStore.stopCleanupTimer();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: status >= 400 ? "Error" : "OK",
    text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

const ctxWithKey = {
  instanceId: "test",
  secrets: { hubspot_api_key: "test-api-key" },
  audit: createMockAudit(),
} as any;

describe("hubspotFile", () => {
  const def = hubspotFileTool;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("is registered with correct metadata", () => {
    expect(def).toBeDefined();
    expect(def.name).toBe("hubspotFile");
    expect(def.category).toBe("crm");
    expect(def.requiredSecrets).toEqual([{ key: "hubspot_api_key", type: "text", sensitive: true }]);
  });

  it("rejects when pdfHandle is unknown or expired", async () => {
    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: null,
      pdfHandle: "pdf_does-not-exist",
      filename: "x.pdf",
      access: null,
      folderPath: null,
      associateContactId: null,
      noteBody: null,
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/not found|expired/) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uploads via Files API and returns publicUrl + fileId", async () => {
    const handle = pdfHandleStore.put(Buffer.from("%PDF-1.4 fake"), "doc.pdf", "application/pdf");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: "FILE_123", url: "https://hubspot.example/file/abc" }),
    );

    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: null,
      pdfHandle: handle,
      filename: "doc.pdf",
      access: null,
      folderPath: null,
      associateContactId: null,
      noteBody: null,
    });

    expect(result).toMatchObject({
      success: true,
      fileId: "FILE_123",
      publicUrl: "https://hubspot.example/file/abc",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.hubapi.com/files/v3/files");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-api-key");
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    const form = (init as RequestInit).body as FormData;
    expect(form.get("folderPath")).toBe("/polyant");
    const opts = JSON.parse(form.get("options") as string);
    expect(opts.access).toBe("PUBLIC_NOT_INDEXABLE");
  });

  it("associates file→contact when associateContactId is provided (no note)", async () => {
    const handle = pdfHandleStore.put(Buffer.from("%PDF-1.4"), "doc.pdf", "application/pdf");
    mockFetch
      // Files upload
      .mockResolvedValueOnce(jsonResponse({ id: "FILE_X", url: "https://hubspot.example/file/x" }))
      // File→Contact association v4 (PUT, empty body)
      .mockResolvedValueOnce(jsonResponse({}));

    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: null,
      pdfHandle: handle,
      filename: "doc.pdf",
      access: null,
      folderPath: null,
      associateContactId: "CONTACT_42",
      noteBody: null,
    });

    expect(result).toMatchObject({
      success: true,
      fileId: "FILE_X",
      publicUrl: "https://hubspot.example/file/x",
      associatedContactId: "CONTACT_42",
    });
    // No engagement note created when noteBody is null
    expect(result.engagementId).toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [assocUrl, assocInit] = mockFetch.mock.calls[1];
    expect(assocUrl).toBe("https://api.hubapi.com/crm/v4/objects/contacts/CONTACT_42/associations/default/files/FILE_X");
    expect((assocInit as RequestInit).method).toBe("PUT");
  });

  it("creates note when associateContactId AND noteBody are both provided, substituting {{FILE_URL}} and {{FILENAME}}", async () => {
    const handle = pdfHandleStore.put(Buffer.from("%PDF-1.4"), "doc.pdf", "application/pdf");
    mockFetch
      // Files upload
      .mockResolvedValueOnce(jsonResponse({ id: "FILE_X", url: "https://hubspot.example/file/x" }))
      // File→Contact association v4
      .mockResolvedValueOnce(jsonResponse({}))
      // Note create
      .mockResolvedValueOnce(jsonResponse({ id: "NOTE_Y" }))
      // Note→Contact association
      .mockResolvedValueOnce(jsonResponse({}));

    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: null,
      pdfHandle: handle,
      filename: "doc.pdf",
      access: null,
      folderPath: null,
      associateContactId: "CONTACT_42",
      noteBody: '<p>Attachment: <a href="{{FILE_URL}}">{{FILENAME}}</a></p>',
    });

    expect(result).toMatchObject({
      success: true,
      fileId: "FILE_X",
      publicUrl: "https://hubspot.example/file/x",
      engagementId: "NOTE_Y",
      associatedContactId: "CONTACT_42",
    });

    expect(mockFetch).toHaveBeenCalledTimes(4);
    // The note body should have the placeholders replaced with the real URL and filename.
    const noteCall = mockFetch.mock.calls[2];
    expect(noteCall[0]).toBe("https://api.hubapi.com/crm/v3/objects/notes");
    const noteBody = JSON.parse((noteCall[1] as RequestInit).body as string);
    expect(noteBody.properties.hs_note_body).toBe('<p>Attachment: <a href="https://hubspot.example/file/x">doc.pdf</a></p>');
    expect(noteBody.properties.hs_note_body).not.toContain("{{FILE_URL}}");
    expect(noteBody.properties.hs_note_body).not.toContain("{{FILENAME}}");
  });

  it("returns the upload result with a warning if file→contact association fails", async () => {
    const handle = pdfHandleStore.put(Buffer.from("%PDF-1.4"), "doc.pdf", "application/pdf");
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: "FILE_X", url: "https://hubspot.example/file/x" }))
      .mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));

    const tool = buildTool(def, ctxWithKey) as any;
    const result = (await tool.execute({
      pdfHandle: handle,
      filename: "doc.pdf",
      access: null,
      folderPath: null,
      associateContactId: "CONTACT_42",
      noteBody: null,
    })) as { success: boolean; fileId: string; warnings?: string[] };

    expect(result.success).toBe(true);
    expect(result.fileId).toBe("FILE_X");
    expect(result.warnings?.[0]).toMatch(/File→contact association not created/);
  });

  it("returns error when Files API responds non-ok", async () => {
    const handle = pdfHandleStore.put(Buffer.from("%PDF-1.4"), "doc.pdf", "application/pdf");
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: "unauthorized" }, 401));

    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: null,
      pdfHandle: handle,
      filename: "doc.pdf",
      access: null,
      folderPath: null,
      associateContactId: null,
      noteBody: null,
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/401|HubSpot Files API/) });
  });

  it("rejects when hubspot_api_key secret is missing", async () => {
    const tool = buildTool(def, {
      instanceId: "test",
      secrets: {},
      audit: createMockAudit(),
    } as any) as any;
    const result = await tool.execute({
      action: null,
      pdfHandle: "pdf_x",
      filename: "x.pdf",
      access: null,
      folderPath: null,
      associateContactId: null,
      noteBody: null,
    });
    expect(result).toMatchObject({ error: expect.stringMatching(/HubSpot API key/) });
  });

  // ----- action="search" -----

  it("search: returns publicUrl + fileId when 1 PDF is associated via file-associations v4", async () => {
    mockFetch
      // 1) File associations → 1 result
      .mockResolvedValueOnce(jsonResponse({ results: [{ toObjectId: "FILE_42", associationTypes: [] }] }))
      // 2) Note associations → empty (no notes on this contact)
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      // 3) File metadata
      .mockResolvedValueOnce(
        jsonResponse({
          id: "FILE_42",
          name: "proposal.pdf",
          url: "https://hubspot.example/file/42",
          createdAt: "2026-05-20T10:00:00Z",
          extension: "pdf",
        }),
      );

    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: "search",
      pdfHandle: null,
      filename: null,
      access: null,
      folderPath: null,
      associateContactId: "CONTACT_780919107780",
      noteBody: null,
    });

    expect(result).toMatchObject({
      success: true,
      fileId: "FILE_42",
      filename: "proposal.pdf",
      publicUrl: "https://hubspot.example/file/42",
      contactId: "CONTACT_780919107780",
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.hubapi.com/crm/v4/objects/contacts/CONTACT_780919107780/associations/files",
    );
    expect(mockFetch.mock.calls[1][0]).toBe(
      "https://api.hubapi.com/crm/v4/objects/contacts/CONTACT_780919107780/associations/notes",
    );
    expect(mockFetch.mock.calls[2][0]).toBe("https://api.hubapi.com/files/v3/files/FILE_42");
  });

  it("search: returns errorCode NOT_FOUND when neither file-associations nor notes have files", async () => {
    mockFetch
      // file associations → empty
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      // note associations → empty
      .mockResolvedValueOnce(jsonResponse({ results: [] }));

    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: "search",
      pdfHandle: null,
      filename: null,
      access: null,
      folderPath: null,
      associateContactId: "CONTACT_NONE",
      noteBody: null,
    });

    expect(result).toMatchObject({
      error: expect.stringMatching(/No file associated/),
      errorCode: "NOT_FOUND",
      contactId: "CONTACT_NONE",
    });
    // No metadata fetch, no batch read
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("search: returns errorCode MULTIPLE_FOUND when >1 PDFs are found across the two sources", async () => {
    mockFetch
      // file associations → 3 files
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { toObjectId: "FILE_A", associationTypes: [] },
            { toObjectId: "FILE_B", associationTypes: [] },
            { toObjectId: "FILE_C", associationTypes: [] },
          ],
        }),
      )
      // note associations → empty
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      // metadata for A, B, C — all PDFs
      .mockResolvedValueOnce(jsonResponse({ id: "FILE_A", name: "a.pdf", url: "u/a", extension: "pdf" }))
      .mockResolvedValueOnce(jsonResponse({ id: "FILE_B", name: "b.pdf", url: "u/b", extension: "pdf" }))
      .mockResolvedValueOnce(jsonResponse({ id: "FILE_C", name: "c.pdf", url: "u/c", extension: "pdf" }));

    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: "search",
      pdfHandle: null,
      filename: null,
      access: null,
      folderPath: null,
      associateContactId: "CONTACT_DUP",
      noteBody: null,
    });

    expect(result).toMatchObject({
      error: expect.stringMatching(/Found 3 PDFs associated/),
      errorCode: "MULTIPLE_FOUND",
      contactId: "CONTACT_DUP",
      count: 3,
    });
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("search: rejects when associateContactId is not provided", async () => {
    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: "search",
      pdfHandle: null,
      filename: null,
      access: null,
      folderPath: null,
      associateContactId: null,
      noteBody: null,
    });

    expect(result).toMatchObject({
      error: expect.stringMatching(/associateContactId is required/),
    });
    // errorCode must NOT be set for input-validation errors (only set on
    // domain-level outcomes NOT_FOUND / MULTIPLE_FOUND).
    expect(result.errorCode).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ----- regression tests for the note-engagement fix -----

  it("search: finds the PDF when it is attached ONLY via an engagement note (HubSpot UI 'Add attachment')", async () => {
    // Reproduces the case where the HubSpot UI attaches a PDF via a note
    // engagement with hs_attachment_ids, NOT via a direct file→contact
    // association. The tool must walk both sources.
    mockFetch
      // 1) File associations → empty (this is the bug: tool used to stop here)
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      // 2) Note associations → 2 notes (e.g. a profile note + the attachment note)
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { toObjectId: "NOTE_PROFILE" },
            { toObjectId: "NOTE_ATTACH" },
          ],
        }),
      )
      // 3) Notes batch read → one with hs_attachment_ids set
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { id: "NOTE_PROFILE", properties: { hs_attachment_ids: null } },
            { id: "NOTE_ATTACH", properties: { hs_attachment_ids: "FILE_FROM_NOTE" } },
          ],
        }),
      )
      // 4) File metadata
      .mockResolvedValueOnce(
        jsonResponse({
          id: "FILE_FROM_NOTE",
          name: "blueprint.pdf",
          url: "https://hubspot.example/file/from-note",
          createdAt: "2026-05-21T08:47:00Z",
          extension: "pdf",
        }),
      );

    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: "search",
      pdfHandle: null,
      filename: null,
      access: null,
      folderPath: null,
      associateContactId: "CONTACT_X",
      noteBody: null,
    });

    expect(result).toMatchObject({
      success: true,
      fileId: "FILE_FROM_NOTE",
      filename: "blueprint.pdf",
      publicUrl: "https://hubspot.example/file/from-note",
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
    // Batch read call must request only hs_attachment_ids and pass the noteIds.
    const batchCall = mockFetch.mock.calls[2];
    expect(batchCall[0]).toBe("https://api.hubapi.com/crm/v3/objects/notes/batch/read");
    expect((batchCall[1] as RequestInit).method).toBe("POST");
    const batchBody = JSON.parse((batchCall[1] as RequestInit).body as string);
    expect(batchBody.properties).toEqual(["hs_attachment_ids"]);
    expect(batchBody.inputs.map((i: { id: string }) => i.id)).toEqual(["NOTE_PROFILE", "NOTE_ATTACH"]);
  });

  it("search: dedupes when the same fileId appears in BOTH file-associations and a note's hs_attachment_ids", async () => {
    mockFetch
      // 1) File associations → FILE_X
      .mockResolvedValueOnce(jsonResponse({ results: [{ toObjectId: "FILE_X" }] }))
      // 2) Note associations → 1 note that *also* mentions FILE_X
      .mockResolvedValueOnce(jsonResponse({ results: [{ toObjectId: "NOTE_Y" }] }))
      // 3) Batch read → NOTE_Y has hs_attachment_ids="FILE_X" (same as Source A)
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: "NOTE_Y", properties: { hs_attachment_ids: "FILE_X" } }],
        }),
      )
      // 4) File metadata fetched ONCE thanks to dedupe
      .mockResolvedValueOnce(
        jsonResponse({ id: "FILE_X", name: "x.pdf", url: "u/x", extension: "pdf" }),
      );

    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: "search",
      pdfHandle: null,
      filename: null,
      access: null,
      folderPath: null,
      associateContactId: "CONTACT_DEDUPE",
      noteBody: null,
    });

    expect(result).toMatchObject({ success: true, fileId: "FILE_X" });
    // 4 calls total — NOT 5 — because the duplicate fileId was deduped before
    // the metadata fetch.
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("search: filters out non-PDF attachments (PNG, etc) so a contact with extra media doesn't trip MULTIPLE_FOUND", async () => {
    mockFetch
      // 1) File associations → 1 PDF
      .mockResolvedValueOnce(jsonResponse({ results: [{ toObjectId: "FILE_PDF" }] }))
      // 2) Note associations → 1 note holding a PNG (e.g. profile picture)
      .mockResolvedValueOnce(jsonResponse({ results: [{ toObjectId: "NOTE_PNG" }] }))
      // 3) Batch read → note has hs_attachment_ids="FILE_PNG"
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: "NOTE_PNG", properties: { hs_attachment_ids: "FILE_PNG" } }],
        }),
      )
      // 4) Metadata FILE_PDF (pdf)
      .mockResolvedValueOnce(
        jsonResponse({ id: "FILE_PDF", name: "proposal.pdf", url: "u/pdf", extension: "pdf" }),
      )
      // 5) Metadata FILE_PNG (png — must be filtered out)
      .mockResolvedValueOnce(
        jsonResponse({ id: "FILE_PNG", name: "avatar.png", url: "u/png", extension: "png" }),
      );

    const tool = buildTool(def, ctxWithKey) as any;
    const result = await tool.execute({
      action: "search",
      pdfHandle: null,
      filename: null,
      access: null,
      folderPath: null,
      associateContactId: "CONTACT_MIXED",
      noteBody: null,
    });

    // Only the PDF survives the filter → success with exactly that file.
    expect(result).toMatchObject({
      success: true,
      fileId: "FILE_PDF",
      filename: "proposal.pdf",
    });
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});
