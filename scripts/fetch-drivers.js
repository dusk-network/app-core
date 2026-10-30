#!/usr/bin/env node
/**
 * The network's DuskEVM data drivers, which the withdrawal tests run: the
 * Portal's and the dispute game factory's, fetched from where they're
 * published at a pinned commit and checked against the SHA-256 the
 * network's file pins. Kept in test/fixtures/drivers, which git leaves out;
 * a driver kept already is checked, not fetched again.
 *
 *   node scripts/fetch-drivers.js
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { networks } from "@dusk-network/networks";

/** Where the drivers are published: the web wallet's, at the commit that added them. */
export const DRIVERS_URL = "https://raw.githubusercontent.com/dusk-network/web-wallet/1d861c69821b0c7b86146e067ec86ec3d91a5d8a/static/drivers";

/** Where they're kept. */
export const DRIVERS_DIR = new URL("../test/fixtures/drivers/", import.meta.url);

/** A driver whose bytes aren't the ones the network's file pins. */
export class DriverMismatchError extends Error {
  /** @param {string} file @param {"fetched" | "kept"} as */
  constructor(file, as) {
    super(`${file} as ${as} isn't the pinned driver`);
    this.name = "DriverMismatchError";
  }
}

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Each driver kept, fetching those not kept yet; a DriverMismatchError for
 * one whose SHA-256 isn't the pinned one, kept or fetched, and the fetch's
 * own error when one can't be fetched.
 *
 * @param {{ fetch?: typeof fetch, dir?: URL, log?: (line: string) => void }} [options]
 * @returns {Promise<Record<"optimismPortal" | "disputeGameFactory", URL>>}
 */
export async function fetchDrivers({ dir = DRIVERS_DIR, fetch = globalThis.fetch, log = () => {} } = {}) {
  const pins = networks.testnet.duskEvm?.drivers;

  if (!pins) throw new TypeError("The network's file pins no drivers");

  /** @type {Record<string, URL>} */
  const files = {};

  for (const [name, { file, sha256: pinned }] of Object.entries(pins)) {
    const path = new URL(file, dir);

    if (!existsSync(path)) {
      const url = `${DRIVERS_URL}/${file}`;
      const response = await fetch(url).catch((/** @type {unknown} */ error) => {
        throw new Error(`${file} couldn't be fetched from ${url}: ${error instanceof Error ? error.message : error}`, { cause: error });
      });

      if (!response.ok) throw new Error(`${file} couldn't be fetched from ${url}: HTTP ${response.status}`);

      const bytes = new Uint8Array(await response.arrayBuffer());

      if (sha256(bytes) !== pinned) throw new DriverMismatchError(file, "fetched");

      // Whole or not at all: test files run side by side, each may fetch.
      const part = new URL(`${file}.${process.pid}.part`, dir);

      mkdirSync(dir, { recursive: true });
      writeFileSync(part, bytes);
      renameSync(part, path);
      log(`${pinned}  ${file}: fetched`);
    } else if (sha256(readFileSync(path)) !== pinned) {
      throw new DriverMismatchError(file, "kept");
    } else {
      log(`${pinned}  ${file}: kept`);
    }

    files[name] = path;
  }

  return /** @type {Record<"optimismPortal" | "disputeGameFactory", URL>} */ (files);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await fetchDrivers({ log: (line) => console.log(line) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
