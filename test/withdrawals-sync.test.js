// What a sync of an address's withdrawals reads: its head, counted against
// the run's requests (#31), and each final block more than once, so an
// answer without a withdrawal's log doesn't hide it for good (#40). The
// RPC here leaves a third of the answers without their logs, at random,
// over many seeds: every withdrawal is still found, and found once.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { encodeAbiParameters, pad } from "viem";

import { ETH_BRIDGE_INITIATED_TOPIC, L2_WINDOW, syncWithdrawals } from "../src/duskevm-withdrawals.js";
import { TESTNET, USER2, paysAccount } from "./fixtures/withdrawals.js";

const EVM = "0x3e5b8223e638cb414bef8cf95393460ca1c3a11d";
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const MINUTE = 60_000;
/** @param {number} n */
const h = (n) => `0x${n.toString(16).padStart(64, "0")}`;

/**
 * The bridge's ETHBridgeInitiated log of withdrawal `n` from EVM.
 *
 * @param {number} n
 * @param {number} block
 */
const withdrawalLog = (n, block) => ({
  blockNumber: `0x${block.toString(16)}`,
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [2n * 10n ** 18n, paysAccount(USER2)]),
  topics: [ETH_BRIDGE_INITIATED_TOPIC, pad(EVM), pad(EVM)],
  transactionHash: h(n),
});

/**
 * DuskEVM as a sync reads it: its final head (`final`), and the address's
 * logs in the blocks asked, 100,000 at most; `rate` of the answers come back
 * without their logs, at random, the same ones for the same `seed`, and the
 * next `held` answers for a range holding a block `hold` names. `asked`
 * keeps each request's method.
 *
 * @param {ReturnType<typeof withdrawalLog>[]} logs
 * @param {{ final: number, rate?: number, seed?: number, hold?: Map<number, number>, finalized?: boolean }} options
 */
function duskEvmOf(logs, { final, finalized = true, hold = new Map(), rate = 0, seed = 1 }) {
  let drawn = 0;
  const random = () => createHash("sha256").update(`${seed}:${(drawn += 1)}`).digest().readUInt32BE(0) / 4_294_967_296;
  const chain = {
    /** @type {string[]} */
    asked: [],
    final,
    /** @param {{ method: string, params: any[] }} request */
    request: async ({ method, params }) => {
      chain.asked.push(method);

      if (method === "eth_getBlockByNumber") {
        if (!finalized) throw new Error("invalid block tag");

        return { number: `0x${chain.final.toString(16)}` };
      }

      if (method === "eth_blockNumber") return `0x${(chain.final + 1_800).toString(16)}`;

      const [{ fromBlock, toBlock }] = params;
      const [from, to] = [Number(fromBlock), Number(toBlock)];

      if (to - from + 1 > L2_WINDOW) throw new Error("query exceeds max block range 100000");

      const held = [...hold].filter(([block, times]) => times > 0 && block >= from && block <= to);

      for (const [block, times] of held) hold.set(block, times - 1);
      if (held.length || random() < rate) return [];

      return logs.filter((log) => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to);
    },
  };

  return chain;
}

/**
 * Syncs as an app does, every `every` milliseconds for `runs` runs, the
 * final head `step` blocks on each time, with the state the last run gave:
 * each withdrawal found, by hash, with how many times it was, and each
 * run's requests.
 *
 * @param {ReturnType<typeof duskEvmOf>} duskEvm
 * @param {{ runs: number, every: number, step: number, maxRequests?: number }} options
 */
async function syncs(duskEvm, { every, maxRequests, runs, step }) {
  /** @type {Map<string, number>} */
  const found = new Map();
  /** @type {number[]} */
  const requests = [];
  /** @type {any} */
  let state = null;
  let clock = 1_793_000_000_000;

  for (let run = 0; run < runs; run += 1) {
    const before = duskEvm.asked.length;
    const sync = await syncWithdrawals({ address: EVM, duskEvm, maxRequests, network: TESTNET, now: () => clock, state });

    assert.equal(sync.requests, duskEvm.asked.length - before, `run ${run}: the requests it made`);
    for (const entry of sync.found) found.set(entry.hash, (found.get(entry.hash) ?? 0) + 1);
    requests.push(sync.requests);
    state = sync.state;
    clock += every;
    duskEvm.final += step;
  }

  return { found, requests, state };
}

describe("a sync of an address's withdrawals", () => {
  it("counts both head requests against its requests where the RPC has no finalized block (#31)", async () => {
    const duskEvm = duskEvmOf([], { final: 3_905_000, finalized: false });
    const sync = await syncWithdrawals({ address: EVM, duskEvm, maxRequests: 3, network: TESTNET });

    assert.deepEqual(duskEvm.asked, ["eth_getBlockByNumber", "eth_blockNumber", "eth_getLogs"]);
    assert.equal(sync.requests, 3);
  });

  it("reads the last 1,800 blocks under a head the RPC didn't call final again on the next run, so a deeper reorg there is found (#32)", async () => {
    // No finalized block: the latest less 1,800 is taken as final, 300,000 here. Synced up to 299,550 before.
    /** @type {ReturnType<typeof withdrawalLog>[]} */
    const logs = [];
    const duskEvm = duskEvmOf(logs, { final: 300_000, finalized: false });
    const clock = 1_793_000_000_000;
    const first = await syncWithdrawals({ address: EVM, duskEvm, network: TESTNET, now: () => clock, state: { covered: [[0, 299_550]], entries: {}, target: 299_550, window: L2_WINDOW } });

    // A reorg deeper than the margin puts a withdrawal in a block the run read under that head, without it.
    logs.push(withdrawalLog(1, 299_000));
    // The next run is 150,000 blocks on: the newest blocks it reads don't reach back there.
    duskEvm.final = 450_000;

    const next = await syncWithdrawals({ address: EVM, duskEvm, network: TESTNET, now: () => clock + 15 * MINUTE, state: first.state });

    assert.deepEqual(
      next.found.map((entry) => [entry.hash, entry.blockNumber]),
      [[h(1), 299_000]]
    );
    // Each run keeps its last 1,800 blocks open. The second's requests: the head's two, the newest blocks, and those with the new ones under them.
    assert.equal(first.state.target, 300_000);
    assert.deepEqual(first.state.covered, [[0, 298_200]]);
    assert.equal(next.requests, 4);
    assert.deepEqual(next.state.covered, [[0, 448_200]]);

    // Found once: the run after reads those blocks again, and gives it no more.
    duskEvm.final += 450;

    const after = await syncWithdrawals({ address: EVM, duskEvm, network: TESTNET, now: () => clock + 30 * MINUTE, state: next.state });

    assert.deepEqual(after.found, []);
    assert.ok(after.state.entries[h(1)]);
  });

  it("finds a withdrawal an answer left out, reading the blocks again an hour after it covered them all (#40)", async () => {
    // Its block's first answer comes back without it.
    const duskEvm = duskEvmOf([withdrawalLog(1, 150_000)], { final: 300_000, hold: new Map([[150_000, 1]]) });
    const { found, requests } = await syncs(duskEvm, { every: 15 * MINUTE, runs: 8, step: 450 });

    assert.deepEqual([...found], [[h(1), 1]]);
    // The head and the newest blocks on each run, and an hour on, the blocks all read again: four windows more.
    assert.deepEqual(requests, [5, 2, 2, 2, 6, 2, 2, 2]);
  });

  it("reads the newest final blocks again on each run, below the new ones", async () => {
    // A withdrawal just final, its first answer without it.
    const duskEvm = duskEvmOf([withdrawalLog(1, 300_200)], { final: 300_000, hold: new Map([[300_200, 1]]) });
    const { found, requests } = await syncs(duskEvm, { every: 15 * MINUTE, runs: 3, step: 450 });

    assert.deepEqual([...found], [[h(1), 1]]);
    assert.deepEqual(requests, [5, 2, 2]);
  });

  it("reads the newest final blocks again on a run whose final head hasn't moved", async () => {
    // Synced up to 300,000, a withdrawal at 290,000 that an answer left out.
    const duskEvm = duskEvmOf([withdrawalLog(1, 290_000)], { final: 300_000 });
    const sync = await syncWithdrawals({ address: EVM, duskEvm, network: TESTNET, state: { covered: [[0, 300_000]], entries: {}, target: 300_000, window: L2_WINDOW } });

    assert.deepEqual(
      sync.found.map((entry) => entry.hash),
      [h(1)]
    );
    // The head, and the newest blocks in one window.
    assert.equal(sync.requests, 2);
  });

  it("reads the newest 50,000 final blocks again in as many windows as they take, where the RPC takes fewer blocks", async () => {
    // Synced up to 300,000 in windows of 25,000, the head 450 blocks on: a withdrawal at 270,000 that an answer left out.
    const duskEvm = duskEvmOf([withdrawalLog(1, 270_000)], { final: 300_450 });
    const sync = await syncWithdrawals({ address: EVM, duskEvm, network: TESTNET, state: { covered: [[0, 300_000]], entries: {}, target: 300_000, window: 25_000 } });

    assert.deepEqual(
      sync.found.map((entry) => entry.hash),
      [h(1)]
    );
    // The head, and the newest blocks, the new ones among them, in two windows.
    assert.equal(sync.requests, 3);
  });

  it("reads the newest blocks again in half a run's requests at most, the rest for older blocks", async () => {
    // Windows of 6,250 blocks, the final head 450 blocks on from 300,000, blocks under 200,000 not read yet.
    const duskEvm = duskEvmOf([], { final: 300_450 });
    const sync = await syncWithdrawals({ address: EVM, duskEvm, network: TESTNET, state: { covered: [[200_000, 300_000]], entries: {}, target: 300_000, window: 6_250 } });

    assert.equal(sync.requests, 8);
    // Three windows at the head, then four below what was covered.
    assert.deepEqual(sync.state.covered, [[175_000, 300_450]]);
  });

  it("leaves a run under the same final head as the last to the older blocks while they're still to be read", async () => {
    const duskEvm = duskEvmOf([], { final: 4_200_000 });
    const first = await syncWithdrawals({ address: EVM, duskEvm, network: TESTNET });
    const second = await syncWithdrawals({ address: EVM, duskEvm, network: TESTNET, state: first.state });

    assert.deepEqual(first.state.covered, [[3_500_001, 4_200_000]]);
    // Seven windows below, none at the head.
    assert.deepEqual(second.state.covered, [[2_800_001, 4_200_000]]);
  });

  it("finds each withdrawal once, where a third of the answers come back without their logs", async () => {
    for (const seed of SEEDS) {
      // A dozen withdrawals over 2,000,000 final blocks, and eight more over a week of runs every 15 minutes.
      const logs = [
        ...Array.from({ length: 12 }, (_, i) => withdrawalLog(i + 1, 10_000 + i * 165_000)),
        ...Array.from({ length: 8 }, (_, i) => withdrawalLog(i + 13, 2_000_000 + 1_000 + i * 37_800)),
      ];
      const duskEvm = duskEvmOf(logs, { final: 2_000_000, rate: 1 / 3, seed });
      const { found, requests } = await syncs(duskEvm, { every: 15 * MINUTE, runs: 7 * 96, step: 450 });

      assert.deepEqual(
        [...found].sort(),
        logs.map((log) => [log.transactionHash, 1]).sort(),
        `seed ${seed}`
      );
      assert.ok(Math.max(...requests) <= 8, `seed ${seed}: ${Math.max(...requests)} requests in a run`);
    }
  });

  it("costs the head and the newest blocks on each run once all is covered, and a pass over them all now and then", async () => {
    const duskEvm = duskEvmOf([], { final: 2_000_000 });
    const { requests } = await syncs(duskEvm, { every: 15 * MINUTE, runs: 7 * 96, step: 450 });
    // From nothing: 21 windows of 100,000 blocks, 7 a run.
    const [first, second, third, ...rest] = requests;

    assert.deepEqual([first, second, third], [8, 8, 8]);
    // A week of runs every 15 minutes: the passes an hour after all was covered, then two, four, ... about 21 windows each.
    const total = rest.reduce((a, b) => a + b, 0);

    assert.ok(total <= rest.length * 2 + 8 * 24, `${total} requests over ${rest.length} runs`);
    assert.ok(rest.filter((n) => n === 2).length >= rest.length - 8 * 4, "two requests a run, but for the passes");
  });
});
