// SPDX-License-Identifier: AGPL-3.0-or-later

// `import type`, not a value import: this module is imported by every
// per-domain importer, and a value import of `db` would make each of them
// transitively open the database client at module load the day
// `verbatimModuleSyntax` is enabled — which would break any unit test that
// imports a domain module and hands it a fake `tx`.
import type { db } from "../database/client.js";

export interface ImportWarning {
  type:
    | "missing_skill"
    | "missing_tool"
    | "secret_required"
    | "channel_credentials"
    | "skill_env_required"
    | "event_source_credentials"
    | "mcp_server_credentials"
    | "mcp_server_invalid";
  message: string;
}

export interface ImportResult {
  slug: string;
  instanceId: string;
  warnings: ImportWarning[];
}

/** The transaction client every per-domain importer below runs inside. */
export type TxClient = Parameters<Parameters<typeof db.transaction>[0]>[0];
