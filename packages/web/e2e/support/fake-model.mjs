// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A fake OpenAI model for the turn suite: a tiny HTTP server that speaks the
 * part of the Responses API (`POST /v1/responses`) the engine's `openai`
 * provider uses, streamed and not. The engine reaches it through
 * `OPENAI_BASE_URL`, so a turn runs through the real engine and web with no
 * provider and no key.
 *
 * It answers by what the request is, never by chance:
 *
 * - a request with tools whose last input item is not a tool result is the
 *   first step of a turn: it writes STEP_TEXT and calls TOOL_NAME with
 *   TOOL_ARGS, in one response;
 * - a request whose last input item is a `function_call_output` is the step
 *   after the tool ran: it writes FINAL_TEXT;
 * - any other request (a conversation title, a summary) gets SERVICE_TEXT.
 *
 * It also answers `POST /v1/embeddings`, which the agent's `openai` embedder
 * reaches through the same `OPENAI_BASE_URL`: one vector per input text, of the
 * length the request asks for, derived from the text so the same text always
 * gets the same vector. That lets a knowledge document be indexed to the end.
 *
 * `GET /__calls` lists what it received, so a test can see the tool's result
 * come back to the model. Run: `node fake-model.mjs <port>`.
 */

import { createServer } from "node:http";

const STEP_TEXT = "Checking the turn probe skill before I answer.";
const FINAL_TEXT = "The turn probe skill is not installed, so this answer comes from the fake model.";
const SERVICE_TEXT = "Turn probe conversation";
const TOOL_NAME = "readSkill";
const TOOL_ARGS = { name: "e2e-turn-probe" };

/** @type {Array<Record<string, unknown>>} */
const calls = [];
let sequence = 0;

/** The user-written texts of a Responses API `input`. */
function userTexts(input) {
  if (typeof input === "string") return [input];
  if (!Array.isArray(input)) return [];
  const texts = [];
  for (const item of input) {
    if (item?.role !== "user") continue;
    if (typeof item.content === "string") texts.push(item.content);
    else if (Array.isArray(item.content)) {
      for (const part of item.content) if (typeof part?.text === "string") texts.push(part.text);
    }
  }
  return texts;
}

function classify(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  const last = input[input.length - 1];
  const toolNames = Array.isArray(body.tools) ? body.tools.map((t) => t?.name).filter(Boolean) : [];
  if (last?.type === "function_call_output") return { kind: "final", toolNames };
  if (toolNames.includes(TOOL_NAME)) return { kind: "first", toolNames };
  return { kind: "service", toolNames };
}

/** The output items of the answer, complete (as a non-streamed response carries them). */
function outputItems(kind, id) {
  const message = (text) => ({
    type: "message",
    id: `msg_${id}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
  if (kind === "first") {
    return [
      message(STEP_TEXT),
      {
        type: "function_call",
        id: `fc_${id}`,
        call_id: `call_${id}`,
        name: TOOL_NAME,
        arguments: JSON.stringify(TOOL_ARGS),
        status: "completed",
      },
    ];
  }
  return [message(kind === "final" ? FINAL_TEXT : SERVICE_TEXT)];
}

const usage = { input_tokens: 120, output_tokens: 24, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

function respondJson(res, body, kind, id) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `resp_${id}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: body.model ?? "fake",
      status: "completed",
      output: outputItems(kind, id),
      usage,
    }),
  );
}

function respondStream(res, body, kind, id) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const response = { id: `resp_${id}`, created_at: Math.floor(Date.now() / 1000), model: body.model ?? "fake" };
  send({ type: "response.created", response });
  outputItems(kind, id).forEach((item, index) => {
    if (item.type === "message") {
      send({ type: "response.output_item.added", output_index: index, item: { type: "message", id: item.id } });
      // Two deltas, so the client really assembles the text from a stream.
      const text = item.content[0].text;
      const cut = Math.floor(text.length / 2);
      for (const delta of [text.slice(0, cut), text.slice(cut)]) {
        send({ type: "response.output_text.delta", item_id: item.id, output_index: index, delta });
      }
      send({ type: "response.output_item.done", output_index: index, item: { type: "message", id: item.id } });
    } else {
      send({ type: "response.output_item.added", output_index: index, item: { ...item, arguments: "", status: undefined } });
      send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: index, delta: item.arguments });
      send({ type: "response.output_item.done", output_index: index, item });
    }
  });
  send({ type: "response.completed", response: { ...response, status: "completed", usage } });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** A unit vector of `dimensions` numbers, the same for the same text. */
function vectorFor(text, dimensions) {
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.codePointAt(0)) >>> 0;
  const values = [];
  for (let i = 0; i < dimensions; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    values.push(seed / 0xffffffff - 0.5);
  }
  const norm = Math.hypot(...values) || 1;
  return values.map((v) => v / norm);
}

function respondEmbeddings(res, body) {
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  const dimensions = Number.isInteger(body.dimensions) ? body.dimensions : 1536;
  const tokens = inputs.reduce((sum, text) => sum + String(text).split(/\s+/).length, 0);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      object: "list",
      data: inputs.map((text, index) => ({ object: "embedding", index, embedding: vectorFor(String(text), dimensions) })),
      model: body.model ?? "fake",
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    }),
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  if (req.method === "GET" && url.pathname === "/__calls") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ calls }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/responses") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid JSON", type: "invalid_request_error", code: "bad_json" } }));
      return;
    }
    sequence += 1;
    const id = `e2e${sequence}`;
    const { kind, toolNames } = classify(body);
    const input = Array.isArray(body.input) ? body.input : [];
    calls.push({
      id,
      kind,
      stream: body.stream === true,
      model: body.model,
      toolNames,
      userTexts: userTexts(body.input),
      functionCallOutputs: input
        .filter((item) => item?.type === "function_call_output")
        .map((item) => ({ callId: item.call_id, output: item.output })),
    });
    if (body.stream === true) respondStream(res, body, kind, id);
    else respondJson(res, body, kind, id);
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/embeddings") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid JSON", type: "invalid_request_error", code: "bad_json" } }));
      return;
    }
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    calls.push({ id: `emb${calls.length + 1}`, kind: "embeddings", model: body.model, dimensions: body.dimensions, inputs: inputs.map(String) });
    respondEmbeddings(res, body);
    return;
  }
  // Anything else is not something a suite here needs.
  calls.push({ id: `other${calls.length + 1}`, kind: "unsupported", method: req.method, path: url.pathname });
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `fake model: ${req.method} ${url.pathname} not supported`, type: "invalid_request_error", code: "not_found" } }));
});

const port = Number(process.argv[2] ?? process.env.FAKE_MODEL_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: node fake-model.mjs <port>");
  process.exit(1);
}
server.listen(port, "127.0.0.1", () => console.log(`[fake-model] listening on http://127.0.0.1:${port}/v1`));
