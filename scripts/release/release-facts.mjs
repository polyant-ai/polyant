// ---------------------------------------------------------------------------
// The product facts a release depends on
// ---------------------------------------------------------------------------
//
// The values a release restates — the product name, the repository, which
// manifests carry the version and which Docker stages repeat it — live here
// rather than as literals spread through the scripts, so the preparer, the
// auditor and the verifier cannot disagree about them.

/** @typedef {{ productName: string, repositoryUrl: string,
 *              engineWorkspace: string, manifests: string[], lockfileRoots: string[],
 *              dockerStubs: { file: string, package: string }[] }} ReleaseFacts */

/** @type {ReleaseFacts} */
export const releaseFacts = {
  productName: "Polyant",

  repositoryUrl: "https://github.com/polyant-ai/polyant",
  engineWorkspace: "@polyant/engine",

  /** Every manifest that must carry the identical version (the verifier checks all four). */
  manifests: [
    "package.json",
    "packages/engine/package.json",
    "packages/web/package.json",
    "infra/package.json",
  ],

  /** Directories holding a package-lock.json that has to follow its manifest. */
  lockfileRoots: [".", "infra"],

  /**
   * Docker stages write a minimal package.json for the workspace they do NOT
   * build, so npm can resolve the workspace graph. Each restates the version,
   * and nothing verifies them — on this repository they sat at 1.0.0 while the
   * manifests said 1.1.0.
   */
  dockerStubs: [
    { file: "Dockerfile.engine", package: "@polyant/web" },
    { file: "Dockerfile.web", package: "@polyant/engine" },
  ],

};

const SEMVER_CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A release version: plain SemVer core, with no prerelease or build suffix. */
export function isValidReleaseVersion(version) {
  return typeof version === "string" && SEMVER_CORE.test(version);
}

/** The exact first line of `docs/releases/v<version>.md`, which the verifier compares byte for byte. */
export function releaseNoteHeading(version, facts = releaseFacts) {
  return `# ${facts.productName} v${version}`;
}
