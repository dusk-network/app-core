import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
/** The JS entry points, each with its declarations. */
const ENTRIES = ["./history", "./shielded", "./activity", "./bridge", "./bridge-explorer", "./duskevm-withdrawals"];
/** The modules the entry points share, which aren't entry points. */
const SHARED = ["./src/bridge-common.js"];
/** The one entry point that may use viem, an optional peer: an app that uses no other installs none. */
const VIEM_ENTRY = "./duskevm-withdrawals";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** @param {string} file */
const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/**
 * A module's code without its comments, and what it imports and exports
 * from other modules.
 *
 * @param {string} file
 */
function moduleOf(file) {
  const code = source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const from = [...new Set([...code.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)";/gm)].map((m) => m[1]))];

  return { code, from };
}

/**
 * The package's own modules an entry point loads, itself among them, by
 * their paths under the package.
 *
 * @param {string} file
 */
function loads(file) {
  const seen = new Set([file]);

  for (const each of seen) {
    for (const from of moduleOf(each).from) if (from.startsWith("./")) seen.add(`./src/${from.slice(2)}`);
  }

  return [...seen].sort();
}

describe("the package", () => {
  it("is an ES module under MPL-2.0 whose one runtime dependency, the networks' rules, is pinned exactly", () => {
    assert.equal(pkg.name, "@dusk-network/app-core");
    assert.equal(pkg.type, "module");
    assert.equal(pkg.license, "MPL-2.0");
    assert.deepEqual(pkg.dependencies, { "@dusk-network/networks": "0.3.0" });

    const lock = JSON.parse(source("package-lock.json"));

    assert.equal(lock.packages["node_modules/@dusk-network/networks"].version, "0.3.0");
  });

  it("takes viem as an optional peer, the range the apps use, and tests with its lowest version", () => {
    assert.deepEqual(pkg.peerDependencies, { viem: "^2.55.2" });
    assert.deepEqual(pkg.peerDependenciesMeta, { viem: { optional: true } });
    assert.deepEqual(pkg.devDependencies, { viem: "2.55.2" });

    const lock = JSON.parse(source("package-lock.json"));

    assert.equal(lock.packages["node_modules/viem"].version, "2.55.2");
    assert.equal(lock.packages["node_modules/viem"].dev, true);

    // On JSR, the same range: without it JSR would take the version installed.
    assert.deepEqual(JSON.parse(source("jsr.json")).imports, { viem: `npm:viem@${pkg.peerDependencies.viem}` });
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

    const { createLeafHeightTap, shieldedEntries, shieldedHistory } = await import("@dusk-network/app-core/shielded");

    assert.equal(typeof shieldedHistory, "function");
    assert.equal(typeof createLeafHeightTap().stream, "function");
    assert.deepEqual(shieldedEntries({ blocks: new Map(), notes: [] }), []);

    const { PENDING_MS, activityRows, settleSends } = await import("@dusk-network/app-core/activity");

    assert.equal(PENDING_MS, 900_000);
    assert.deepEqual(activityRows(), []);
    assert.deepEqual(settleSends(), { drop: [], keep: [] });

    const { arrivalsOf, depositArrivals, depositArrivalsFromExplorer, migrationPayouts, serviceArrivals } = await import("@dusk-network/app-core/bridge");
    const explorer = await import("@dusk-network/app-core/bridge-explorer");

    assert.equal(typeof depositArrivals, "function");
    assert.deepEqual(Object.keys(explorer), ["depositArrivalsFromExplorer"]);
    assert.equal(explorer.depositArrivalsFromExplorer, depositArrivalsFromExplorer);
    assert.equal(typeof migrationPayouts, "function");
    assert.equal(typeof serviceArrivals, "function");
    assert.deepEqual(arrivalsOf(new Map()), new Map());

    const { WithdrawalError, createWithdrawals, explorerStage, parseWithdrawalReceipt, withdrawalCall } = await import("@dusk-network/app-core/duskevm-withdrawals");

    assert.equal(typeof createWithdrawals, "function");
    assert.equal(typeof withdrawalCall, "function");
    assert.equal(explorerStage("Relayed"), "finalized");
    assert.throws(() => parseWithdrawalReceipt(2, null), WithdrawalError);
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
    const own = new Set([...Object.values(pkg.exports).map((target) => (typeof target === "string" ? target : target.default)), ...SHARED]);

    for (const file of [...ENTRIES.map((entry) => pkg.exports[entry].default), ...SHARED]) {
      const entry = ENTRIES.find((each) => pkg.exports[each].default === file);
      // The code, without its comments.
      const { code, from } = moduleOf(file);

      // The page's globals (a sync's `window` is its span of blocks), and browser storage.
      assert.doesNotMatch(code, /(?<![\w$.])(?:window|document|chrome|browser)\s*[.[]/, file);
      assert.doesNotMatch(code, /\b(?:localStorage|sessionStorage|indexedDB)\b/, file);
      assert.doesNotMatch(code, /\bimport\s*\(/, file);
      assert.doesNotMatch(code, /^await\b/m, file);
      // Nor a lookbehind, which older Safari can't parse.
      assert.doesNotMatch(code, /\(\?<[=!]/, file);
      // Its imports are the networks' rules and the package's own modules,
      // and for DuskEVM's withdrawals viem, which no other entry point takes.
      assert.ok(from.length > 0, file);
      assert.equal([...code.matchAll(/^import\b/gm)].length, [...code.matchAll(/^import\b[^;]*?\bfrom\s+"[^"]+";/gm)].length, `${file}: every import is read`);
      for (const each of from) {
        assert.ok(
          each.split("/").slice(0, 2).join("/") === "@dusk-network/networks" || own.has(`./src/${each.slice(2)}`) || (each === "viem" && entry === VIEM_ENTRY),
          `${file}: ${each}`
        );
      }
    }
  });

  it("lets an app that follows deposits on the explorer alone load just that: /bridge-explorer loads neither the RPC path nor /history", () => {
    assert.deepEqual(loads(pkg.exports["./bridge-explorer"].default), ["./src/bridge-common.js", "./src/bridge-explorer.js"]);
    assert.ok(loads(pkg.exports["./bridge"].default).includes("./src/history.js"));
  });

  it("keeps viem to DuskEVM's withdrawals, and the entries they import free of it", () => {
    for (const entry of ENTRIES.filter((each) => each !== VIEM_ENTRY)) {
      assert.doesNotMatch(source(pkg.exports[entry].default), /from\s+"viem"|import\s*\(\s*"viem"/, entry);
    }

    assert.match(source(pkg.exports[VIEM_ENTRY].default), /from "viem";/);
  });

  it("packs only the code, the types and the docs", () => {
    // npm 11 prints an array of packages, newer npm an object keyed by name.
    // It counts this folder as a directory package, which .npmrc refuses elsewhere.
    const report = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--allow-directory=all"], { cwd: root, encoding: "utf8" }));
    const packed = Array.isArray(report) ? report[0] : report[pkg.name];

    assert.deepEqual(packed.files.map((/** @type {{ path: string }} */ f) => f.path).sort(), [
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "package.json",
      "src/activity.d.ts",
      "src/activity.js",
      "src/bridge-common.js",
      "src/bridge-explorer.d.ts",
      "src/bridge-explorer.js",
      "src/bridge.d.ts",
      "src/bridge.js",
      "src/duskevm-withdrawals.d.ts",
      "src/duskevm-withdrawals.js",
      "src/history.d.ts",
      "src/history.js",
      "src/shielded.d.ts",
      "src/shielded.js",
    ]);
  });
});
