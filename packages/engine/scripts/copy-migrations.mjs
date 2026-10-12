// SPDX-License-Identifier: AGPL-3.0-or-later

// tsc emits only JS, but the compiled migrator (dist/database/migrate.js) looks
// for its SQL and meta/_journal.json beside itself. Run after tsc.
import { cpSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "src/database/migrations");
const to = resolve(root, "dist/database/migrations");

rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`Copied migrations to ${to}`);
