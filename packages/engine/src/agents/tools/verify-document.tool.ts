// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { chat } from "../../ai-gateway/index.js";
import { errMsg } from "../../utils/error.js";

const SYSTEM_PROMPT =
  "You are a document verification assistant. " +
  "Analyze the provided image and respond EXCLUSIVELY with a valid JSON object (no other text) " +
  "with the following structure:\n" +
  "{\n" +
  '  "isBill": boolean,              // true if the document is a utility bill (residential/commercial)\n' +
  '  "readabilityScore": number,     // 0-100: how readable it is (focus, resolution, occlusions, angle)\n' +
  '  "billType": string | null,      // "electricity", "gas", "water", "phone", or null if not a bill\n' +
  '  "confidence": number,           // 0-1: classification confidence\n' +
  '  "reason": string                // brief explanation (1-2 sentences)\n' +
  "}\n" +
  "Assess readability considering: image sharpness, reflections or shadows, " +
  "shooting angle, document completeness (cropped edges), text legibility.";

const USER_PROMPT = "Verify this document: is it a utility bill? How readable is it?";

const RESULT_SCHEMA = z.object({
  isBill: z.boolean(),
  readabilityScore: z.number().min(0).max(100),
  billType: z.enum(["electricity", "gas", "water", "phone"]).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
});

export default defineTool({
  name: "verifyDocument",
  description:
    "Verify whether an attached image or document is a utility bill and assess its readability.\n" +
    "Use when the user sends an image or PDF and you need to confirm it is a bill before proceeding.\n" +
    "Does not extract structured data (amount, due date) — the supervisor reads the image directly for that.\n" +
    "Requires an attachment in the current message. Pass `attachmentIndex` to select which attachment to verify.\n" +
    "Returns isBill, readabilityScore (0-100), billType, confidence, and reason.",
  category: "document",
  inputExamples: [
    { label: "Verify first attachment", input: { attachmentIndex: 0 } },
  ],
  parameters: z.object({
    attachmentIndex: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Index of the attachment to verify (0-based, default 0)"),
  }),
  execute: async ({ attachmentIndex: attachmentIndexInput }: { attachmentIndex: number | null }, ctx) => {
      const attachmentIndex = attachmentIndexInput ?? 0;
      // Read attachment from context
      const attachment = ctx.attachments?.[attachmentIndex];
      if (!attachment) {
        return { error: `No attachment found at index ${attachmentIndex}.` };
      }
      if (!attachment.data) {
        return { error: `Attachment at index ${attachmentIndex} has no binary data.` };
      }

      const isImage = attachment.type === "image" || attachment.mimeType?.startsWith("image/");
      const isPdf = attachment.mimeType === "application/pdf";
      if (!isImage && !isPdf) {
        return {
          error: `Unsupported attachment type: ${attachment.mimeType ?? attachment.type}. Supported types: images and PDF.`,
        };
      }

      try {
        // Build multimodal message for the LLM
        const contentParts: Array<
          | { type: "text"; text: string }
          | { type: "image"; image: Buffer; mimeType?: string }
          | { type: "file"; data: Buffer; mimeType: string }
        > = [{ type: "text", text: USER_PROMPT }];

        if (isImage) {
          contentParts.push({
            type: "image",
            image: attachment.data,
            mimeType: attachment.mimeType,
          });
        } else {
          contentParts.push({
            type: "file",
            data: attachment.data,
            mimeType: attachment.mimeType ?? "application/pdf",
          });
        }

        const response = await chat(
          {
            tier: "fast",
            provider: ctx.provider,
            apiKeys: ctx.apiKeys,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: contentParts as never }],
          },
          {
            conversationId: ctx.conversationId,
            instanceId: ctx.instanceId,
            callType: "service",
          },
        );

        // Parse LLM response as JSON
        const rawText = response.text.trim();
        // Strip possible markdown code fences
        const jsonText = rawText.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");

        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          ctx.audit.log({
            action: "document.verifyDocument",
            details: { attachmentIndex, rawResponse: rawText.slice(0, 200) },
            success: false,
            error: "Malformed JSON from LLM",
          });
          return { error: "Unable to parse document: invalid LLM response.", raw: rawText };
        }

        // Validate shape
        const validated = RESULT_SCHEMA.safeParse(parsed);
        if (!validated.success) {
          ctx.audit.log({
            action: "document.verifyDocument",
            details: { attachmentIndex, parsed },
            success: false,
            error: "Invalid response shape",
          });
          return { error: "LLM response has an invalid structure.", raw: parsed };
        }

        ctx.audit.log({
          action: "document.verifyDocument",
          details: {
            attachmentIndex,
            isBill: validated.data.isBill,
            billType: validated.data.billType,
            readabilityScore: validated.data.readabilityScore,
            confidence: validated.data.confidence,
          },
          success: true,
        });

        // Persist the verdict in conversation state so a later turn can read the
        // outcome without re-running the check (text-only history would drop it).
        ctx.state?.set("lastVerifiedDocument", {
          isBill: validated.data.isBill,
          readabilityScore: validated.data.readabilityScore,
          billType: validated.data.billType,
          confidence: validated.data.confidence,
        });

        return validated.data;
      } catch (err) {
        const message = errMsg(err);
        console.error(`verifyDocument tool error: ${message}`);
        ctx.audit.log({
          action: "document.verifyDocument",
          details: { attachmentIndex },
          success: false,
          error: message,
        });
        return { error: message };
      }
    },
});
