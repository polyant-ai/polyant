// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import MarkdownIt from "markdown-it";
import puppeteer, { type Browser } from "puppeteer";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { errMsg } from "../../utils/error.js";
import { pdfHandleStore } from "./pdf-handle-store.js";
import { config } from "../../config.js";

const MAX_MARKDOWN_LENGTH = 100_000;
const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Counting semaphore — caps how many puppeteer renders run in parallel inside
 * the singleton Chromium browser. Each render uses one page (~50-100MB RSS),
 * so unbounded parallelism would OOM the engine under a burst of webhooks.
 *
 * Zero-deps implementation: `acquire()` returns immediately if a permit is
 * free, otherwise the caller is parked in `waiters` and woken by `release()`.
 * Permits never leak as long as callers wrap their critical section in
 * try/finally (the file does this around `generatePdfBuffer`).
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];
  private readonly capacity: number;

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore permits must be a positive integer (got ${permits})`);
    }
    this.permits = permits;
    this.capacity = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    if (this.permits < this.capacity) {
      this.permits++;
    }
  }

  /** Snapshot of current state — for observability/tests. */
  stats(): { available: number; capacity: number; waiting: number } {
    return { available: this.permits, capacity: this.capacity, waiting: this.waiters.length };
  }
}

const pdfSemaphore = new Semaphore(config.pdf.concurrency);

/** Test hook — do not use in application code. */
export const _internals = { pdfSemaphore };

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
});

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // In container builds we install Chromium via the OS package manager and
    // skip Puppeteer's bundled download. PUPPETEER_EXECUTABLE_PATH points at
    // the system binary. In dev (no env var) Puppeteer launches the Chromium
    // it downloaded into node_modules.
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    browserPromise = puppeteer
      .launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

const PDF_CSS = `
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #111;
    line-height: 1.55;
    font-size: 11pt;
    margin: 0;
    padding: 0;
  }
  h1 { font-size: 22pt; margin: 0 0 0.4em; line-height: 1.2; }
  h2 { font-size: 16pt; margin: 1em 0 0.4em; line-height: 1.25; }
  h3 { font-size: 13pt; margin: 0.9em 0 0.3em; }
  h4, h5, h6 { font-size: 11pt; margin: 0.8em 0 0.2em; }
  p { margin: 0 0 0.8em; }
  ul, ol { margin: 0 0 0.8em 1.2em; padding: 0; }
  li { margin: 0.15em 0; }
  table { width: 100%; border-collapse: collapse; margin: 0.6em 0 1em; font-size: 10pt; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-weight: 600; }
  code { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 10pt; background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }
  pre { background: #f4f4f4; padding: 10px 12px; border-radius: 4px; overflow-x: auto; font-size: 9.5pt; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #ccc; margin: 0 0 0.8em; padding: 0.2em 0.9em; color: #555; }
  a { color: #0a58ca; text-decoration: none; }
  hr { border: none; border-top: 1px solid #ddd; margin: 1.2em 0; }
  img { max-width: 100%; }
  .pdf-header-logo { text-align: right; margin: 0 0 1.2em; }
  .pdf-header-logo img { display: inline-block; max-height: 60px; max-width: 220px; width: auto; height: auto; object-fit: contain; }
`;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Process-wide cache of fetched header images, keyed by URL → data: URI.
// Inlining the image as base64 means Chromium never has to do a network
// fetch from inside the container — important on hosts where outbound HTTPS
// from the headless browser is unreliable (corporate firewalls, DNS issues,
// missing CA roots inside the Chromium sandbox). 80 PDFs in a burst → 1 HTTP
// fetch total.
const headerImageCache = new Map<string, string>();
const HEADER_IMAGE_FETCH_TIMEOUT_MS = 10_000;

async function resolveHeaderImage(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  const cached = headerImageCache.get(url);
  if (cached) return cached;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEADER_IMAGE_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[markdownToPdf] header image fetch failed: HTTP ${res.status} for ${url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = (res.headers.get("content-type") ?? "image/png").split(";")[0].trim();
    const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
    headerImageCache.set(url, dataUri);
    return dataUri;
  } catch (err) {
    console.warn(`[markdownToPdf] header image fetch failed: ${errMsg(err)} for ${url}`);
    return null;
  }
}

function renderHtml(markdown: string, headerImageSrc?: string): string {
  const body = md.render(markdown);
  const logoBlock = headerImageSrc
    ? `<div class="pdf-header-logo"><img src="${escapeAttr(headerImageSrc)}" alt="logo" /></div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PDF_CSS}</style></head><body>${logoBlock}${body}</body></html>`;
}

async function generatePdfBuffer(markdown: string, headerImageUrl?: string): Promise<Buffer> {
  const headerImageSrc = headerImageUrl ? await resolveHeaderImage(headerImageUrl) : null;
  if (headerImageUrl && !headerImageSrc) {
    console.warn(`[markdownToPdf] proceeding without header image — fetch failed: ${headerImageUrl}`);
  }

  await pdfSemaphore.acquire();
  const stats = pdfSemaphore.stats();
  if (stats.waiting > 0) {
    console.log(`[markdownToPdf] render starting — capacity=${stats.capacity} available=${stats.available} queued=${stats.waiting}`);
  }
  let page: Awaited<ReturnType<Browser["newPage"]>> | undefined;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    const html = renderHtml(markdown, headerImageSrc ?? undefined);
    await page.setContent(html, { waitUntil: "load", timeout: 20_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", right: "18mm", bottom: "20mm", left: "18mm" },
    });
    return Buffer.from(pdf);
  } finally {
    if (page) await page.close().catch(() => undefined);
    pdfSemaphore.release();
  }
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim().replace(/\.pdf$/i, "");
  const safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (safe || "document").slice(0, 120) + ".pdf";
}

export default defineTool({
  name: "markdownToPdf",
  description:
    "Generate an A4 PDF from Markdown content.\n" +
    "Accepts GFM-style tables, lists, code blocks, links, images, blockquotes.\n" +
    "Optionally accepts headerImageUrl: a public https:// URL (e.g. a company logo) rendered as the FIRST element of the document, right-aligned, before the Markdown content. Visible on the first page.\n" +
    "Returns an opaque pdfHandle (valid for 10 minutes) consumable by a follow-up tool (e.g. fileUpload, hubspotFile) to avoid passing the binary between tool calls.\n" +
    "Input limit: 100KB of markdown. Output limit: 10MB.",
  category: "document",
  inputExamples: [
    {
      label: "Quote summary",
      input: {
        markdown: "# Quote no. 2026-001\n\n**Customer:** Jane Doe\n\n| Item | Amount |\n|---|---|\n| Service A | $100 |\n| Service B | $250 |\n\n**Total: $350**",
        filename: "quote-2026-001",
        headerImageUrl: null,
      },
    },
    {
      label: "Proposal with company logo in the header",
      input: {
        markdown: "# Proposal\n\nDear Customer,\n\nplease find the proposal attached.",
        filename: "customer-proposal",
        headerImageUrl: "https://cdn.example.com/logo.png",
      },
    },
  ],
  parameters: z.object({
    markdown: z
      .string()
      .min(1)
      .describe("Markdown content to convert to PDF. Supports GFM (tables, code blocks)."),
    filename: z
      .string()
      .min(1)
      .describe("Desired file name without extension (e.g. 'customer-proposal'). The .pdf extension is added automatically. Unsafe characters are replaced with '-'."),
    headerImageUrl: z
      .string()
      .nullable()
      .describe("Optional: public HTTPS URL of an image (e.g. a company logo) shown as the first element of the document, right-aligned, before the Markdown content. Visible on the first page. Must start with https://. If null, no logo."),
  }),
  execute: async (
    params: {
      markdown: string;
      filename: string;
      headerImageUrl: string | null;
    },
    _ctx,
  ) => {
    if (params.markdown.length > MAX_MARKDOWN_LENGTH) {
      return {
        error: `Markdown too long: ${params.markdown.length} characters (max ${MAX_MARKDOWN_LENGTH}).`,
      };
    }
    if (params.headerImageUrl && !/^https:\/\//.test(params.headerImageUrl)) {
      return { error: "headerImageUrl must be an absolute https:// URL." };
    }

    try {
      const buffer = await generatePdfBuffer(params.markdown, params.headerImageUrl ?? undefined);

      if (buffer.length > MAX_PDF_SIZE_BYTES) {
        return {
          error: `Generated PDF too large: ${buffer.length} bytes (max ${MAX_PDF_SIZE_BYTES}).`,
        };
      }

      const filename = sanitizeFilename(params.filename);
      const pdfHandle = pdfHandleStore.put(buffer, filename, "application/pdf");

      return {
        success: true,
        pdfHandle,
        filename,
        sizeBytes: buffer.length,
        message: "PDF generated. Use pdfHandle in a follow-up tool (e.g. fileUpload, hubspotFile) to persist it.",
      };
    } catch (err) {
      return { error: `PDF generation error: ${errMsg(err)}` };
    }
  },
});
