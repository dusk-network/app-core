import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { networks } from "@dusk-network/networks";

import { versionProblem } from "../scripts/check-versions.js";
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
