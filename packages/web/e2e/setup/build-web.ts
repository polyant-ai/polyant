// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Builds the web for the harness, ahead of a run: the same `npm run build`
 * Playwright's web server would run, with the same environment
 * (buildWebEnv), so `E2E_PREBUILT=1` then only starts it. CI builds once here
 * and hands the build to every panel shard.
 *
 * Run: `npm run build:e2e` in the web package, with the E2E_* ports of the runs
 * that will use the build.
 */

import { spawnSync } from "node:child_process";
import { buildWebEnv, WEB_PACKAGE_ROOT } from "./test-env";

const result = spawnSync("npm", ["run", "build"], { cwd: WEB_PACKAGE_ROOT, env: buildWebEnv(), stdio: "inherit" });
process.exit(result.status ?? 1);
