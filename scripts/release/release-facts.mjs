// ---------------------------------------------------------------------------
// The product facts a release depends on — the ONE place the two builds differ
// ---------------------------------------------------------------------------
//
// Polyant ships as two products from two repositories that share almost all of
// this tooling: the OSS build releases `X.Y.Z`, the Enterprise build releases
// `X.Y.Z-ee` under a different product name and package scope. Everything else
// about a release — which manifests carry the version, which Docker stages
// restate it, what the verifier insists on — is identical.
//
// Keeping those few differing VALUES here, rather than spread through the
// scripts as literals, is what makes the OSS -> Enterprise merge a change to one
// file instead of a conflict in every one of them. Before this module the
// verifier alone diverged in three places, each maintained by hand on every
// merge.
//
// When porting to the Enterprise build, this file is the diff:
//   productName:   "Polyant Enterprise"
//   versionSuffix: "-ee"
//   repositoryUrl: ".../polyant-enterprise"
//   engineWorkspace / dockerStubs[].package: the @polyant-enterprise scope

/** @typedef {{ productName: string, versionSuffix: string | null, repositoryUrl: string,
 *              engineWorkspace: string, manifests: string[], lockfileRoots: string[],
 *              dockerStubs: { file: string, package: string }[],
 *              generatedArtefacts: { script: string, files: string[] } | null }} ReleaseFacts */

/** @type {ReleaseFacts} */
export const releaseFacts = {
  productName: "Polyant",

  /**
   * The edition marker every release version of this build must carry, or
   * `null` where versions are plain SemVer. It is NOT a prerelease: it names
   * the edition, which is why `plugin-manifest.ts` compares major.minor.patch
   * alone rather than letting semver rank it below its own release.
   */
  versionSuffix: null,

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

  /**
   * Generated files that restate the engine version, and the workspace script
   * that rewrites them — or `null` where this build generates none.
   *
   * The Enterprise build commits an API contract (`api-index.md` +
   * `openapi.json`) whose header carries the version; this build has neither the
   * artefacts nor the script. Naming it here rather than assuming it is why
   * `release:prepare` does not fail on the build that has nothing to generate.
   */
  generatedArtefacts: null,
};

const SEMVER_CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The release version this build accepts: SemVer core plus the declared edition suffix, if any. */
export function isValidReleaseVersion(version, facts = releaseFacts) {
  if (typeof version !== "string") return false;
  const suffix = facts.versionSuffix;
  if (suffix) {
    if (!version.endsWith(suffix)) return false;
    return SEMVER_CORE.test(version.slice(0, -suffix.length));
  }
  return SEMVER_CORE.test(version);
}

/** The exact first line of `docs/releases/v<version>.md`, which the verifier compares byte for byte. */
export function releaseNoteHeading(version, facts = releaseFacts) {
  return `# ${facts.productName} v${version}`;
}
