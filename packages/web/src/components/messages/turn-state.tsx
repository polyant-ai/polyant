// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

/**
 * TurnState
 *
 * The conversation state the model saw on one turn, laid out as labelled
 * fields instead of the single-line JSON the prompt carries.
 *
 * The source is the captured request itself: the engine appends a `<context>`
 * block to the turn's user message, and `<conversation_state>` inside it holds
 * the state as the model read it (server-owned `_` keys already filtered out).
 * Reading it from there, and not from the live state store, is what makes it
 * the state of THIS turn: the store keeps only the latest snapshot.
 */

import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";

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

/** `appointment_date` / `appointmentDate` → "Appointment date". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function isPlainObject(value: unknown): value is State {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

function Scalar({ value }: { value: unknown }) {
  const { t } = useI18n();
  const fmt = useFormat();
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "boolean") return <>{value ? t("message.debug.stateYes") : t("message.debug.stateNo")}</>;
  if (typeof value === "number") return <span className="tabular-nums">{fmt.number(value)}</span>;
  // A date-only string stays as written: parsing it as UTC midnight would show
  // the day before west of Greenwich.
  if (typeof value === "string" && ISO_DATETIME.test(value)) {
    return <span title={value}>{fmt.dateTime(value)}</span>;
  }
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}

function Value({ value }: { value: unknown }) {
  if (isPlainObject(value)) {
    return Object.keys(value).length === 0 ? <Scalar value={null} /> : <Fields state={value} nested />;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <Scalar value={null} />;
    if (value.every(isScalar)) {
      return (
        <ul className="flex flex-wrap gap-1">
          {value.map((item, i) => (
            <li key={i} className="rounded border bg-muted/30 px-1.5 py-0.5">
              <Scalar value={item} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <ol className="flex flex-col gap-2">
        {value.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
            <div className="min-w-0 flex-1">
              <Value value={item} />
            </div>
          </li>
        ))}
      </ol>
    );
  }
  return <Scalar value={value} />;
}

function Fields({ state, nested = false }: { state: State; nested?: boolean }) {
  return (
    <dl className={nested ? "flex flex-col gap-1.5 border-l pl-3" : "flex flex-col"}>
      {Object.entries(state).map(([key, value]) => {
        const block = !isScalar(value) && !(Array.isArray(value) && value.every(isScalar));
        return (
          <div
            key={key}
            className={
              block
                ? "flex flex-col gap-1.5 py-1.5" + (nested ? "" : " border-t first:border-t-0")
                : "grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 py-1.5" + (nested ? "" : " border-t first:border-t-0")
            }
          >
            <dt className="text-muted-foreground" title={key}>
              {humanizeKey(key)}
            </dt>
            <dd className="min-w-0">
              <Value value={value} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function TurnState({ state }: { state: State }) {
  return (
    <div className="rounded-md border px-3 py-1 text-xs">
      <Fields state={state} />
    </div>
  );
}
