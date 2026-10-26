// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation state the model saw on one turn, read back out of the
 * single-line JSON the prompt carries.
 *
 * The source is the captured request itself: the engine appends a `<context>`
 * block to the turn's user message, and `<conversation_state>` inside it holds
 * the state as the model read it (server-owned `_` keys already filtered out).
 * Reading it from there, and not from the live state store, is what makes it
 * the state of THIS turn: the store keeps only the latest snapshot.
 */

type State = Record<string, unknown>;

const STATE_BLOCK = /<conversation_state>([\s\S]*?)<\/conversation_state>/;

/** The text of a user message, whether it was sent as a string or as content parts. */
function userTexts(message: unknown): string[] {
  if (!message || typeof message !== "object") return [];
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "user") return [];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    part && typeof part === "object" && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : [],
  );
}

/**
 * The state from the last user message that carries one, or null when the turn
 * had none (state-in-prompt off, empty store) or the block does not parse.
 * Earlier user messages are history and may carry an older state.
 */
export function extractTurnState(messages: unknown[]): State | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const text of userTexts(messages[i])) {
      const match = STATE_BLOCK.exec(text);
      if (!match) continue;
      try {
        const parsed: unknown = JSON.parse(match[1]);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as State) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}
