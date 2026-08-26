// SPDX-License-Identifier: AGPL-3.0-or-later

export type AudioReplyReason =
  | "too_long"
  | "too_large"
  | "unsupported_format"
  | "provider_error"
  | "timeout"
  | "empty_transcript"
  | "stt_disabled";

const EN: Record<AudioReplyReason, string> = {
  too_long: "The audio is too long. Please send a shorter one (max 60 seconds).",
  too_large: "The audio is too large. Please send a shorter one (max 10 MB).",
  unsupported_format: "Unsupported audio format. Please type your message instead.",
  provider_error: "I couldn't understand the audio. Could you type your message?",
  timeout: "I couldn't understand the audio. Could you type your message?",
  empty_transcript: "I didn't get any clear audio. Please try again or type your message.",
  stt_disabled: "Voice messages are not supported. Please type your message instead.",
};

export function audioReply(reason: AudioReplyReason, _language: string = "en"): string {
  // English by default; the language argument is reserved for future i18n.
  return EN[reason];
}
