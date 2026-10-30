#!/usr/bin/env node
/**
 * A read-only check of /bridge against DuskEVM Testnet, which CI doesn't
 * run: a testnet deposit's arrival, found on DuskEVM's explorer and on its
 * RPC, at the URLs testnet's network file gives. Four requests at most.
 *
 *   node scripts/smoke-bridge.js
 */

import { networks } from "@dusk-network/networks";

import { depositArrivals } from "../src/bridge.js";

// A deposit of 0.5 DUSK to DuskEVM from a testnet account, on 27 October 2026.
const DEPOSIT = {
  amount: 500_000_000n,
  at: Date.parse("2026-10-27T05:51:39Z"),
  hash: "ac6b2f9b4148915244ca86ea08b398a96d4aaba111ad24a0e480fadb3416bc24",
  sender: "qxwSidLBa1rJ74ngfP4GUCaNsAYjMboDPHzbmiVEMmNNK26hVkYe8QccH6ipYdVRsUDnx9QS1KBeu8ZoMDFpXJJE6YCcHy2AykvJ7eEAGc7PGDgCZFV5YJBxzukADkQ2Bgr",
  to: "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F",
};
// A DuskEVM block from before it was sent, as the app reads the head before sending.
const BEFORE = 3_951_700;

/** @type {string[]} */
const asked = [];
/** @type {import("../src/bridge.js").FetchLike} */
const logged = (input, init) => {
  asked.push(init.method === "GET" ? `GET ${input}` : `POST ${input} ${JSON.parse(String(init.body)).method}`);

  return fetch(input, init);
};
const network = networks.testnet;
const started = Date.now();
// It is looked for however long ago it was sent.
const explorer = await depositArrivals({ deposits: [DEPOSIT], fetch: logged, network, waitMs: Infinity });
const rpc = await depositArrivals({ deposits: [{ ...DEPOSIT, notBefore: BEFORE }], fetch: logged, network, via: "rpc", waitMs: Infinity });

console.log(`${asked.length} requests in ${Date.now() - started} ms:`);
for (const line of asked) console.log(`  ${line}`);

for (const [via, result] of [
  ["explorer", explorer],
  ["rpc", rpc],
]) {
  const arrival = /** @type {import("../src/bridge.js").Arrival} */ (/** @type {any} */ (result).arrivals.get(DEPOSIT.hash));

  console.log(
    arrival.state === "arrived"
      ? `${via}: arrived in ${arrival.hash}, block ${arrival.block}, ${new Date(/** @type {number} */ (arrival.at)).toISOString()}, ${arrival.amount} lux`
      : `${via}: ${arrival.state}${"reason" in arrival ? ` (${arrival.reason}${arrival.error ? `: ${arrival.error}` : ""})` : ""}`
  );
}
