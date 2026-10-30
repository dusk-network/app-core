#!/usr/bin/env node
/**
 * A read-only check of DuskEVM withdrawals against testnet, which CI doesn't
 * run: the 1,008 DUSK withdrawal's status for the account that proved it,
 * and its claim's call, compared with the bytes the apps were recorded to
 * sign (test/fixtures/duskevm-withdrawal-vectors.json). With `--prove`, also
 * user2's proof of it, which matches the recording while the game it goes
 * against is the one recorded. It reads; it signs and sends nothing. Each
 * read is its own request, four at a time: about 35, or 100 with `--prove`.
 * The drivers are the tests', fetched where they aren't kept yet and checked
 * against the network file's hashes (`npm run fetch:drivers`).
 *
 *   node scripts/smoke-withdrawals.js [--prove]
 */

import { readFileSync } from "node:fs";

import { networks } from "@dusk-network/networks";

import { createWithdrawals } from "../src/duskevm-withdrawals.js";
import { fetchDrivers } from "./fetch-drivers.js";

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/duskevm-withdrawal-vectors.json", import.meta.url), "utf8"));
const [vector] = fixture.vectors;
const prove = process.argv.includes("--prove");
const net = networks.testnet;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const files = await fetchDrivers();

/**
 * One of the network's data drivers, as its file pins it.
 *
 * @param {"optimismPortal" | "disputeGameFactory"} name
 */
async function driver(name) {
  const { instance } = await WebAssembly.instantiate(readFileSync(files[name]), { env: {} });
  const ffi = /** @type {any} */ (instance.exports);
  const memory = () => ffi.memory.buffer;
  /** @param {string} fn @param {string} exported @param {Uint8Array} input */
  const run = (fn, exported, input) => {
    const name = encoder.encode(fn);
    const [a, b, out] = [ffi.alloc(name.length), ffi.alloc(input.length), ffi.alloc(1 << 21)];

    new Uint8Array(memory(), a, name.length).set(name);
    new Uint8Array(memory(), b, input.length).set(input);

    try {
      const code = ffi[exported](a, name.length, b, input.length, out, 1 << 21);
      const data = new Uint8Array(memory(), out + 4, new DataView(memory(), out, 4).getUint32(0, true)).slice();

      if (code !== 0) throw new Error(`${fn}: the driver refused (${code})`);

      return data;
    } finally {
      ffi.dealloc(a, name.length);
      ffi.dealloc(b, input.length);
      ffi.dealloc(out, 1 << 21);
    }
  };

  ffi.init?.();

  return {
    /** @param {string} fn @param {Uint8Array} bytes */
    decodeOutputFn: (fn, bytes) => JSON.parse(decoder.decode(run(fn, "decode_output_fn", bytes))),
    /** @param {string} fn @param {string} json */
    encodeInputFn: (fn, json) => run(fn, "encode_input_fn", encoder.encode(json)),
  };
}

// Four requests at a time, each one counted.
let inFlight = 0;
let requests = 0;
/** @type {Array<() => void>} */
const waiting = [];

/** @type {typeof fetch} */
const limited = async (input, init) => {
  while (inFlight >= 4) await new Promise((resolve) => waiting.push(() => resolve(undefined)));

  inFlight += 1;
  requests += 1;

  try {
    return await fetch(input, init);
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
};

const withdrawals = createWithdrawals({
  drivers: { disputeGameFactory: await driver("disputeGameFactory"), optimismPortal: await driver("optimismPortal") },
  duskEvm: { fetch: limited, url: net.duskEvm?.rpcUrl ?? "" },
  fetch: limited,
  network: net,
  nodeUrl: net.urls.node,
});
const hex = (/** @type {Uint8Array} */ bytes) => `0x${Buffer.from(bytes).toString("hex")}`;
const date = (/** @type {bigint | null | undefined} */ seconds) => (seconds ? new Date(Number(seconds) * 1_000).toISOString() : "none");
const started = Date.now();
let failed = false;

const status = await withdrawals.status(vector.tx, { submitter: vector.claim.submitter });

console.log(`${vector.name} (${vector.tx}), for its prover ${vector.claim.submitter}:`);
console.log(`  pays ${status.facts.recipient.kind === "account" ? status.facts.recipient.account : status.facts.recipient.contractId}, ${status.facts.amountWei / 10n ** 9n} lux`);
console.log(`  ${status.stage}${status.reason ? ` (${status.reason})` : ""}, proved ${date(status.provenAt)}, claimable from ${date(status.readyAt)}${status.readyAtExact ? "" : " (about)"}`);

if (status.stage === "ready_to_finalize") {
  const claim = await withdrawals.claimCall(vector.tx, { submitter: vector.claim.submitter });
  const same = hex(claim.fnArgs) === vector.claim.webWallet && hex(claim.fnArgs) === vector.claim.bridgeSite;

  failed ||= !same;
  console.log(`  claim: ${claim.fnName}, gas limit ${claim.gasLimit}, ${claim.fnArgs.length} bytes, ${same ? "the bytes the apps were recorded to sign" : "NOT the recorded bytes"}`);
} else {
  console.log(`  claim: not built, as it isn't ready to claim (claimed since the recording, or waiting)`);
}

if (prove) {
  const prepared = await withdrawals.prepareProof(vector.tx, { submitter: vector.prove.submitter });
  const same = hex(prepared.call.fnArgs) === vector.prove.webWallet;
  const recordedGame = BigInt(`0x${vector.prove.webWallet.slice(-2 * 312 + 2 * 128, -2 * 312 + 2 * 160)}`);

  console.log(`  proof for ${vector.prove.submitter}: game ${prepared.proof.disputeGameIndex}, claimable if proved now from ${prepared.claim ? new Date(prepared.claim.at ?? 0).toISOString() : "none"}`);

  if (prepared.proof.disputeGameIndex === recordedGame) {
    failed ||= !same;
    console.log(`  proof: ${same ? "the bytes the apps were recorded to sign" : "NOT the recorded bytes"}`);
  } else {
    console.log(`  proof: against game ${prepared.proof.disputeGameIndex}, a newer one than the recorded ${recordedGame}: the same withdrawal (${prepared.call.decoded.hash === status.withdrawalHash})`);
  }
}

console.log(`${requests} requests in ${Date.now() - started} ms`);
process.exitCode = failed ? 1 : 0;
