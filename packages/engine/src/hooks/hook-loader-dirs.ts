// SPDX-License-Identifier: AGPL-3.0-or-later

import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * Directory where core `*.hook.(ts|js)` files live: `src/hooks/functions/`
 * (sibling of this file). Extracted behind a function so the loader test can
 * mock it (point at a temp fixture dir) instead of stubbing `import.meta.url`.
 */
export function getCoreHooksDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "functions");
}
