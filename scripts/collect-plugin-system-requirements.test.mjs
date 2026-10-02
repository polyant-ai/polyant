// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The collector's outputs become install arguments and a file the container
 * entrypoint sources, so what it lets through runs as part of every boot. These
 * run the script as the Docker stage does and source its env.sh with sh.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./collect-plugin-system-requirements.mjs", import.meta.url));

async function withPlugins(manifests, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-system-"));
  try {
    const pluginsDir = path.join(root, "plugins");
    for (const [name, manifest] of Object.entries(manifests)) {
      await mkdir(path.join(pluginsDir, name), { recursive: true });
      await writeFile(path.join(pluginsDir, name, "plugin.json"), JSON.stringify(manifest));
    }
    const outDir = path.join(root, "out");
    const run = spawnSync(process.execPath, [SCRIPT, pluginsDir, outDir], { encoding: "utf8" });
    await fn({ run, outDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Source env.sh in a clean shell holding `preset`, and read back `names`. */
function sourceEnv(outDir, preset, names) {
  const script = `. "${path.join(outDir, "env.sh")}"; ${names.map((n) => `printf '%s\\0' "\${${n}-<unset>}"`).join("; ")}`;
  const out = execFileSync("/bin/sh", ["-c", script], { env: { PATH: process.env.PATH, ...preset }, encoding: "utf8" });
  return Object.fromEntries(out.split("\0").slice(0, names.length).map((v, i) => [names[i], v]));
}

test("lists every plugin's packages once, sorted", async () => {
  await withPlugins(
    {
      a: { system: { apk: ["chromium", "nss"], npmGlobal: ["@scope/tool"] } },
      b: { system: { apk: ["nss", "freetype"] } },
    },
    async ({ run, outDir }) => {
      assert.equal(run.status, 0, run.stderr);
      assert.equal(await readFile(path.join(outDir, "apk.txt"), "utf8"), "chromium\nfreetype\nnss\n");
      assert.equal(await readFile(path.join(outDir, "npm-global.txt"), "utf8"), "@scope/tool\n");
    },
  );
});

test("refuses a package name that would become a second install argument or an option", async () => {
  for (const pkg of ["chromium nss", "-flag", "pkg;rm", "@scope"]) {
    await withPlugins({ bad: { system: { apk: [pkg] } } }, async ({ run }) => {
      assert.equal(run.status, 1);
      assert.match(run.stderr, /invalid apk package name/);
    });
  }
  for (const pkg of ["tool --unsafe-perm", "--global-style", "@-scope/x"]) {
    await withPlugins({ bad: { system: { npmGlobal: [pkg] } } }, async ({ run }) => {
      assert.equal(run.status, 1);
      assert.match(run.stderr, /invalid npm package name/);
    });
  }
});

test("a plugin's env value is a default the operator's environment overrides", async () => {
  await withPlugins(
    { pdf: { system: { env: { PUPPETEER_EXECUTABLE_PATH: "/usr/bin/chromium", TRUST_PROXY: "true" } } } },
    async ({ run, outDir }) => {
      assert.equal(run.status, 0, run.stderr);
      const names = ["PUPPETEER_EXECUTABLE_PATH", "TRUST_PROXY"];
      assert.deepEqual(sourceEnv(outDir, {}, names), {
        PUPPETEER_EXECUTABLE_PATH: "/usr/bin/chromium",
        TRUST_PROXY: "true",
      });
      // Set by the operator, even to empty: the plugin's value never wins.
      assert.deepEqual(sourceEnv(outDir, { TRUST_PROXY: "false", PUPPETEER_EXECUTABLE_PATH: "" }, names), {
        PUPPETEER_EXECUTABLE_PATH: "",
        TRUST_PROXY: "false",
      });
    },
  );
});

test("an env value reaches the shell verbatim, quotes and expansions included", async () => {
  const value = `it's $HOME and \`id\` "quoted"`;
  await withPlugins({ odd: { system: { env: { ODD_VALUE: value } } } }, async ({ run, outDir }) => {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(sourceEnv(outDir, {}, ["ODD_VALUE"]), { ODD_VALUE: value });
  });
});

test("refuses an env key the shell would read as code", async () => {
  await withPlugins({ bad: { system: { env: { "X;id": "1" } } } }, async ({ run }) => {
    assert.equal(run.status, 1);
    assert.match(run.stderr, /invalid env key/);
  });
});

test("refuses two plugins that set one variable to different values", async () => {
  await withPlugins(
    { a: { system: { env: { SHARED: "one" } } }, b: { system: { env: { SHARED: "two" } } } },
    async ({ run }) => {
      assert.equal(run.status, 1);
      assert.match(run.stderr, /env SHARED conflicts/);
    },
  );
});

test("writes empty outputs when no plugin is present", async () => {
  await withPlugins({}, async ({ run, outDir }) => {
    assert.equal(run.status, 0, run.stderr);
    for (const file of ["apk.txt", "npm-global.txt", "env.sh"]) {
      assert.equal(await readFile(path.join(outDir, file), "utf8"), "");
    }
  });
});
