// SPDX-License-Identifier: AGPL-3.0-or-later

const REPOSITORY_URL = "https://github.com/polyant-ai/polyant";
const SDK_URL = "https://github.com/polyant-ai/polyant-sdk";

export interface ReleaseInfo {
  version: string;
  revision: string | null;
  releaseUrl: string;
  repositoryUrl: string;
  sdkUrl: string;
}

export function buildReleaseInfo({
  version,
  revision,
}: {
  version: string;
  revision?: string;
}): ReleaseInfo {
  return {
    version,
    revision: revision ? revision.slice(0, 7) : null,
    releaseUrl: `${REPOSITORY_URL}/releases/tag/v${version}`,
    repositoryUrl: REPOSITORY_URL,
    sdkUrl: SDK_URL,
  };
}

export const releaseInfo = buildReleaseInfo({
  version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0-dev",
  revision: process.env.NEXT_PUBLIC_APP_REVISION,
});
