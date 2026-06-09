// SPDX-License-Identifier: AGPL-3.0-or-later

import { db } from "../database/client.js";
import { sql } from "drizzle-orm";
import { memoryLog } from "./memory-logger.js";

/** Status of the pgvector extension after init — surfaced in the boot summary. */
export type PgvectorStatus = "initialised" | "degraded";

/** Initialize the memory layer: verify pgvector extension is available. */
export async function initMemory(): Promise<PgvectorStatus> {
  try {
    const result = await db.execute(
      sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
    );
    if ((result as unknown[]).length === 0) {
      memoryLog.warn("Memory", "pgvector extension not found — run migrations: npm run db:migrate");
      return "degraded";
    }
    memoryLog.info("Memory", "Memory layer initialized (pgvector)");
    return "initialised";
  } catch (err) {
    memoryLog.warn("Memory", `Memory layer init failed: ${err instanceof Error ? err.message : String(err)}`);
    return "degraded";
  }
}

// --- Re-exports ---
export { hybridSearch } from "./hybrid-search.js";
export type { HybridSearchResult } from "./hybrid-search.js";

export { extractMemories } from "./extractor.js";

export {
  getAllMemories,
  deleteMemoryForInstance,
  deleteAllMemories,
  searchByVector,
  upsertMemory,
} from "./memory-store.js";
export type { MemoryRecord, UpsertResult } from "./memory-store.js";

export type { Memory, MemoryUpsertResult, ExtractedFact } from "./types.js";
