// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkGate, parseJobs, readJob } from "./check-ci-gate.mjs";

const workflow = (gate) => `name: CI
on: [push]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
  test:
    needs: lint
    runs-on: ubuntu-latest
${gate}
`;

test("a gate that needs every job and always runs passes", () => {
  const gate = `  ci:
    name: CI
    needs: [lint, test]
    if: always()
    runs-on: ubuntu-latest`;
  assert.deepEqual(checkGate(workflow(gate)), []);
});

test("block-list needs are read", () => {
  const gate = `  ci:
    needs:
      - lint
      - test
    if: \${{ always() }}`;
  assert.deepEqual(checkGate(workflow(gate)), []);
});

test("a job missing from the gate's needs is reported", () => {
  const gate = `  ci:
    needs: [lint]
    if: always()`;
  assert.deepEqual(checkGate(workflow(gate)), ["the gate does not need: test"]);
});

test("a gate that does not always run is reported", () => {
  const gate = `  ci:
    needs: [lint, test]`;
  assert.deepEqual(checkGate(workflow(gate)), ["the gate must run with `if: always()`"]);
});

test("needs naming a job that does not exist are reported", () => {
  const gate = `  ci:
    needs: [lint, test, build]
    if: always()`;
  assert.deepEqual(checkGate(workflow(gate)), ["the gate needs jobs that do not exist: build"]);
});

test("job ids stop at the next top-level key and ignore nested keys", () => {
  const jobs = parseJobs(`${workflow("  ci:\n    needs: [lint, test]\n    if: always()")}\nenv:\n  other: 1\n`);
  assert.deepEqual([...jobs.keys()], ["lint", "test", "ci"]);
  assert.deepEqual(readJob(jobs.get("test")).needs, ["lint"]);
});

test("the repository's ci.yml passes", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  assert.deepEqual(checkGate(readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8")), []);
});
