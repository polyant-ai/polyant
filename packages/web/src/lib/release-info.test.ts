// SPDX-License-Identifier: AGPL-3.0-or-later

import { buildReleaseInfo } from "./release-info";

describe("buildReleaseInfo", () => {
  it("builds public release links and shortens a revision", () => {
    expect(buildReleaseInfo({ version: "1.0.0", revision: "e2ee14da8928" })).toEqual({
      version: "1.0.0",
      revision: "e2ee14d",
      releaseUrl: "https://github.com/polyant-ai/polyant/releases/tag/v1.0.0",
      repositoryUrl: "https://github.com/polyant-ai/polyant",
      sdkUrl: "https://github.com/polyant-ai/polyant-sdk",
    });
  });

  it("uses null when no revision is available", () => {
    expect(buildReleaseInfo({ version: "1.0.0" }).revision).toBeNull();
  });
});
