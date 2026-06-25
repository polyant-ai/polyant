// SPDX-License-Identifier: AGPL-3.0-or-later

export type OptoutStatus = "opted_out" | "opted_in";

/** Per-instance opt-out configuration (resolved from the agents row). */
export interface OptoutConfig {
  enabled: boolean;
  stopKeywords: string[];
  resumeKeywords: string[];
  closingMessage: string | null;
  resumeMessage: string | null;
  injectPromptHint: boolean;
}

/** The action the inbound gate must take for the current message. */
export type OptoutAction =
  | { kind: "stop"; reply: string | null }
  | { kind: "resume"; reply: string | null }
  | { kind: "blocked_silent" }
  | { kind: "pass" };
