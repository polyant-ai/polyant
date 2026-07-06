// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fixture-dir loading test for the hook function loader (mirrors the tool
 * loader). A temp core-hooks dir holds two `*.hook.ts` files — one a valid
 * `HookFunctionDefinition` (has a `handler`), one an object without a handler —
 * and `loadAllHooks()` is pointed at it by mocking the core-hooks dir + plugin
 * roots. Proves: discovery + `export default` collection of a real hook def, and
 * skip-with-warning for a default export lacking a `handler`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("./hook-loader-dirs.js", () => ({ getCoreHooksDir: vi.fn() }));
vi.mock("../plugin-system/plugin-roots.js", () => ({ resolvePluginRoots: vi.fn(() => []) }));

import { getCoreHooksDir } from "./hook-loader-dirs.js";
import { resolvePluginRoots } from "../plugin-system/plugin-roots.js";
import { loadAllHooks } from "./hook-loader.js";
import { getHookRegistry, _resetHookRegistryForTests } from "./hook-registry.js";

const VALID_HOOK = `// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineHook } from "@polyant-ai/plugin-sdk";
export default defineHook({
  name: "greet",
  description: "fixture greet hook",
  handler: async () => ({ injectContext: "hi" }),
});
`;

// A default export that is NOT a HookFunctionDefinition (no handler) → skipped.
const NO_HANDLER = `// SPDX-License-Identifier: AGPL-3.0-or-later
export default { name: "broken", description: "no handler" };
`;

let tmp: string;

describe("hook loader (fixture dir)", () => {
  beforeEach(() => {
    _resetHookRegistryForTests();
    vi.clearAllMocks();
    tmp = mkdtempSync(join(tmpdir(), "polyant-hooks-"));
    vi.mocked(getCoreHooksDir).mockReturnValue(tmp);
    vi.mocked(resolvePluginRoots).mockReturnValue([]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registers a HookFunctionDefinition default-exported from a *.hook.ts", async () => {
    writeFileSync(join(tmp, "greet.hook.ts"), VALID_HOOK);

    await loadAllHooks();

    const def = getHookRegistry().get("greet");
    expect(def).toBeDefined();
    expect(typeof def!.handler).toBe("function");
    expect(await def!.handler({} as never)).toEqual({ injectContext: "hi" });
  });

  it("skips a *.hook.ts whose default export lacks a handler (with a warning)", async () => {
    writeFileSync(join(tmp, "broken.hook.ts"), NO_HANDLER);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await loadAllHooks();

    expect(getHookRegistry().has("broken")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken.hook.ts"));
    warn.mockRestore();
  });
});
