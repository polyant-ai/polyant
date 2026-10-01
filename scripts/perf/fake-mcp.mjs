#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal MCP server over streamable HTTP (JSON responses) for load tests.
//   MCP_TOOLS        number of tools advertised        (default 8)
//   MCP_INIT_MS      latency of initialize             (default 50)
//   MCP_LIST_MS      latency of tools/list             (default 30)
//   MCP_CALL_MS      latency of tools/call             (default 150)
//   MCP_PORT         listen port                       (default 7171)
// GET /stats reports counters: initialize, list and call requests served.
import http from "node:http";
import { randomUUID } from "node:crypto";

const N = Number(process.env.MCP_TOOLS ?? 8);
const INIT = Number(process.env.MCP_INIT_MS ?? 50);
const LIST = Number(process.env.MCP_LIST_MS ?? 30);
const CALL = Number(process.env.MCP_CALL_MS ?? 150);
const PORT = Number(process.env.MCP_PORT ?? 7171);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = { initialize: 0, list: 0, call: 0, other: 0 };

const tools = Array.from({ length: N }, (_, i) => ({
  name: i === 0 ? "lookup_order" : `tool_${i}`,
  description: i === 0 ? "Look up an order by its number" : `Synthetic tool ${i}`,
  inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: [] },
}));

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      stats.initialize++; await sleep(INIT);
      return { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1.0.0" } };
    case "tools/list":
      stats.list++; await sleep(LIST);
      return { tools };
    case "tools/call":
      stats.call++; await sleep(CALL);
      return { content: [{ type: "text", text: JSON.stringify({ order: msg.params?.arguments?.orderId ?? "A-1", status: "shipped", eta: "Friday" }) }] };
    default:
      stats.other++;
      return {};
  }
}

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/stats") { res.end(JSON.stringify(stats)); return; }
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", async () => {
    const msg = JSON.parse(data || "{}");
    const session = req.headers["mcp-session-id"] ?? randomUUID();
    if (msg.id === undefined) { res.writeHead(202, { "mcp-session-id": session }); res.end(); return; }
    const result = await handle(msg);
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": session });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
}).listen(PORT, () => console.log(`fake-mcp on :${PORT} tools=${N} init=${INIT}ms list=${LIST}ms call=${CALL}ms`));
