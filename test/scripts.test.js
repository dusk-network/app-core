import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { networks } from "@dusk-network/networks";

import { versionProblem } from "../scripts/check-versions.js";
import { SOURCE, confusablesModule, parseConfusables } from "../scripts/generate-confusables.js";
import { DRIVERS_URL, DriverMismatchError, fetchDrivers } from "../scripts/fetch-drivers.js";
import { countingFetch, readWhole } from "../scripts/measure-reads.js";
import { releaseNotes } from "../scripts/release-notes.js";

describe("the release scripts", () => {
  it("want the same version in package.json, jsr.json and the tag", () => {
    assert.equal(versionProblem({ npm: "0.1.0", jsr: "0.1.0", tag: "v0.1.0" }), null);
    assert.match(versionProblem({ npm: "0.1.0", jsr: "0.2.0" }) ?? "", /jsr\.json has 0\.2\.0/);
    assert.match(versionProblem({ npm: "0.1.0", jsr: "0.1.0", tag: "v0.1.1" }) ?? "", /the tag is v0\.1\.1/);
  });

  it("take a version's section of the CHANGELOG, and nothing for an empty one", () => {
    const changelog = "# Changelog\n\n## [0.2.0]\n\n- b\n\n## [0.1.0]\n\n- a\n\n## [0.0.1]\n";

    assert.equal(releaseNotes(changelog, "0.2.0"), "- b");
    assert.equal(releaseNotes(changelog, "0.1.0"), "- a");
    assert.equal(releaseNotes(changelog, "0.0.1"), null);
    assert.equal(releaseNotes(changelog, "0.3.0"), null);
  });
});

describe("the script that counts the bridge views' requests", () => {
  const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_getLogs", params: [] });

  it("counts a request whose fetch fails or whose answer can't be read, with its bytes and time", async () => {
    let calls = 0;
    const { fetch, rows } = countingFetch(async () => {
      calls += 1;

      if (calls === 1) throw new TypeError("fetch failed");

      // An answer cut off as it's read.
      return new Response(
        new ReadableStream({
          start: (controller) => controller.error(new Error("connection reset")),
        })
      );
    });

    await assert.rejects(fetch("https://rpc.example/", { body, method: "POST" }), /fetch failed/);
    await assert.rejects(fetch("https://rpc.example/", { body, method: "POST" }), /connection reset/);

    const row = rows.get("rpc.example eth_getLogs");

    assert.equal(row?.requests, 2);
    assert.equal(row?.sent, 2 * Buffer.byteLength(body));
    assert.ok((row?.ms ?? -1) >= 0);
  });

  it("syncs an account's history until it's read whole, and no more", async () => {
    let syncs = 0;
    const history = {
      // As /history's sync answers: what it added, its requests and its state.
      sync: async () => ({ added: 0, requests: 1, state: { synced: (syncs += 1) } }),
      read: async () => ({ complete: syncs >= 3 }),
    };

    await readWhole(history);
    assert.equal(syncs, 3);
  });
});

describe("the data drivers the withdrawal tests run", () => {
  const [first, second] = Object.values(networks.testnet.duskEvm?.drivers ?? {});

  /** A folder of its own, removed after. @param {(dir: URL) => Promise<void>} run */
  const inScratch = async (run) => {
    const path = mkdtempSync(join(tmpdir(), "drivers-"));

    try {
      await run(pathToFileURL(`${path}/`));
    } finally {
      rmSync(path, { force: true, recursive: true });
    }
  };

  it("come from a commit, the files the network's file names", () => {
    assert.match(DRIVERS_URL, /^https:\/\/raw\.githubusercontent\.com\/dusk-network\/web-wallet\/[0-9a-f]{40}\/static\/drivers$/);
    assert.deepEqual([first.file, second.file].sort(), ["dispute_game_factory_dd_opt.wasm", "optimism_portal_dd_opt.wasm"]);
  });

  it("aren't kept when what's fetched isn't the pinned bytes, and a fetch that fails is its own failure", async () => {
    await inScratch(async (dir) => {
      /** @type {string[]} */
      const asked = [];
      const fetch = async (/** @type {string} */ url) => (asked.push(url), new Response(Uint8Array.of(0, 0x61, 0x73, 0x6d)));

      await assert.rejects(fetchDrivers({ dir, fetch: /** @type {any} */ (fetch) }), DriverMismatchError);
      assert.deepEqual(asked, [`${DRIVERS_URL}/${first.file}`]);
      assert.equal(existsSync(new URL(first.file, dir)), false);

      // Not found, or no network: the tests skip, and CI's fetch fails.
      await assert.rejects(
        fetchDrivers({ dir, fetch: /** @type {any} */ (async () => new Response("", { status: 404 })) }),
        (error) => !(error instanceof DriverMismatchError) && /HTTP 404/.test(String(error))
      );
    });
  });

  it("are refused when kept with other bytes, and not fetched again", async () => {
    await inScratch(async (dir) => {
      for (const { file } of [first, second]) writeFileSync(new URL(file, dir), "not the driver");

      await assert.rejects(
        fetchDrivers({
          dir,
          fetch: async () => {
            throw new Error("fetched");
          },
        }),
        DriverMismatchError
      );
    });
  });
});

describe("the script that makes /names' table of look-alikes", () => {
  const sample = [
    "# confusables.txt",
    "# Date: 2026-08-06, 01:05:35 GMT",
    "# © 2026 Unicode®, Inc.",
    "",
    "05AD ;\t0596 ;\tMA\t# ( ֭ → ֖ ) HEBREW ACCENT DEHI → HEBREW ACCENT TIPEHA\t# ",
    "0430 ;\t0061 ;\tMA\t# ( а → a ) CYRILLIC SMALL LETTER A → LATIN SMALL LETTER A\t# ",
    "006D ;\t0072 006E ;\tMA\t# ( m → rn ) LATIN SMALL LETTER M → LATIN SMALL LETTER R, LATIN SMALL LETTER N\t# ",
    "",
  ].join("\n");

  it("reads each line of Unicode's file, in order of its source", () => {
    assert.deepEqual(parseConfusables(sample), [
      [0x6d, [0x72, 0x6e]],
      [0x430, [0x61]],
      [0x5ad, [0x596]],
    ]);
    assert.throws(() => parseConfusables("0430 ;\t0061 ;\tXX\t# not one"), /Not a confusables line/);
  });

  it("writes a module of the table with Unicode's notice, which reads back as the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "confusables-"));

    try {
      const file = join(dir, "confusables.js");

      writeFileSync(file, confusablesModule(sample));

      const text = readFileSync(file, "utf8");
      const made = await import(pathToFileURL(file).href);

      assert.match(text, /© 2026 Unicode®, Inc\./);
      assert.match(text, /https:\/\/www\.unicode\.org\/license\.txt/);
      assert.equal(made.CONFUSABLES_VERSION, SOURCE.version);
      assert.equal(made.CONFUSABLES, "6d 72 6e;430 61;5ad 596");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("writes nothing from a file that isn't the pinned version's", () => {
    const dir = mkdtempSync(join(tmpdir(), "confusables-"));
    const before = readFileSync(new URL("../src/confusables.js", import.meta.url), "utf8");

    try {
      const file = join(dir, "confusables.txt");

      writeFileSync(file, sample);

      const run = spawnSync(process.execPath, [new URL("../scripts/generate-confusables.js", import.meta.url).pathname, file], { encoding: "utf8" });

      assert.equal(run.status, 1);
      assert.match(run.stderr, /SHA-256 differs/);
      assert.equal(readFileSync(new URL("../src/confusables.js", import.meta.url), "utf8"), before);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("made the package's table from the pinned version", () => {
    const text = readFileSync(new URL("../src/confusables.js", import.meta.url), "utf8");

    assert.match(SOURCE.url, /^https:\/\/www\.unicode\.org\/Public\/\d+\.\d+\.\d+\/security\/confusables\.txt$/);
    assert.ok(SOURCE.url.includes(`/${SOURCE.version}/`));
    assert.ok(text.includes(SOURCE.url) && text.includes(SOURCE.sha256), "its header names the file and its hash");
  });
});
