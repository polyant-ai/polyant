// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HookFunctionDefinition } from "../../hooks/hook-types.js";

const mockGetHookRegistry = vi.fn();

vi.mock("../../hooks/hook-registry.js", () => ({
  getHookRegistry: () => mockGetHookRegistry(),
}));

import { HookFunctionsController } from "./hook-functions.controller.js";

/** A definition is only a data carrier here; the handler is never invoked by the catalog. */
const noopHandler = () => ({});

describe("HookFunctionsController.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps the registry to name/description/requiredSecrets/mutatesResponse", () => {
    const mutating: HookFunctionDefinition = {
      name: "acme:notify",
      description: "Posts a notification and may rewrite the reply",
      requiredSecrets: [{ key: "SLACK_TOKEN", type: "text", sensitive: true }],
      mutatesResponse: true,
      handler: noopHandler,
    };
    const plain: HookFunctionDefinition = {
      name: "logTurn",
      description: "Logs the turn",
      requiredSecrets: [],
      handler: noopHandler,
    };

    mockGetHookRegistry.mockReturnValue(
      new Map([
        [mutating.name, mutating],
        [plain.name, plain],
      ]),
    );

    const controller = new HookFunctionsController();
    const result = controller.list();

    expect(result).toEqual({
      hookFunctions: [
        {
          name: "acme:notify",
          description: "Posts a notification and may rewrite the reply",
          requiredSecrets: [{ key: "SLACK_TOKEN", type: "text", sensitive: true }],
          mutatesResponse: true,
        },
        {
          name: "logTurn",
          description: "Logs the turn",
          requiredSecrets: [],
          mutatesResponse: false,
        },
      ],
    });
  });

  it("returns an empty list when no hook functions are registered", () => {
    mockGetHookRegistry.mockReturnValue(new Map());
    expect(new HookFunctionsController().list()).toEqual({ hookFunctions: [] });
  });
});
