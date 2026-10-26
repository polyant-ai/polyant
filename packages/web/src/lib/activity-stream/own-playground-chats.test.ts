// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";
import { isOwnPlaygroundConversation, rememberPlaygroundChat } from "./own-playground-chats";

describe("own playground chats", () => {
  test("recognises the conversation of a chat this tab started", () => {
    rememberPlaygroundChat("abc-123");
    expect(isOwnPlaygroundConversation("support:web:api-abc-123")).toBe(true);
  });

  test("does not recognise another chat or a missing id", () => {
    rememberPlaygroundChat("abc-123");
    expect(isOwnPlaygroundConversation("support:web:api-other")).toBe(false);
    expect(isOwnPlaygroundConversation(undefined)).toBe(false);
  });
});
