// A network an app builds from its own settings, for a chain there's no
// network file for (#35): its chain ID and DuskEVM's RPC, explorer and
// bridge, checked as a network file's fields are. Deposits are followed
// there as on a file's network; it has no routes to other chains.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";
import { evmAddressOf } from "@dusk-network/networks/duskevm";

import { depositArrivals, migrationPayoutOf, migrationPayouts, serviceArrivals, serviceTransferOf } from "../src/bridge.js";
import { L2_BRIDGE, bridgeFinalized, call, depositEntry, details, fakeChain, fakeExplorer } from "./fixtures/bridge.js";
import { fakeArchive, like } from "./fixtures/helpers.js";

const RPC = "http://127.0.0.1:8545";
const API = "http://127.0.0.1:4000/api/v2";
/** A local chain's settings, as an app keeps them. */
const SETTINGS = { chainId: 0, duskEvm: { blockscoutApiUrl: API, predeploys: { l2StandardBridge: L2_BRIDGE }, rpcUrl: RPC } };
// Any valid Dusk account works as the sender.
const SENDER = networks.mainnet.routes.services[0].account;
const FROM = evmAddressOf(SENDER);
const TO = "0xab84edffd745af9420ac74fec73121fbee9fc86f";
const TENTH = 100_000_000n;
const WEI = TENTH * 1_000_000_000n;

/** @param {string} byte @returns {string} A Dusk transaction's hash. */
const dusk = (byte) => byte.repeat(64).slice(0, 64);
/** @param {string | number} n @returns {string} A DuskEVM transaction's hash. */
const l2 = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
/** Block n of the chain's, made at second 1_792_980_000 + n. */
const second = (/** @type {number} */ n) => (1_792_980_000 + n) * 1000;
/** @param {string} byte @param {number} at @param {Record<string, unknown>} [fields] @returns {any} */
const sent = (byte, at, fields = {}) => ({ amount: TENTH, at, hash: dusk(byte), height: 5_000, sender: SENDER, to: TO, ...fields });
/** @param {string | number} n @param {number} block */
const credit = (n, block) => bridgeFinalized({ block, from: FROM, hash: l2(n), to: TO, wei: WEI });

describe("a deposit on a chain without a network file, with a network built from the app's settings (#35)", () => {
  it("is followed on the explorer the settings name", async () => {
    const explorer = fakeExplorer([[call(l2(13), "2026-10-27T05:50:40Z", { value: String(WEI) })]]);
    const at = Date.parse("2026-10-27T05:50:00Z");
    const { arrivals } = await depositArrivals({ deposits: [sent("a1", at)], fetch: explorer.fetch, network: SETTINGS, now: at + 3_600_000 });

    like(arrivals.get(dusk("a1")), { hash: l2(13), state: "arrived" });
    assert.deepEqual(explorer.urls, [`${API}/addresses/${TO}/internal-transactions?filter=to`]);
  });

  it("is followed on the RPC the settings name, by its sender's DuskEVM address", async () => {
    const chain = fakeChain({ head: 40_000, logs: [credit(1, 1_060)], url: RPC });
    const { arrivals } = await depositArrivals({ deposits: [sent("ab", second(1_000))], fetch: chain.fetch, network: SETTINGS, now: second(40_000), via: "rpc" });

    like(arrivals.get(dusk("ab")), { hash: l2(1), state: "arrived" });
  });

  it("reads its sender's history where the settings name DuskEVM's contracts on Dusk, and asks the archive nothing where they don't", async () => {
    const contracts = /** @type {NonNullable<typeof networks.testnet.duskEvm>} */ (networks.testnet.duskEvm).contracts;
    const node = fakeArchive({
      accounts: { [SENDER]: { receiver: [], sender: [depositEntry({ hash: dusk("ab"), height: 5_000, sender: SENDER, value: TENTH })] } },
      details: { [dusk("ab")]: details(1_792_981_000, { deposit: { amountLux: TENTH, to: TO } }) },
      finalized: 10_000,
    });
    // Its credit an hour after it: one only its sender's history says is its own.
    const chain = fakeChain({ head: 40_000, logs: [credit(1, 4_600)], url: RPC });
    const options = { archive: node.archiveClient(), deposits: [sent("ab", second(1_000))], fetch: chain.fetch, now: second(40_000), via: /** @type {const} */ ("rpc") };
    const read = await depositArrivals({ ...options, network: { ...SETTINGS, duskEvm: { ...SETTINGS.duskEvm, contracts } } });

    like(read.arrivals.get(dusk("ab")), { hash: l2(1), state: "arrived" });
    assert.ok(node.historyQueries().length > 0);

    const asked = node.log.length;
    const without = await depositArrivals({ ...options, network: SETTINGS });

    // Without them, as without the archive: the credit isn't in its window.
    like(without.arrivals.get(dusk("ab")), { reason: "late", state: "unknown" });
    assert.equal(node.log.length, asked);
  });

  it("asks nothing on a chain without DuskEVM", async () => {
    const result = await depositArrivals({ deposits: [sent("ab", second(1_000))], fetch: async () => assert.fail("asked"), network: { chainId: 0 }, now: second(40_000) });

    like(result.arrivals.get(dusk("ab")), { reason: "no-route", state: "unknown" });
    assert.equal(result.requests, 0);
  });

  it("has no routes to other chains: a transfer out or a migration there pays out nothing that can be told apart", async () => {
    const node = fakeArchive({ accounts: {}, details: {}, finalized: 10_000 });
    const route = networks.testnet.routes.services[0];
    const transfer = { hash: dusk("cd"), route: route.id };
    const out = await serviceArrivals({ archive: node.archiveClient(), fetch: async () => assert.fail("asked"), network: SETTINGS, transfers: [transfer] });

    like(out.arrivals.get(dusk("cd")), { reason: "no-route", state: "unknown" });

    const migration = { amount: TENTH, hash: l2(7), route: networks.testnet.routes.migrations[0].id };
    const paid = await migrationPayouts({ entries: [], migrations: [migration], network: SETTINGS });

    like(paid.payouts.get(l2(7)), { reason: "no-route", state: "unknown" });

    const entry = { blockHeight: 9, counterparty: route.account, direction: /** @type {const} */ ("out"), hash: dusk("cd"), kind: /** @type {const} */ ("transfer"), memo: TO, payer: true, value: 5n * TENTH };

    assert.equal(serviceTransferOf(entry, SETTINGS), null);
    assert.equal(migrationPayoutOf({ ...entry, direction: "in", memo: l2(7) }, SETTINGS), null);
  });

  it("is refused where a network file couldn't hold the settings", async () => {
    const evm = SETTINGS.duskEvm;
    const bad = [
      { chainId: "0", duskEvm: evm },
      { chainId: -1, duskEvm: evm },
      { chainId: 0, duskEvm: "yes" },
      { chainId: 0, duskEvm: { ...evm, predeploys: {} } },
      { chainId: 0, duskEvm: { ...evm, predeploys: { l2StandardBridge: "0x4200" } } },
      { chainId: 0, duskEvm: { ...evm, rpcUrl: "127.0.0.1:8545" } },
      { chainId: 0, duskEvm: { ...evm, rpcUrl: `${RPC}/` } },
      { chainId: 0, duskEvm: { ...evm, blockscoutApiUrl: "file:///api" } },
      { chainId: 0, duskEvm: { ...evm, contracts: { l1_standard_bridge: { contractId: "0x2257" } } } },
      { chainId: 0, duskEvm: evm, routes: "none" },
    ];

    for (const network of bad) {
      await assert.rejects(depositArrivals({ deposits: [], network: /** @type {any} */ (network) }), TypeError, JSON.stringify(network));
      await assert.rejects(serviceArrivals({ archive: fakeArchive().archiveClient(), network: /** @type {any} */ (network), transfers: [] }), TypeError, JSON.stringify(network));
    }

    // Each path needs its own URL, from the settings or given.
    const rpcOnly = { chainId: 0, duskEvm: { predeploys: evm.predeploys, rpcUrl: RPC } };

    await assert.rejects(depositArrivals({ deposits: [], network: rpcOnly }), TypeError);
    assert.equal((await depositArrivals({ deposits: [], explorerUrl: API, network: rpcOnly })).requests, 0);
    await assert.rejects(depositArrivals({ deposits: [], network: { chainId: 0, duskEvm: { blockscoutApiUrl: API, predeploys: evm.predeploys } }, via: "rpc" }), TypeError);
  });
});
