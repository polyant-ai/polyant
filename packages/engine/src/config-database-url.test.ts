// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The engine's half of the connection-string rule. The panel keeps its own copy
 * in `packages/web/src/lib/db-url.ts` — it imports nothing from the engine — and
 * these two suites assert the SAME answers, which is what stops the copies from
 * drifting the way the scheme once did (`postgres://` there, `postgresql://` here).
 */

import { describe, expect, it } from "vitest";
import { buildDatabaseUrl } from "./config.js";

describe("buildDatabaseUrl", () => {
  it("should_return_DATABASE_URL_verbatim_when_set", () => {
    expect(buildDatabaseUrl({ DATABASE_URL: "postgresql://u:p@h:1/d", POSTGRES_HOST: "ignored" }))
      .toBe("postgresql://u:p@h:1/d");
  });

  it("should_assemble_from_POSTGRES_parts_when_no_url", () => {
    expect(buildDatabaseUrl({
      POSTGRES_USER: "svc", POSTGRES_PASSWORD: "pw",
      POSTGRES_HOST: "db.internal", POSTGRES_PORT: "6543", POSTGRES_DB: "polyant",
    })).toBe("postgresql://svc:pw@db.internal:6543/polyant");
  });

  it("should_default_every_part_for_a_local_docker_setup", () => {
    expect(buildDatabaseUrl({})).toBe("postgresql://polyant:@localhost:5432/polyant");
  });

  it("should_percent_encode_credentials_so_a_special_character_cannot_move_the_host", () => {
    const url = buildDatabaseUrl({ POSTGRES_PASSWORD: "p@s/w", POSTGRES_HOST: "db.internal" });

    expect(url).toBe("postgresql://polyant:p%40s%2Fw@db.internal:5432/polyant");
    expect(new URL(url).hostname).toBe("db.internal");
  });
});
