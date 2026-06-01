// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { registerTool, type ToolContext } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { hubspotFetch, getHubSpotApiKeyOrError, HUBSPOT_ASSOCIATION_TYPES } from "./hubspot-fetch.js";
import { pdfHandleStore } from "./pdf-handle-store.js";

const ACCESS_VALUES = ["PUBLIC_INDEXABLE", "PUBLIC_NOT_INDEXABLE", "PRIVATE"] as const;
type Access = (typeof ACCESS_VALUES)[number];

const FILES_API = "https://api.hubapi.com/files/v3/files";
const NOTES_API = "https://api.hubapi.com/crm/v3/objects/notes";

registerTool({
  name: "hubspotFile",
  description:
    "Multi-action tool for HubSpot Files. Discriminator: `action`.\n\n" +
    "action='upload' (default when action is null/omitted):\n" +
    "  Uploads a file to HubSpot Files (Files API v3). Consumes a pdfHandle produced by markdownToPdf (one-shot, valid 10 minutes).\n" +
    "  With access=PUBLIC_NOT_INDEXABLE the file has a public URL usable as an attachment (e.g. a WhatsApp mediaUrl).\n" +
    "  If you pass associateContactId, the file is ASSOCIATED with the contact (visible in the contact's Attachments tab in the HubSpot UI), WITHOUT creating any note.\n" +
    "  If you pass associateContactId AND noteBody, besides the association a Note engagement is also created with the provided HTML body. The body supports the {{FILE_URL}} and {{FILENAME}} placeholders, which the tool replaces with the actual public URL and filename.\n\n" +
    "action='search':\n" +
    "  Retrieves the SINGLE PDF associated with a contact. Requires associateContactId. All other parameters are ignored.\n" +
    "  Searches both HubSpot shapes: (a) direct file→contact associations, (b) note engagements with hs_attachment_ids (the 'Add attachment' case from the HubSpot UI). Union + dedupe, then filters by 'pdf' extension — other files (profile pictures, screenshots, mixed docs) are ignored.\n" +
    "  Outcomes: { success: true, fileId, filename, publicUrl, createdAt } if exactly 1 PDF is found.\n" +
    "  Error outcome with errorCode='NOT_FOUND' if 0 PDFs. Error outcome with errorCode='MULTIPLE_FOUND' (+ count field) if >1 PDFs: the use case assumes a 1:1 contact↔PDF mapping.",
  category: "crm",
  requiredSecrets: ["hubspot_api_key"],
  inputExamples: [
    {
      label: "Upload PDF and associate file→contact (no note)",
      input: {
        action: "upload",
        pdfHandle: "pdf_<uuid>",
        filename: "quote-2026-001.pdf",
        access: "PUBLIC_NOT_INDEXABLE",
        associateContactId: "12345",
      },
    },
    {
      label: "Upload with a custom note + placeholders",
      input: {
        action: "upload",
        pdfHandle: "pdf_<uuid>",
        filename: "contract.pdf",
        associateContactId: "12345",
        noteBody: "<p>Contract sent on 2026-05-11: <a href=\"{{FILE_URL}}\">{{FILENAME}}</a></p>",
      },
    },
    {
      label: "Search: retrieve the single file associated with the contact",
      input: {
        action: "search",
        associateContactId: "780919107780",
      },
    },
  ],
  create: (ctx) => ({
    parameters: z.object({
      action: z
        .enum(["upload", "search"])
        .nullable()
        .describe("Discriminator. 'upload' (default when null) uploads a file via pdfHandle. 'search' retrieves the single file associated with a contact (requires associateContactId)."),
      pdfHandle: z
        .string()
        .nullable()
        .describe("REQUIRED for action='upload'. Opaque handle returned by the markdownToPdf tool (consumed once). Ignored for action='search'."),
      filename: z
        .string()
        .nullable()
        .describe("REQUIRED for action='upload'. File name on HubSpot (e.g. 'quote.pdf'). The .pdf extension is recommended. Ignored for action='search'."),
      access: z
        .enum(ACCESS_VALUES)
        .nullable()
        .describe("Only for action='upload'. File visibility. Default PUBLIC_NOT_INDEXABLE. Ignored for action='search'."),
      folderPath: z
        .string()
        .nullable()
        .describe("Only for action='upload'. Destination HubSpot folder. Default '/polyant'. Ignored for action='search'."),
      associateContactId: z
        .string()
        .nullable()
        .describe("For action='upload': optional, associates the file with the contact. For action='search': REQUIRED, identifies the contact whose file to retrieve."),
      noteBody: z
        .string()
        .nullable()
        .describe("Only for action='upload'. HTML body of the optional Note engagement (requires associateContactId). Supports the {{FILE_URL}} and {{FILENAME}} placeholders. Ignored for action='search'."),
    }),
    execute: async (params: {
      action: "upload" | "search" | null;
      pdfHandle: string | null;
      filename: string | null;
      access: Access | null;
      folderPath: string | null;
      associateContactId: string | null;
      noteBody: string | null;
    }) => {
      const apiKeyResult = getHubSpotApiKeyOrError(ctx);
      if (typeof apiKeyResult !== "string") return apiKeyResult;
      const apiKey = apiKeyResult;

      const action: "upload" | "search" = params.action ?? "upload";

      if (action === "search") {
        return await searchFileForContact(ctx, apiKey, params.associateContactId);
      }

      // action === "upload" — validate required params for this branch
      if (!params.pdfHandle) {
        return { error: "pdfHandle is required for action='upload'." };
      }
      if (!params.filename) {
        return { error: "filename is required for action='upload'." };
      }
      // Narrowed locals so TypeScript propagates non-null through callbacks/closures below.
      const pdfHandle: string = params.pdfHandle;
      const filename: string = params.filename;

      const entry = pdfHandleStore.take(pdfHandle);
      if (!entry) {
        return {
          error: `pdfHandle "${pdfHandle}" not found or expired. Generate the PDF again with markdownToPdf.`,
        };
      }

      const access: Access = params.access ?? "PUBLIC_NOT_INDEXABLE";
      const folderPath = params.folderPath ?? "/polyant";

      let fileId: string;
      let publicUrl: string;
      try {
        const uploaded = await uploadFile(apiKey, entry.buffer, filename, entry.mime, access, folderPath);
        fileId = uploaded.id;
        publicUrl = uploaded.url;
      } catch (err) {
        ctx.audit.log({
          action: "hubspot.fileUpload",
          details: { filename, sizeBytes: entry.buffer.length, access, folderPath },
          success: false,
          error: errMsg(err),
        });
        return { error: `HubSpot Files upload error: ${errMsg(err)}` };
      }

      ctx.audit.log({
        action: "hubspot.fileUpload",
        details: {
          filename,
          sizeBytes: entry.buffer.length,
          access,
          folderPath,
          fileId,
        },
        success: true,
      });

      const warnings: string[] = [];
      let associatedContactId: string | undefined;
      let engagementId: string | undefined;

      if (params.associateContactId) {
        // 1) Always: associate file -> contact (visible in contact's Attachments).
        try {
          await associateFileToContact(apiKey, fileId, params.associateContactId);
          associatedContactId = params.associateContactId;
          ctx.audit.log({
            action: "hubspot.fileAssociate",
            details: { fileId, contactId: params.associateContactId },
            success: true,
          });
        } catch (err) {
          warnings.push(`File→contact association not created: ${errMsg(err)}`);
          ctx.audit.log({
            action: "hubspot.fileAssociate",
            details: { fileId, contactId: params.associateContactId },
            success: false,
            error: errMsg(err),
          });
        }

        // 2) Optional: create an engagement note if a custom body was provided.
        if (params.noteBody) {
          try {
            const body = substituteTemplatePlaceholders(params.noteBody, { fileUrl: publicUrl, filename });
            engagementId = await createNoteForContact(apiKey, body, params.associateContactId);
            ctx.audit.log({
              action: "hubspot.fileNote",
              details: { fileId, contactId: params.associateContactId, engagementId },
              success: true,
            });
          } catch (err) {
            warnings.push(`Note not created: ${errMsg(err)}`);
            ctx.audit.log({
              action: "hubspot.fileNote",
              details: { fileId, contactId: params.associateContactId },
              success: false,
              error: errMsg(err),
            });
          }
        }
      }

      return {
        success: true,
        fileId,
        publicUrl,
        ...(associatedContactId ? { associatedContactId } : {}),
        ...(engagementId ? { engagementId } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  }),
});

function substituteTemplatePlaceholders(
  body: string,
  vars: { fileUrl: string; filename: string },
): string {
  return body
    .replaceAll("{{FILE_URL}}", vars.fileUrl)
    .replaceAll("{{FILENAME}}", vars.filename);
}

async function uploadFile(
  apiKey: string,
  buffer: Buffer,
  filename: string,
  mime: string,
  access: Access,
  folderPath: string,
): Promise<{ id: string; url: string }> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mime });
  form.append("file", blob, filename);
  form.append("folderPath", folderPath);
  form.append(
    "options",
    JSON.stringify({
      access,
      overwrite: false,
      duplicateValidationStrategy: "NONE",
      duplicateValidationScope: "EXACT_FOLDER",
    }),
  );

  const res = await hubspotFetch(FILES_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const respBody = await res.text();
    throw new Error(`HubSpot Files API ${res.status}: ${respBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as { id?: string; url?: string };
  if (!data.id || !data.url) {
    throw new Error(`HubSpot Files API response missing id/url: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { id: data.id, url: data.url };
}

/**
 * Associate a HubSpot file with a contact via the Associations v4 default API.
 *
 * Endpoint: PUT /crm/v4/objects/contacts/{contactId}/associations/default/files/{fileId}
 * HubSpot picks the standard association type ("contact_to_file") automatically.
 * Result in HubSpot UI: the file appears under the contact's Attachments tab,
 * with no engagement note required.
 */
async function associateFileToContact(
  apiKey: string,
  fileId: string,
  contactId: string,
): Promise<void> {
  const url = `https://api.hubapi.com/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/default/files/${encodeURIComponent(fileId)}`;
  const res = await hubspotFetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const respBody = await res.text();
    throw new Error(`File→Contact association ${res.status}: ${respBody.slice(0, 200)}`);
  }
}

async function createNoteForContact(
  apiKey: string,
  bodyHtml: string,
  contactId: string,
): Promise<string> {
  const createRes = await hubspotFetch(NOTES_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      properties: {
        hs_note_body: bodyHtml,
        hs_timestamp: new Date().toISOString(),
      },
    }),
  });

  if (!createRes.ok) {
    const respBody = await createRes.text();
    throw new Error(`Create note ${createRes.status}: ${respBody.slice(0, 200)}`);
  }

  const note = (await createRes.json()) as { id: string };

  const assocRes = await hubspotFetch(
    "https://api.hubapi.com/crm/v3/associations/notes/contacts/batch/create",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        inputs: [{ from: { id: note.id }, to: { id: contactId }, type: HUBSPOT_ASSOCIATION_TYPES.noteToContact }],
      }),
    },
  );

  if (!assocRes.ok) {
    const respBody = await assocRes.text();
    throw new Error(`Associate note→contact ${assocRes.status}: ${respBody.slice(0, 200)}`);
  }

  return note.id;
}

/**
 * Look up the single PDF file associated to a contact.
 *
 * HubSpot exposes "files attached to a contact" through TWO different shapes
 * depending on how the file was uploaded:
 *
 *   Source A — direct file→contact associations (Associations API v4).
 *     Created when the file is associated programmatically (e.g. via this
 *     tool's `action="upload"` branch with associateContactId).
 *     Endpoint: GET /crm/v4/objects/contacts/{contactId}/associations/files
 *
 *   Source B — note engagement with hs_attachment_ids.
 *     Created when the file is uploaded via the HubSpot UI on the contact
 *     record ("Add attachment"). HubSpot creates an empty engagement note
 *     (hs_note_body=null) whose hs_attachment_ids property is a CSV of file
 *     IDs, and associates that note to the contact.
 *     Endpoint: GET /crm/v4/objects/contacts/{contactId}/associations/notes
 *               then POST /crm/v3/objects/notes/batch/read?properties=
 *               hs_attachment_ids
 *
 * Both sources are queried, the union is deduplicated, file metadata is
 * fetched for each unique fileId, and the result is filtered to PDFs only
 * (extension === "pdf"). Non-PDF artefacts a contact may carry — profile
 * pictures, screenshots, generic .docx — are ignored so the 1:1 contract
 * applies only to the relevant artefact.
 *
 * Contract: a contact must have **exactly 1** PDF attached (via either shape).
 *   0 PDFs → returns { error, errorCode: "NOT_FOUND" }
 *   >1 PDFs → returns { error, errorCode: "MULTIPLE_FOUND", count }
 *   1 PDF → returns { success: true, fileId, filename, publicUrl, createdAt }
 *
 * All audit logging happens inside this helper (`hubspot.fileSearch`).
 * Generic HTTP/network errors are returned as `{ error }` without an `errorCode`
 * so the caller (the LLM via prompt) can distinguish "file missing" from
 * "HubSpot unreachable".
 */
async function searchFileForContact(
  ctx: ToolContext,
  apiKey: string,
  contactId: string | null,
): Promise<
  | { success: true; fileId: string; filename: string | null; publicUrl: string | null; createdAt: string | null; contactId: string }
  | { error: string; errorCode?: "NOT_FOUND" | "MULTIPLE_FOUND"; contactId?: string; count?: number }
> {
  if (!contactId) {
    return { error: "associateContactId is required for action='search'." };
  }

  // ---------- Source A: direct file associations ----------
  const fileIdsFromAssoc: string[] = [];
  {
    const url = `https://api.hubapi.com/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/files`;
    let res: Response;
    try {
      res = await hubspotFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, phase: "file-associations" },
        success: false,
        error: errMsg(err),
      });
      return { error: `HubSpot associations error: ${errMsg(err)}` };
    }
    if (!res.ok) {
      const body = await res.text();
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, phase: "file-associations", httpStatus: res.status },
        success: false,
        error: body.slice(0, 200),
      });
      return { error: `HubSpot associations API ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as { results?: Array<{ toObjectId: string | number }> };
    for (const r of data.results ?? []) {
      fileIdsFromAssoc.push(String(r.toObjectId));
    }
  }

  // ---------- Source B: note engagements with hs_attachment_ids ----------
  const fileIdsFromNotes: string[] = [];
  {
    // B.1 list note associations
    const url = `https://api.hubapi.com/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/notes`;
    let res: Response;
    try {
      res = await hubspotFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, phase: "note-associations" },
        success: false,
        error: errMsg(err),
      });
      return { error: `HubSpot note associations error: ${errMsg(err)}` };
    }
    if (!res.ok) {
      const body = await res.text();
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, phase: "note-associations", httpStatus: res.status },
        success: false,
        error: body.slice(0, 200),
      });
      return { error: `HubSpot note associations API ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as { results?: Array<{ toObjectId: string | number }> };
    const noteIds = (data.results ?? []).map((r) => String(r.toObjectId));

    // B.2 batch-read note properties (only if there are notes)
    if (noteIds.length > 0) {
      let batchRes: Response;
      try {
        batchRes = await hubspotFetch("https://api.hubapi.com/crm/v3/objects/notes/batch/read", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            inputs: noteIds.map((id) => ({ id })),
            properties: ["hs_attachment_ids"],
          }),
        });
      } catch (err) {
        ctx.audit.log({
          action: "hubspot.fileSearch",
          details: { contactId, phase: "notes-batch-read" },
          success: false,
          error: errMsg(err),
        });
        return { error: `HubSpot notes batch read error: ${errMsg(err)}` };
      }
      if (!batchRes.ok) {
        const body = await batchRes.text();
        ctx.audit.log({
          action: "hubspot.fileSearch",
          details: { contactId, phase: "notes-batch-read", httpStatus: batchRes.status },
          success: false,
          error: body.slice(0, 200),
        });
        return { error: `HubSpot notes batch read ${batchRes.status}: ${body.slice(0, 200)}` };
      }
      const batchData = (await batchRes.json()) as {
        results?: Array<{ id: string; properties: Record<string, string | null> }>;
      };
      for (const note of batchData.results ?? []) {
        const csv = note.properties?.hs_attachment_ids;
        if (!csv) continue;
        for (const piece of csv.split(",")) {
          const id = piece.trim();
          if (id) fileIdsFromNotes.push(id);
        }
      }
    }
  }

  // ---------- Union + dedupe ----------
  const uniqueFileIds = Array.from(new Set([...fileIdsFromAssoc, ...fileIdsFromNotes]));

  if (uniqueFileIds.length === 0) {
    ctx.audit.log({
      action: "hubspot.fileSearch",
      details: { contactId, count: 0, viaAssociation: 0, viaNote: 0 },
      success: false,
      error: "NOT_FOUND",
    });
    return {
      error: "No file associated with the contact.",
      errorCode: "NOT_FOUND",
      contactId,
    };
  }

  // ---------- Fetch metadata + filter to PDFs ----------
  type FileMeta = { id: string; name?: string; url?: string; createdAt?: string; extension?: string };
  const pdfs: FileMeta[] = [];
  for (const fileId of uniqueFileIds) {
    const metaUrl = `https://api.hubapi.com/files/v3/files/${encodeURIComponent(fileId)}`;
    let res: Response;
    try {
      res = await hubspotFetch(metaUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, fileId, phase: "file-metadata" },
        success: false,
        error: errMsg(err),
      });
      return { error: `HubSpot file metadata error (${fileId}): ${errMsg(err)}` };
    }
    if (!res.ok) {
      // Skip individual file fetch failures (file may have been deleted but the
      // hs_attachment_ids still references it). Log + continue rather than fail
      // the whole search.
      const body = await res.text();
      ctx.audit.log({
        action: "hubspot.fileSearch",
        details: { contactId, fileId, phase: "file-metadata", httpStatus: res.status },
        success: false,
        error: body.slice(0, 200),
      });
      continue;
    }
    const meta = (await res.json()) as FileMeta;
    if ((meta.extension ?? "").toLowerCase() === "pdf") {
      pdfs.push(meta);
    }
  }

  if (pdfs.length === 0) {
    ctx.audit.log({
      action: "hubspot.fileSearch",
      details: {
        contactId,
        count: 0,
        viaAssociation: fileIdsFromAssoc.length,
        viaNote: fileIdsFromNotes.length,
        totalUnique: uniqueFileIds.length,
      },
      success: false,
      error: "NOT_FOUND",
    });
    return {
      error: "No PDF associated with the contact.",
      errorCode: "NOT_FOUND",
      contactId,
    };
  }

  if (pdfs.length > 1) {
    ctx.audit.log({
      action: "hubspot.fileSearch",
      details: {
        contactId,
        count: pdfs.length,
        viaAssociation: fileIdsFromAssoc.length,
        viaNote: fileIdsFromNotes.length,
      },
      success: false,
      error: "MULTIPLE_FOUND",
    });
    return {
      error: `Found ${pdfs.length} PDFs associated with the contact (expected 1).`,
      errorCode: "MULTIPLE_FOUND",
      contactId,
      count: pdfs.length,
    };
  }

  const meta = pdfs[0];
  const fileId = meta.id;

  ctx.audit.log({
    action: "hubspot.fileSearch",
    details: {
      contactId,
      fileId,
      filename: meta.name,
      viaAssociation: fileIdsFromAssoc.includes(fileId),
      viaNote: fileIdsFromNotes.includes(fileId),
    },
    success: true,
  });

  return {
    success: true,
    fileId: meta.id,
    filename: meta.name ?? null,
    publicUrl: meta.url ?? null,
    createdAt: meta.createdAt ?? null,
    contactId,
  };
}
