// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Rewrite the Drizzle schema snapshot after a hand-written migration changed the
 * schema files (see src/database/schema-snapshot.ts).
 *
 * Usage: npm run db:snapshot
 */

import { writeSchemaSnapshot } from "../src/database/schema-snapshot.js";

// CLI entry-point: console output is intentional.
console.log(`Wrote src/database/migrations/meta/${await writeSchemaSnapshot()}`);
process.exit(0);
