// SPDX-License-Identifier: AGPL-3.0-or-later

import { getCorsOptions, getLogLevels } from "./main.js";

describe("server/main getCorsOptions", () => {
  it("restricts to localhost allowlist in non-production when no allowlist is configured (#88)", () => {
    expect(getCorsOptions({ NODE_ENV: "development" })).toEqual({
      origin: [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
      ],
      credentials: true,
    });
  });

  it("still honours CORS_ORIGINS in non-production when configured", () => {
    expect(
      getCorsOptions({
        NODE_ENV: "development",
        CORS_ORIGINS: "http://localhost:4321",
      }),
    ).toEqual({
      origin: ["http://localhost:4321"],
      credentials: true,
    });
  });

  it("fails closed in production when no allowlist is configured", () => {
    expect(getCorsOptions({ NODE_ENV: "production" })).toEqual({
      origin: false,
      credentials: false,
    });
  });

  it("uses the configured allowlist when CORS_ORIGINS is set", () => {
    expect(
      getCorsOptions({
        NODE_ENV: "production",
        CORS_ORIGINS: "https://app.example.com, https://admin.example.com ",
      }),
    ).toEqual({
      origin: ["https://app.example.com", "https://admin.example.com"],
      credentials: true,
    });
  });
});

describe("server/main getLogLevels", () => {
  it("keeps the quiet error/warn/log subset in production", () => {
    expect(getLogLevels({ NODE_ENV: "production" })).toEqual(["error", "warn", "log"]);
  });

  it("adds debug/verbose in development", () => {
    expect(getLogLevels({ NODE_ENV: "development" })).toEqual([
      "error",
      "warn",
      "log",
      "debug",
      "verbose",
    ]);
  });

  it("treats unset NODE_ENV as non-production", () => {
    expect(getLogLevels({})).toEqual(["error", "warn", "log", "debug", "verbose"]);
  });
});
