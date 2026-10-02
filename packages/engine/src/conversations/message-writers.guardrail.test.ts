// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Only ConversationStore writes conversation_messages rows.
 *
 * The conversation carries its own message counters (message_count,
 * user_message_count, last_message_at), and the conversation list and the
 * analytics read them instead of counting. ConversationStore keeps them in the
 * same statements that insert or remove messages. A row inserted anywhere else
 * would be invisible to every count: no error, just numbers that are quietly
 * short. This test finds every insert into the table in the engine's source
 * and fails when one sits outside conversations/store.ts.
 *
 * Deleting a whole conversation's messages together with the conversation row
 * (agent deletion, retention purge) leaves no counter to keep, so deletes are
 * not checked.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "conversations/store.ts";
const WRITE = /\.insert\(\s*conversationMessages\s*\)|INSERT\s+INTO\s+"?conversation_messages"?/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("conversation_messages writers", () => {
  const writers = sourceFiles(SRC)
    .filter((file) => WRITE.test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file));

  it("finds the owner's own inserts, so the scan is looking at real code", () => {
    expect(writers).toContain(OWNER);
  });

  it("inserts messages only through ConversationStore, which keeps the counters", () => {
    expect(writers.filter((file) => file !== OWNER)).toEqual([]);
  });
});
