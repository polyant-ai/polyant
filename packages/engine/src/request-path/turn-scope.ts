// SPDX-License-Identifier: AGPL-3.0-or-later

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who asked the model, when the agent's own loop did not: a hook run or a tool
 * run. The gateway records it on the call's `ai_logs` row so the request path
 * can nest the call under the run that made it.
 */
export type TurnOrigin =
  | { kind: "hook"; name: string; runId: string }
  | { kind: "tool"; name: string; toolCallId: string };

/**
 * The turn a piece of work belongs to: the id of the assistant message the turn
 * persists, whether the agent captures raw model exchanges, and the hook or
 * tool run in progress, if any.
 *
 * It is entered only at boundaries the engine controls (the message handlers,
 * a hook run, a tool run, the post-response tail), never relied on across a
 * stream a caller consumes: the agent's own model calls carry the message id
 * explicitly.
 */
export interface TurnScope {
  messageId: string;
  /** The agent's debug flag, known once its configuration is read. */
  debug: boolean;
  origin?: TurnOrigin;
}

const storage = new AsyncLocalStorage<TurnScope>();

export function runInTurn<T>(scope: TurnScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Run `fn` as the given hook or tool run of the current turn; outside a turn, just run it. */
export function runAs<T>(origin: TurnOrigin, fn: () => T): T {
  const scope = storage.getStore();
  return scope ? storage.run({ ...scope, origin }, fn) : fn();
}

export function currentTurn(): TurnScope | undefined {
  return storage.getStore();
}
