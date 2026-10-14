// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Vitest global setup file.
 * Sets environment variables BEFORE any module imports execute,
 * preventing config.ts from calling process.exit(1).
 */

// Required: POSTGRES_PASSWORD is the only field without a default
process.env.POSTGRES_PASSWORD ??= "test";

// Sensible defaults for test environment
process.env.API_PORT ??= "4999";

// 64 hex chars = 32 bytes for AES-256
process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Required by config.ts (no default): test value must be ≥32 chars.
// Without this, any test that transitively imports config.ts triggers
// process.exit(1). Set here once so the activity-stream emit-helpers chain
// (which loads instances/store → database/client → config) is safe in tests.
process.env.AUTH_SECRET ??= "test-secret-at-least-32-chars-long-yes";

// Run loggers at the most verbose level so tests can assert on every
// pipelineLog method (incl. debug-gated ones: llmCall, toolCall, etc.).
process.env.LOG_LEVEL ??= "debug";

// bcrypt at the production cost (12) spent seconds of CPU in every file that
// hashes passwords. The minimum cost keeps the hashes real and verifiable;
// password.util.test.ts checks the production cost separately. Imported after
// the env defaults above are set.
const { setPasswordHashCostForTests } = await import("./users/password.util.js");
setPasswordHashCostForTests(4);

// A module, so the top-level await above is allowed.
export {};
