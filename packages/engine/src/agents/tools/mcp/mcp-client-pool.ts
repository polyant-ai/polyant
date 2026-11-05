// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { McpServerRecord } from "../../../instances/mcp-servers.store.js";
import type { McpConnection } from "./mcp-connect.js";

/**
 * Reuses MCP connections across turns, for servers whose credentials do not
 * depend on the conversation (auth mode "none" or "static", or "oauth" with the
 * agent's shared account).
 *
 * Without it every turn opened a client per server — initialize, tools/list —
 * and closed it at the end, even when the model called no MCP tool: under
 * concurrent conversations that was the largest cost an MCP server added to a
 * turn. The MCP client multiplexes requests by message id, so concurrent turns
 * can share one.
 *
 * A connection older than MAX_AGE_MS is renewed in the background, so a tool
 * added on the server shows within about that window and no turn waits for the
 * reconnect: the turn that notices the age keeps the current connection, and
 * the turns after the new one opens get it. A renewal that fails drops the
 * current connection too, so the next turn connects in line and meets the
 * failure itself. A changed server record (URL, auth, config) gets a new
 * connection at once, because the fingerprint is part of the entry. A
 * connection that fails a call is dropped and the next turn reconnects.
 *
 * Each turn holds a lease on the connection it took and releases it when it
 * ends. A dropped connection closes as soon as no turn holds it, and after
 * RETIRE_GRACE_MS at the latest. An entry no turn has used for longer than
 * MAX_AGE_MS + RETIRE_GRACE_MS (its server disabled or deleted) is dropped by a
 * periodic sweep, so its client and credentials do not stay in memory until the
 * process restarts.
 *
 * Per-conversation OAuth servers are not pooled: their tokens are bound to a
 * conversation. A shared account is, and its connection reads the tokens
 * through its provider, so a refresh reaches it without a reconnect.
 */
const MAX_AGE_MS = 60_000;
const RETIRE_GRACE_MS = 5 * 60_000;

interface Connection {
  promise: Promise<McpConnection>;
  /** Turns holding a lease on it. */
  users: number;
  dropped: boolean;
  closing?: Promise<void>;
}

interface Entry {
  fingerprint: string;
  createdAt: number;
  current: Connection;
  renewing?: Connection;
}

/** A turn's hold on a pooled connection. */
export interface McpLease {
  connection: Promise<McpConnection>;
  /** Drops the connection from the pool if it is still the server's current one. */
  retire: () => void;
  /** The turn is done with the connection. Idempotent. */
  release: () => void;
}

const pool = new Map<string, Entry>();
/** Dropped connections a turn still holds: closed at shutdown at the latest. */
const held = new Set<Connection>();
let sweepTimer: NodeJS.Timeout | undefined;

function fingerprint(server: McpServerRecord): string {
  // Hashed so the decrypted config (tokens) never sits in memory as a map key.
  return createHash("sha256").update(JSON.stringify([server.url, server.authMode, server.config])).digest("hex");
}

function close(conn: Connection): Promise<void> {
  held.delete(conn);
  conn.closing ??= conn.promise.then((c) => c.client.close()).catch(() => { /* best-effort */ });
  return conn.closing;
}

function drop(conn: Connection): void {
  if (conn.dropped) return;
  conn.dropped = true;
  if (conn.users === 0) {
    void close(conn);
    return;
  }
  held.add(conn);
  setTimeout(() => void close(conn), RETIRE_GRACE_MS).unref();
}

function dropEntry(serverId: string, entry: Entry): void {
  if (pool.get(serverId) !== entry) return;
  pool.delete(serverId);
  drop(entry.current);
  if (entry.renewing) drop(entry.renewing);
}

function open(serverId: string, connect: () => Promise<McpConnection>): Connection {
  const conn: Connection = { promise: connect(), users: 0, dropped: false };
  // A failed connect must not be handed to the next turn.
  conn.promise.catch(() => {
    const entry = pool.get(serverId);
    if (entry?.current === conn || entry?.renewing === conn) dropEntry(serverId, entry);
  });
  return conn;
}

function renew(serverId: string, entry: Entry, connect: () => Promise<McpConnection>): void {
  const next = open(serverId, connect);
  entry.renewing = next;
  next.promise.then(
    () => {
      if (pool.get(serverId) !== entry || entry.renewing !== next) return;
      const previous = entry.current;
      entry.current = next;
      entry.renewing = undefined;
      entry.createdAt = Date.now();
      drop(previous);
    },
    () => { /* `open` dropped the entry */ },
  );
}

function sweep(): void {
  const cutoff = Date.now() - MAX_AGE_MS - RETIRE_GRACE_MS;
  for (const [serverId, entry] of pool) {
    if (entry.createdAt < cutoff && !entry.renewing) dropEntry(serverId, entry);
  }
}

function lease(serverId: string, conn: Connection): McpLease {
  conn.users++;
  let released = false;
  return {
    connection: conn.promise,
    retire: () => {
      const entry = pool.get(serverId);
      if (entry?.current === conn) dropEntry(serverId, entry);
    },
    release: () => {
      if (released) return;
      released = true;
      conn.users--;
      if (conn.dropped && conn.users === 0) void close(conn);
    },
  };
}

/**
 * A lease on the pooled connection for `server`. `connect` opens a new one when
 * there is none or the server record changed, and in the background when the
 * current one is older than MAX_AGE_MS. It is bounded by its own timeout but
 * not by a turn's abort signal: other turns may be waiting on the same connect.
 */
export function acquireMcpConnection(
  server: McpServerRecord,
  connect: () => Promise<McpConnection>,
): McpLease {
  const print = fingerprint(server);
  const current = pool.get(server.id);
  if (current?.fingerprint === print) {
    if (!current.renewing && Date.now() - current.createdAt >= MAX_AGE_MS) renew(server.id, current, connect);
    return lease(server.id, current.current);
  }
  if (current) dropEntry(server.id, current);
  const entry: Entry = { fingerprint: print, createdAt: Date.now(), current: open(server.id, connect) };
  pool.set(server.id, entry);
  if (!sweepTimer) {
    sweepTimer = setInterval(sweep, RETIRE_GRACE_MS);
    sweepTimer.unref();
  }
  return lease(server.id, entry.current);
}

/** Drops the server's pooled connection, if any; a turn still holding it keeps it until it releases. */
export function retireMcpConnection(serverId: string): void {
  const entry = pool.get(serverId);
  if (entry) dropEntry(serverId, entry);
}

/** Closes every connection the pool opened, dropped ones still held included; called at shutdown. */
export async function closeMcpClientPool(): Promise<void> {
  clearInterval(sweepTimer);
  sweepTimer = undefined;
  const conns = [...held];
  for (const entry of pool.values()) {
    conns.push(entry.current);
    if (entry.renewing) conns.push(entry.renewing);
  }
  pool.clear();
  for (const conn of conns) conn.dropped = true;
  await Promise.all(conns.map(close));
}

/** Test seam: how many servers hold a pooled connection. */
export function mcpPoolSize(): number {
  return pool.size;
}
