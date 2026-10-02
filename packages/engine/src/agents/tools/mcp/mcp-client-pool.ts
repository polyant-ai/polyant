// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { McpServerRecord } from "../../../instances/mcp-servers.store.js";
import { connectWithTimeout, type McpConnection, type McpTransport } from "./mcp-connect.js";

/**
 * Reuses MCP connections across turns, for servers whose credentials do not
 * depend on the conversation (auth mode "none" or "static").
 *
 * Without it every turn opened a client per server — initialize, tools/list —
 * and closed it at the end, even when the model called no MCP tool: under
 * concurrent conversations that was the largest cost an MCP server added to a
 * turn. The MCP client multiplexes requests by message id, so concurrent turns
 * can share one.
 *
 * A connection serves at most MAX_AGE_MS, so a tool added on the server shows
 * within that window; a changed server record (URL, auth, config) gets a new
 * connection at once, because the fingerprint is part of the entry. A
 * connection that fails a call is dropped (`retire`) and the next turn
 * reconnects. A dropped connection is closed only after RETIRE_GRACE_MS: a turn
 * that took it a moment earlier may still be using it.
 *
 * OAuth servers are not pooled: their tokens are bound to a conversation.
 */
const MAX_AGE_MS = 60_000;
const RETIRE_GRACE_MS = 5 * 60_000;

interface Entry {
  fingerprint: string;
  createdAt: number;
  connection: Promise<McpConnection>;
}

const pool = new Map<string, Entry>();

function fingerprint(server: McpServerRecord): string {
  // Hashed so the decrypted config (tokens) never sits in memory as a map key.
  return createHash("sha256").update(JSON.stringify([server.url, server.authMode, server.config])).digest("hex");
}

function closeLater(connection: Promise<McpConnection>): void {
  const timer = setTimeout(() => {
    connection.then((c) => c.client.close()).catch(() => { /* best-effort */ });
  }, RETIRE_GRACE_MS);
  timer.unref();
}

/** Drops the server's pooled connection if it is still `connection`. */
export function retireMcpConnection(serverId: string, connection: Promise<McpConnection>): void {
  const entry = pool.get(serverId);
  if (entry?.connection !== connection) return;
  pool.delete(serverId);
  closeLater(connection);
}

/**
 * The pooled connection for `server`, opening one when there is none, it is
 * older than MAX_AGE_MS, or the server record changed. The connect is bounded
 * by `timeoutMs` but not by a turn's abort signal: other turns may be waiting
 * on the same connect.
 */
export function acquireMcpConnection(
  server: McpServerRecord,
  transport: McpTransport,
  timeoutMs: number,
): Promise<McpConnection> {
  const print = fingerprint(server);
  const current = pool.get(server.id);
  if (current && current.fingerprint === print && Date.now() - current.createdAt < MAX_AGE_MS) {
    return current.connection;
  }
  if (current) {
    pool.delete(server.id);
    closeLater(current.connection);
  }
  const connection = connectWithTimeout(transport, timeoutMs);
  pool.set(server.id, { fingerprint: print, createdAt: Date.now(), connection });
  // A failed connect must not be handed to the next turn.
  connection.catch(() => retireMcpConnection(server.id, connection));
  return connection;
}

/** Closes every pooled connection; called at shutdown. */
export async function closeMcpClientPool(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.allSettled(entries.map((e) => e.connection.then((c) => c.client.close())));
}

/** Test seam: how many servers hold a pooled connection. */
export function mcpPoolSize(): number {
  return pool.size;
}
