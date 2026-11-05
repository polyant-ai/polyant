// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * First setup file of the unit project, which shares worker threads between
 * test files (`isolate: false`). Vitest re-runs setup files before every file,
 * so this gives each file the state an isolated worker would have given it:
 *
 * - every engine module is evaluated again, which empties module-level
 *   registries and re-reads constants taken from `process.env` at load time.
 *   Packages in node_modules stay loaded, which is where the time is saved;
 * - real timers, unstubbed env and globals, and `process.env` as it was before
 *   the first file of this worker ran.
 */

import { vi } from "vitest";

const holder = globalThis as { __envBeforeFirstTestFile?: Record<string, string | undefined> };

if (holder.__envBeforeFirstTestFile === undefined) {
  holder.__envBeforeFirstTestFile = { ...process.env };
} else {
  const initial = holder.__envBeforeFirstTestFile;
  for (const key of Object.keys(process.env)) {
    if (!(key in initial)) delete process.env[key];
  }
  Object.assign(process.env, initial);
}

vi.resetModules();
vi.useRealTimers();
vi.unstubAllEnvs();
vi.unstubAllGlobals();
