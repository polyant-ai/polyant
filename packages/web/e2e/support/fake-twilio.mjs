// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A fake Twilio for the channel turn: a tiny HTTP server that takes the
 * requests the engine's WhatsApp channel makes to Twilio. The engine reaches it
 * through `TWILIO_API_BASE_URL`, which sends every Twilio host to this origin
 * with the path kept, so a WhatsApp reply is captured here instead of going
 * out.
 *
 * - `POST /2010-04-01/Accounts/{AccountSid}/Messages.json` (a message sent):
 *   recorded with its form fields and the account it authenticated as, and
 *   answered 201 with a queued message, as Twilio does;
 * - `POST /v2/Indicators/Typing.json` (the typing indicator): recorded, 200;
 * - `GET /__requests` lists what it received.
 *
 * Run: `node fake-twilio.mjs <port>`.
 */

import { createServer } from "node:http";

/** @type {Array<Record<string, unknown>>} */
const requests = [];
let sequence = 0;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The user name of a Basic `Authorization` header (the account or API key SID). */
function basicUser(header) {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return undefined;
  return Buffer.from(header.slice(6), "base64").toString("utf8").split(":")[0];
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const MESSAGES_PATH = /^\/2010-04-01\/Accounts\/(AC[0-9a-fA-F]{32})\/Messages\.json$/;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  if (req.method === "GET" && url.pathname === "/__requests") {
    json(res, 200, { requests });
    return;
  }
  const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
  const auth = basicUser(req.headers.authorization);

  const message = req.method === "POST" ? MESSAGES_PATH.exec(url.pathname) : null;
  if (message) {
    sequence += 1;
    const sid = `SM${String(sequence).padStart(32, "0")}`;
    requests.push({ kind: "message", sid, accountSid: message[1], auth, to: form.To, from: form.From, body: form.Body });
    const now = new Date().toUTCString();
    json(res, 201, {
      sid,
      account_sid: message[1],
      to: form.To,
      from: form.From,
      body: form.Body,
      status: "queued",
      direction: "outbound-api",
      num_segments: "1",
      num_media: "0",
      date_created: now,
      date_updated: now,
      api_version: "2010-04-01",
      uri: `/2010-04-01/Accounts/${message[1]}/Messages/${sid}.json`,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/v2/Indicators/Typing.json") {
    requests.push({ kind: "typing", auth, messageId: form.messageId, channel: form.channel });
    json(res, 200, { success: true });
    return;
  }
  // Anything else is a Twilio call the channel turn does not expect.
  requests.push({ kind: "unsupported", method: req.method, path: url.pathname });
  json(res, 404, { code: 20404, message: `fake twilio: ${req.method} ${url.pathname} not supported`, status: 404 });
});

const port = Number(process.argv[2] ?? process.env.FAKE_TWILIO_PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: node fake-twilio.mjs <port>");
  process.exit(1);
}
server.listen(port, "127.0.0.1", () => console.log(`[fake-twilio] listening on http://127.0.0.1:${port}`));
