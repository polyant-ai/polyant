#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fake OpenAI endpoint for load tests: speaks the Responses API (streaming and
// non-streaming) and embeddings, with configurable latency, so a load test
// measures the platform and not the model provider.
//   FAKE_TTFB_MS   time before the first token     (default 800)
//   FAKE_TOKENS    output tokens per answer         (default 60)
//   FAKE_TOKEN_MS  delay between tokens             (default 20)
//   FAKE_PORT      listen port                      (default 7070)
import http from "node:http";

const TTFB = Number(process.env.FAKE_TTFB_MS ?? 800);
const TOKENS = Number(process.env.FAKE_TOKENS ?? 60);
const TOKEN_MS = Number(process.env.FAKE_TOKEN_MS ?? 20);
const PORT = Number(process.env.FAKE_PORT ?? 7070);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
let inFlight = 0;
let served = 0;
let toolCalls = 0;
const usage = { input_tokens: 1500, output_tokens: TOKENS, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

// Tool mode: FAKE_TOOLS is an ordered list of substrings of tool names. While
// fewer tool results than entries are in the input, the next matching tool
// offered in the request is called (one call per step); then the text answer.
// FAKE_TOOL_ARGS is a JSON map from substring to the arguments object.
const TOOLS = (process.env.FAKE_TOOLS ?? "").split(",").filter(Boolean);
const TOOL_ARGS = JSON.parse(process.env.FAKE_TOOL_ARGS ?? "{}");
const TOOL_MS = Number(process.env.FAKE_TOOL_DECISION_MS ?? 400);

function nextToolCall(body) {
  if (!TOOLS.length || !Array.isArray(body.tools)) return null;
  const done = (body.input ?? []).filter((i) => i?.type === "function_call_output").length;
  if (done >= TOOLS.length) return null;
  const want = TOOLS[done];
  const tool = body.tools.find((t) => (t.name ?? t.function?.name ?? "").includes(want));
  return tool ? { name: tool.name ?? tool.function.name, args: JSON.stringify(TOOL_ARGS[want] ?? {}) } : null;
}

async function toolCall(res, body, call) {
  const id = `resp_${++seq}`;
  const itemId = `fc_${seq}`;
  const callId = `call_${seq}`;
  const model = body.model ?? "fake";
  const created = Math.floor(Date.now() / 1000);
  const item = { type: "function_call", id: itemId, call_id: callId, name: call.name, arguments: call.args, status: "completed" };
  const u = { ...usage, output_tokens: 20 };
  if (!body.stream) {
    await sleep(TOOL_MS);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, created_at: created, model, status: "completed", output: [item], usage: u }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  let n = 0;
  send({ type: "response.created", sequence_number: n++, response: { id, created_at: created, model } });
  await sleep(TOOL_MS);
  send({ type: "response.output_item.added", sequence_number: n++, output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
  send({ type: "response.function_call_arguments.delta", sequence_number: n++, item_id: itemId, output_index: 0, delta: call.args });
  send({ type: "response.function_call_arguments.done", sequence_number: n++, item_id: itemId, output_index: 0, arguments: call.args });
  send({ type: "response.output_item.done", sequence_number: n++, output_index: 0, item });
  send({ type: "response.completed", sequence_number: n++, response: { id, created_at: created, model, status: "completed", usage: u } });
  res.end("data: [DONE]\n\n");
}

async function responses(req, res, body) {
  const call = nextToolCall(body);
  if (call) { toolCalls++; return toolCall(res, body, call); }
  const id = `resp_${++seq}`;
  const msgId = `msg_${seq}`;
  const model = body.model ?? "fake";
  const created = Math.floor(Date.now() / 1000);
  const words = Array.from({ length: TOKENS }, (_, i) => (i === 0 ? "Risposta" : ` parola${i}`));
  if (!body.stream) {
    await sleep(TTFB + TOKENS * TOKEN_MS);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id, created_at: created, model, status: "completed",
      output: [{ type: "message", role: "assistant", id: msgId, status: "completed",
                 content: [{ type: "output_text", text: words.join(""), annotations: [] }] }],
      usage,
    }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  let n = 0;
  send({ type: "response.created", sequence_number: n++, response: { id, created_at: created, model } });
  await sleep(TTFB);
  send({ type: "response.output_item.added", sequence_number: n++, output_index: 0, item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] } });
  for (const w of words) {
    send({ type: "response.output_text.delta", sequence_number: n++, item_id: msgId, output_index: 0, content_index: 0, delta: w });
    if (TOKEN_MS) await sleep(TOKEN_MS);
  }
  send({ type: "response.output_item.done", sequence_number: n++, output_index: 0, item: { type: "message", id: msgId, role: "assistant", status: "completed", content: [{ type: "output_text", text: words.join(""), annotations: [] }] } });
  send({ type: "response.completed", sequence_number: n++, response: { id, created_at: created, model, status: "completed", usage } });
  res.end("data: [DONE]\n\n");
}

async function embeddings(req, res, body) {
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  const dim = body.dimensions ?? 1536;
  await sleep(50);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    object: "list", model: body.model,
    data: inputs.map((_, index) => ({ object: "embedding", index, embedding: Array.from({ length: dim }, () => Math.random() - 0.5) })),
    usage: { prompt_tokens: 10, total_tokens: 10 },
  }));
}

http.createServer(async (req, res) => {
  inFlight++;
  try {
    if (req.url === "/stats") { res.end(JSON.stringify({ inFlight: inFlight - 1, served, toolCalls })); return; }
    const body = await readBody(req);
    if (req.url.endsWith("/responses")) await responses(req, res, body);
    else if (req.url.endsWith("/embeddings")) await embeddings(req, res, body);
    else { res.writeHead(404); res.end(`{"error":{"message":"fake-llm: ${req.url} not implemented","type":"invalid_request_error","code":"not_found"}}`); }
    served++;
  } finally { inFlight--; }
}).listen(PORT, () => console.log(`fake-llm on :${PORT} ttfb=${TTFB}ms tokens=${TOKENS} tokenMs=${TOKEN_MS}`));
