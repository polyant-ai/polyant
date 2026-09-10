// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { databaseSslFromEnv, databaseUrlFromEnv } from "./db-url";

describe("databaseUrlFromEnv", () => {
  it("should_return_DATABASE_URL_verbatim_when_set", () => {
    expect(databaseUrlFromEnv({ DATABASE_URL: "postgresql://u:p@h:1/d", POSTGRES_HOST: "ignored" }))
      .toBe("postgresql://u:p@h:1/d");
  });

  it("should_assemble_from_POSTGRES_parts_when_no_url", () => {
    expect(databaseUrlFromEnv({
      POSTGRES_USER: "svc", POSTGRES_PASSWORD: "pw",
      POSTGRES_HOST: "db.internal", POSTGRES_PORT: "6543", POSTGRES_DB: "polyant",
    })).toBe("postgresql://svc:pw@db.internal:6543/polyant");
  });

  it("should_default_every_part_for_a_local_docker_setup", () => {
    expect(databaseUrlFromEnv({})).toBe("postgresql://polyant:@localhost:5432/polyant");
  });

  it("should_percent_encode_credentials_so_a_special_character_cannot_move_the_host", () => {
    // Raw interpolation made this parse as host "evil.example" — the `@` in the
    // password ended the userinfo early.
    const url = databaseUrlFromEnv({ POSTGRES_PASSWORD: "p@s/w", POSTGRES_HOST: "db.internal" });

    expect(url).toBe("postgresql://polyant:p%40s%2Fw@db.internal:5432/polyant");
    expect(new URL(url).hostname).toBe("db.internal");
  });

  it("should_use_the_postgresql_scheme_the_engine_uses", () => {
    expect(databaseUrlFromEnv({})).toMatch(/^postgresql:\/\//);
  });
});

describe("databaseSslFromEnv", () => {
  it("should_enable_tls_only_for_the_literal_true", () => {
    expect(databaseSslFromEnv({ POSTGRES_SSL: "true" })).toEqual({ rejectUnauthorized: false });
    for (const value of ["false", "1", "yes", "TRUE", ""]) {
      expect(databaseSslFromEnv({ POSTGRES_SSL: value }), value).toBe(false);
    }
    expect(databaseSslFromEnv({})).toBe(false);
  });
});
