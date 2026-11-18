// ---------------------------------------------------------------------------
// The product facts a release depends on
// ---------------------------------------------------------------------------
//
// The values a release restates — the product name, the repository and which
// manifests carry the version — live here
// rather than as literals spread through the scripts, so the preparer, the
// auditor and the verifier cannot disagree about them.

/** @typedef {{ productName: string, repositoryUrl: string,
 *              engineWorkspace: string, manifests: string[],
 *              unversionedManifests: string[], lockfileRoots: string[] }} ReleaseFacts */

/** @type {ReleaseFacts} */
export const releaseFacts = {
  productName: "Polyant",

  repositoryUrl: "https://github.com/polyant-ai/polyant",
  engineWorkspace: "@polyant/engine",

  /**
   * The manifests that carry the release version. Only the repository root:
   * every other copy of the number was one more file in each release diff, and
   * one more place for it to drift.
   */
  manifests: ["package.json"],

  /**
   * Manifests that must declare NO version. None of these packages is
   * published to npm, and the code that needs the version reads the root
   * manifest, so a version here could only be a stale copy. The verifier
   * refuses one.
   */
  unversionedManifests: [
    "packages/engine/package.json",
    "packages/web/package.json",
    "infra/package.json",
  ],

  /** Directories holding a package-lock.json that has to follow its manifest. */
  lockfileRoots: ["."],
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
