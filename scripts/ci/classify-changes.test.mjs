// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { API_FILE_LIMIT, classify, isDockerInput, isDocumentation, isPanelInput } from "./classify-changes.mjs";

test("documentation-only changes skip code and Docker jobs", () => {
  assert.deepEqual(
    classify(["docs/plugins.md", "README.md", "CONTRIBUTING.md", ".claude/skills/release/SKILL.md", ".github/PULL_REQUEST_TEMPLATE.md"]),
    { code: false, docker: false, panel: false },
  );
});

test("markdown that a build or test reads counts as code", () => {
  for (const file of [
    "CHANGELOG.md",
    "CLAUDE.md",
    "AGENTS.md",
    ".claude/rules/engine.md",
    "packages/engine/tests/guardrails/SKILL.md",
    "examples/skills/weather/SKILL.md",
  ]) {
    assert.equal(isDocumentation(file), false, file);
    assert.deepEqual(classify([file]).code, true, file);
  }
});

test("non-markdown files under .claude are documentation, but not its rules", () => {
  assert.equal(isDocumentation(".claude/settings.json"), true);
  assert.equal(isDocumentation(".claude/hooks/pre-commit-check.js"), true);
});

test("a source change alongside docs runs the code jobs", () => {
  assert.deepEqual(classify(["docs/plugins.md", "packages/engine/src/index.ts"]), { code: true, docker: false, panel: true });
});

test("Docker inputs are recognised", () => {
  for (const file of [
    "Dockerfile.engine",
    "Dockerfile.web",
    ".dockerignore",
    "docker-entrypoint.sh",
    "package.json",
    "package-lock.json",
    "packages/web/package.json",
    "packages/engine/tsconfig.build.json",
    "packages/engine/tsconfig.json",
    "packages/engine/scripts/copy-migrations.mjs",
    "packages/web/next.config.ts",
    "packages/web/scripts/generate-changelog.ts",
    "scripts/collect-plugin-system-requirements.mjs",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(isDockerInput(file), true, file);
  }
  for (const file of ["packages/engine/src/index.ts", "packages/web/src/app/page.tsx", "docs/Dockerfile.md", "infra/package.json"]) {
    assert.equal(isDockerInput(file), false, file);
  }
});

test("the panel suites run when a page could change", () => {
  for (const file of [
    "packages/web/src/app/page.tsx",
    "packages/web/e2e/a11y/a11y.spec.ts",
    "packages/engine/src/server/main.ts",
    "package-lock.json",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(isPanelInput(file), true, file);
  }
  for (const file of ["packages/voice/src/index.ts", "scripts/ci/pr-check.mjs", "docs/plugins.md", ".github/workflows/e2e.yml"]) {
    assert.equal(isPanelInput(file), false, file);
  }
});

test("an unknown change set runs everything", () => {
  assert.deepEqual(classify([]), { code: true, docker: true, panel: true });
  assert.deepEqual(classify(["", "  "]), { code: true, docker: true, panel: true });
  assert.deepEqual(classify(Array.from({ length: API_FILE_LIMIT }, (_, i) => `docs/page-${i}.md`)), {
    code: true,
    docker: true,
    panel: true,
  });
});
