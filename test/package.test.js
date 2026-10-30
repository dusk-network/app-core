import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
/** The JS entry points, each with its declarations. */
const ENTRIES = ["./history"];
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** @param {string} file */
const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("the package", () => {
  it("is an ES module under MPL-2.0 whose one runtime dependency, the networks' rules, is pinned exactly", () => {
    assert.equal(pkg.name, "@dusk-network/app-core");
    assert.equal(pkg.type, "module");
    assert.equal(pkg.license, "MPL-2.0");
    assert.deepEqual(pkg.dependencies, { "@dusk-network/networks": "0.3.0" });
    assert.equal(pkg.devDependencies, undefined);

    const lock = JSON.parse(source("package-lock.json"));

    assert.equal(lock.packages["node_modules/@dusk-network/networks"].version, "0.3.0");
  });

  it("exports each entry point with its types", async () => {
    assert.deepEqual(Object.keys(pkg.exports), [...ENTRIES, "./package.json"]);

    for (const [entry, target] of Object.entries(pkg.exports)) {
      for (const path of typeof target === "string" ? [target] : Object.values(target)) {
        assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${entry}: ${path}`);
      }
    }

    for (const entry of ENTRIES) assert.match(pkg.exports[entry].types, /\.d\.ts$/);

    // The package resolves itself by its own name, as an app would.
    const { createArchive, createHistory, historyArchiveUrl, parseHistoryEntry } = await import("@dusk-network/app-core/history");

    assert.equal(typeof createArchive, "function");
    assert.equal(typeof createHistory, "function");
    assert.equal(historyArchiveUrl({ nodeUrl: "https://testnet.nodes.dusk.network" }), "https://testnet.nodes.dusk.network");
    assert.equal(parseHistoryEntry("x", null), null);
  });

  it("is the same package on JSR, as @dusk/app-core, with the same entry points", () => {
    const jsr = JSON.parse(source("jsr.json"));
    /** @type {Record<string, string>} */
    const npmExports = {};

    for (const [entry, target] of Object.entries(pkg.exports)) {
      if (entry !== "./package.json") npmExports[entry] = typeof target === "string" ? target : target.default;
    }

    assert.equal(jsr.name, "@dusk/app-core");
    assert.equal(jsr.version, pkg.version);
    assert.equal(jsr.license, pkg.license);
    assert.deepEqual(jsr.exports, npmExports);
    assert.deepEqual(
      [...jsr.publish.include].sort(),
      [...pkg.files.map((/** @type {string} */ f) => f.replace(/\/$/, "")), "LICENSE", "README.md"].sort()
    );
  });

  it("gives JSR the declarations npm uses, for each JS entry point", () => {
    for (const entry of ENTRIES) {
      const { default: file, types } = pkg.exports[entry];

      assert.equal(source(file).split("\n")[0], `/* @ts-self-types="./${types.split("/").pop()}" */`, entry);
    }
  });

  it("runs in an extension's service worker and older browsers: no page, no browser storage, no code loaded at runtime", () => {
    for (const entry of ENTRIES) {
      // The code, without its comments.
      const code = source(pkg.exports[entry].default)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      // The page's globals (a sync's `window` is its span of blocks), and browser storage.
      assert.doesNotMatch(code, /(?<![\w$.])(?:window|document|chrome|browser)\s*[.[]/, entry);
      assert.doesNotMatch(code, /\b(?:localStorage|sessionStorage|indexedDB)\b/, entry);
      assert.doesNotMatch(code, /\bimport\s*\(/, entry);
      assert.doesNotMatch(code, /^await\b/m, entry);
      // Nor a lookbehind, which older Safari can't parse.
      assert.doesNotMatch(code, /\(\?<[=!]/, entry);
      // Its imports are the networks' rules alone.
      assert.deepEqual(
        [...new Set([...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1].split("/").slice(0, 2).join("/")))],
        ["@dusk-network/networks"],
        entry
      );
    }
  });

  it("packs only the code, the types and the docs", () => {
    // npm 11 prints an array of packages, newer npm an object keyed by name.
    const report = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }));
    const packed = Array.isArray(report) ? report[0] : report[pkg.name];

    assert.deepEqual(packed.files.map((/** @type {{ path: string }} */ f) => f.path).sort(), [
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "package.json",
      "src/history.d.ts",
      "src/history.js",
    ]);
  });
});
