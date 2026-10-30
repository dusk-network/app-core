import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, pad } from "viem";

import {
  ETH_BRIDGE_INITIATED_TOPIC,
  L2_WINDOW,
  explorerStage,
  explorerWithdrawals,
  syncWithdrawals,
  withdrawalCall,
  withdrawalsByNonce,
} from "../src/duskevm-withdrawals.js";
import { PAID, TESTNET, USER2, paysAccount } from "./fixtures/withdrawals.js";

const EVM = "0x3e5b8223e638cb414bef8cf95393460ca1c3a11d";
const BRIDGE = "0x4200000000000000000000000000000000000010";
const h = (/** @type {number} */ n) => n.toString(16).padStart(64, "0");

/**
 * The bridge's ETHBridgeInitiated log of a withdrawal from EVM.
 *
 * @param {number} n
 * @param {number} block
 * @param {string} [recipient]
 */
const withdrawalLog = (n, block, recipient = USER2, amount = 2n * 10n ** 18n) => ({
  blockNumber: `0x${block.toString(16)}`,
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [amount, paysAccount(recipient)]),
  topics: [ETH_BRIDGE_INITIATED_TOPIC, pad(EVM), pad(EVM)],
  transactionHash: `0x${h(n)}`,
});

describe("an address's withdrawals, from the bridge's logs", () => {
  it("are found by the sender, a window at a time, from the newest final block", async () => {
    const head = 3_905_000;
    const logs = [withdrawalLog(1, head - 50_000), withdrawalLog(2, head - 350_000, PAID), withdrawalLog(3, 10)];
    /** @type {[string, any[]][]} */
    const calls = [];
    const duskEvm = {
      /** @param {{ method: string, params: any[] }} request */
      request: async ({ method, params }) => {
        calls.push([method, params]);

        if (method === "eth_getBlockByNumber") return { number: `0x${head.toString(16)}` };

        const [{ address, fromBlock, toBlock, topics }] = params;
        const [from, to] = [Number(fromBlock), Number(toBlock)];

        if (to - from + 1 > 100_000) throw Object.assign(new Error("query exceeds max block range 100000"), { code: -32602 });

        assert.equal(address, BRIDGE);
        assert.deepEqual(topics, [ETH_BRIDGE_INITIATED_TOPIC, pad(EVM)]);

        return logs.filter((log) => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to);
      },
    };
    const first = await syncWithdrawals({ address: EVM, duskEvm, maxRequests: 5, network: TESTNET, now: () => 7 });

    assert.deepEqual(
      first.found.map((entry) => [entry.hash, entry.destination, entry.amountWei]),
      [
        [`0x${h(1)}`, USER2, "2000000000000000000"],
        [`0x${h(2)}`, PAID, "2000000000000000000"],
      ]
    );
    assert.equal(calls.filter(([method]) => method === "eth_getLogs").length, 4);
    assert.deepEqual(first.state, { covered: [[head - 400_000 + 1, head]], entries: first.state.entries, target: head, updatedAt: 7, window: L2_WINDOW });
    assert.equal(first.requests, 5);
  });

  it("narrow the window for an RPC that answers fewer blocks, and skip none", async () => {
    const head = 3_905_000;
    const narrow = await syncWithdrawals({
      bridge: BRIDGE,
      address: EVM,
      duskEvm: {
        request: async ({ method, params }) => {
          if (method === "eth_getBlockByNumber") return { number: `0x${head.toString(16)}` };

          const [{ fromBlock, toBlock }] = params;

          if (Number(toBlock) - Number(fromBlock) + 1 > 25_000) throw new Error("block range limit exceeded");

          return [];
        },
      },
      maxRequests: 4,
    });

    assert.equal(narrow.state.window, 25_000);
    assert.deepEqual(narrow.state.covered, [[head - 50_000 + 1, head]]);
  });

  it("cover final blocks only, read what is new above, and carry on below", async () => {
    const head = 3_905_000;
    const latest = head + 600;
    let finalized = head;
    const duskEvm = {
      /** @param {{ method: string, params: any[] }} request */
      request: async ({ method, params }) => {
        if (method === "eth_getBlockByNumber") return { number: `0x${finalized.toString(16)}` };

        const [{ fromBlock, toBlock }] = params;

        return [withdrawalLog(4, head + 300)].filter((log) => Number(log.blockNumber) >= Number(fromBlock) && Number(log.blockNumber) <= Number(toBlock));
      },
    };
    // Coverage an older run kept above the final head is read again.
    const kept = { covered: [[head - 1_000, latest]], entries: {}, target: latest, window: 100_000 };
    const before = await syncWithdrawals({ address: EVM, duskEvm, maxRequests: 3, network: TESTNET, state: kept });

    assert.deepEqual(before.found, []);
    assert.equal(Math.max(...before.state.covered.map(([, hi]) => hi)), head);

    finalized = latest;

    const after = await syncWithdrawals({ address: EVM, duskEvm, maxRequests: 3, network: TESTNET, state: before.state });

    assert.deepEqual(
      after.found.map((entry) => entry.hash),
      [`0x${h(4)}`]
    );
    // Found once: a later run that reads it again doesn't give it again.
    const again = await syncWithdrawals({ address: EVM, duskEvm, maxRequests: 3, network: TESTNET, state: { ...after.state, covered: [] } });

    assert.deepEqual(again.found, []);
    assert.ok(again.state.entries[`0x${h(4)}`]);
  });

  it("take the latest block less about an hour where the RPC has no finalized block", async () => {
    const latest = 3_905_600;
    const older = await syncWithdrawals({
      address: EVM,
      duskEvm: {
        request: async ({ method }) => {
          if (method === "eth_getBlockByNumber") throw new Error("invalid block tag");
          if (method === "eth_blockNumber") return `0x${latest.toString(16)}`;

          return [];
        },
      },
      maxRequests: 2,
      network: TESTNET,
    });

    assert.equal(older.state.target, latest - 1_800);
  });

  it("go through a URL and fetch as well as a viem client", async () => {
    /** @type {any[]} */
    const posted = [];
    const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
      const { method } = JSON.parse(init.body);

      posted.push([url, method]);

      return new Response(JSON.stringify({ id: 1, jsonrpc: "2.0", result: method === "eth_getBlockByNumber" ? { number: "0x10" } : [] }));
    };

    await syncWithdrawals({ address: EVM, duskEvm: { fetch: /** @type {any} */ (fetch), url: "https://rpc.example.test" }, maxRequests: 2, network: TESTNET });
    assert.deepEqual(posted, [
      ["https://rpc.example.test", "eth_getBlockByNumber"],
      ["https://rpc.example.test", "eth_getLogs"],
    ]);
    await assert.rejects(syncWithdrawals({ address: "0x1234", duskEvm: { fetch: /** @type {any} */ (fetch), url: "https://rpc.example.test" } }), TypeError);
  });
});

describe("an address's withdrawals, from DuskEVM's explorer", () => {
  const API = "https://explorer.example.test/api/v2";
  const account = "0x2222222222222222222222222222222222222222";
  const withdrawalHash = `0x${"44".repeat(32)}`;

  /**
   * @param {unknown} body
   * @param {number} [status]
   */
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

  it("are its calls of the bridge's bridgeETHTo, with what the explorer says of each and whom it pays", async () => {
    const { data: rawInput } = withdrawalCall(TESTNET, { amountWei: 10n ** 17n, sender: account, to: PAID });
    /** @type {string[]} */
    const asked = [];
    const fetch = async (/** @type {string} */ url) => {
      asked.push(url);

      if (url.includes(`/transactions/${withdrawalHash}`)) {
        return json({
          ["block_number"]: 124,
          from: { hash: account },
          hash: withdrawalHash,
          ["op_withdrawals"]: [
            {
              ["challenge_period_end"]: "2026-07-15T10:00:00Z",
              ["l1_transaction_hash"]: null,
              ["l2_timestamp"]: "2026-07-14T10:00:00Z",
              ["msg_value"]: "100000000000000000",
              status: "Ready to prove",
            },
          ],
          ["raw_input"]: rawInput,
          status: "ok",
          timestamp: "2026-07-14T10:00:00Z",
          to: { hash: BRIDGE },
          value: "100000000000000000",
        });
      }

      return json({
        items: [
          // Its withdrawal.
          { from: { hash: account }, hash: withdrawalHash, ["raw_input"]: `0xe11013dd${"00".repeat(96)}`, status: "ok", timestamp: "2026-07-14T10:00:00Z", to: { hash: BRIDGE }, value: "100000000000000000" },
          // A plain transfer to the bridge, a call elsewhere, and a failed withdrawal.
          { from: { hash: account }, hash: `0x${"77".repeat(32)}`, ["raw_input"]: "0x", status: "ok", to: { hash: BRIDGE }, value: "1" },
          { from: { hash: account }, hash: `0x${"66".repeat(32)}`, status: "ok", to: { hash: "0x3333333333333333333333333333333333333333" } },
          { from: { hash: account }, hash: `0x${"88".repeat(32)}`, ["raw_input"]: rawInput, status: "error", to: { hash: BRIDGE } },
        ],
        ["next_page_params"]: null,
      });
    };
    const items = await explorerWithdrawals({ address: account, fetch: /** @type {any} */ (fetch), network: TESTNET, url: API });

    assert.deepEqual(items, [
      {
        amountWei: "100000000000000000",
        blockNumber: "124",
        destination: PAID,
        explorerStatus: "Ready to prove",
        from: account,
        hash: withdrawalHash,
        l1TransactionHash: null,
        timestamp: "2026-07-14T10:00:00.000Z",
      },
    ]);
    // The explorer's challenge period end is no claim date: the chain says it.
    assert.equal(asked.length, 2);
    assert.match(asked[0], /^https:\/\/explorer\.example\.test\/api\/v2\/addresses\/0x2{40}\/transactions\?filter=from$/);
    assert.equal(explorerStage(items[0].explorerStatus), "ready_to_prove");
  });

  it("are the list's when a transaction's details can't be read, and the explorer's own refusal when the list can't", async () => {
    const listed = { from: { hash: account }, hash: withdrawalHash, ["raw_input"]: `0xe11013dd${"00".repeat(96)}`, status: "ok", timestamp: "2026-07-14T10:00:00Z", to: { hash: BRIDGE }, value: "5" };
    const fetch = async (/** @type {string} */ url) => (url.includes("/transactions/0x") ? json({}, 502) : json({ items: [listed], ["next_page_params"]: null }));

    assert.deepEqual(await explorerWithdrawals({ address: account, fetch: /** @type {any} */ (fetch), network: TESTNET, url: API }), [
      { amountWei: "5", blockNumber: null, destination: null, explorerStatus: null, from: account, hash: withdrawalHash, l1TransactionHash: null, timestamp: "2026-07-14T10:00:00.000Z" },
    ]);
    await assert.rejects(explorerWithdrawals({ address: account, fetch: async () => json({}, 502), network: TESTNET, url: API }), /HTTP 502/);
    // The network's explorer by default.
    /** @type {string[]} */
    const asked = [];

    await explorerWithdrawals({ address: account, fetch: /** @type {any} */ (async (/** @type {string} */ url) => (asked.push(url), json({ items: [] }))), network: TESTNET });
    assert.ok(asked[0].startsWith(`${TESTNET.duskEvm?.blockscoutApiUrl}/addresses/`));
  });

  it("stop at the most items and pages asked, newest first", async () => {
    const item = (/** @type {number} */ n) => ({ from: { hash: account }, hash: `0x${h(n)}`, method: "bridgeETHTo", status: "ok", to: { hash: BRIDGE } });
    let pages = 0;
    const fetch = async (/** @type {string} */ url) => {
      if (url.includes("/transactions/0x")) return json({}, 404);

      pages += 1;

      return json({ items: [item(2 * pages), item(2 * pages + 1)], ["next_page_params"]: { block_number: pages } });
    };
    const items = await explorerWithdrawals({ address: account, fetch: /** @type {any} */ (fetch), maxItems: 3, network: TESTNET, url: API });

    assert.deepEqual(
      items.map((each) => each.hash),
      [`0x${h(2)}`, `0x${h(3)}`, `0x${h(4)}`]
    );
    assert.equal(pages, 2);
  });
});

describe("withdrawals known by their nonces", () => {
  const API = "https://explorer.example.test/api/v2";
  /** A withdrawal's nonce as its proof carries it: version 1, then its count. */
  const nonceOf = (/** @type {number} */ count) => (1n << 240n) | BigInt(count);
  const txOf = (/** @type {number} */ count) => `0x${count.toString(16).padStart(64, "7")}`;
  /** @param {number} count */
  const listed = (count) => ({
    ["challenge_period_end"]: null,
    from: { hash: "0xC11d5aAb4234E255E214aC6e8c0ad61FA0836473" },
    ["l2_timestamp"]: "2026-10-01T12:50:11.000000Z",
    ["l2_transaction_hash"]: txOf(count),
    ["msg_nonce"]: count,
    ["msg_nonce_raw"]: nonceOf(count).toString(),
    ["msg_value"]: "1000000000000000000",
    status: "Proven",
  });

  it("are found on the explorer's list of all withdrawals, however they were sent, never past the oldest asked for", async () => {
    /** @type {string[]} */
    const asked = [];
    const fetch = async (/** @type {string} */ url) => {
      asked.push(url);

      return new Response(
        JSON.stringify(
          new URL(url).searchParams.get("nonce")
            ? { items: [listed(40), listed(39)], ["next_page_params"]: { nonce: 39 } }
            : { items: [listed(43), listed(42), listed(41)], ["next_page_params"]: { nonce: 41 } }
        )
      );
    };
    const found = await withdrawalsByNonce({ fetch: /** @type {any} */ (fetch), network: TESTNET, nonces: [nonceOf(41), nonceOf(40)], url: API });

    assert.deepEqual([...found.keys()], [nonceOf(41).toString(), nonceOf(40).toString()]);
    assert.deepEqual(found.get(nonceOf(41).toString()), {
      amountWei: "1000000000000000000",
      blockNumber: null,
      destination: null,
      explorerStatus: "Proven",
      from: "0xc11d5aab4234e255e214ac6e8c0ad61fa0836473",
      hash: txOf(41),
      l1TransactionHash: null,
      timestamp: "2026-10-01T12:50:11.000Z",
    });
    // The list of all withdrawals, newest first, only until the oldest asked for.
    assert.deepEqual(asked, [`${API}/optimism/withdrawals`, `${API}/optimism/withdrawals?nonce=41`]);
  });

  it("aren't looked for past the pages asked, and the explorer's refusal is the caller's to see", async () => {
    let pages = 0;
    const fetch = async () => {
      pages += 1;

      return new Response(JSON.stringify({ items: [listed(50 - pages)], ["next_page_params"]: { nonce: 50 - pages } }));
    };

    assert.equal((await withdrawalsByNonce({ fetch: /** @type {any} */ (fetch), maxPages: 2, network: TESTNET, nonces: [nonceOf(1)], url: API })).size, 0);
    assert.equal(pages, 2);
    await assert.rejects(
      withdrawalsByNonce({ fetch: async () => new Response("Bad gateway", { status: 502 }), network: TESTNET, nonces: [nonceOf(13)], url: API }),
      /HTTP 502/
    );
  });
});

describe("the explorer's word for a withdrawal", () => {
  for (const [status, stage] of /** @type {const} */ ([
    ["Waiting for state root", "waiting_for_output"],
    ["Ready to prove", "ready_to_prove"],
    ["Waiting a game to resolve", "proven_waiting"],
    ["In challenge period", "proven_waiting"],
    ["Proven", "proven_waiting"],
    ["Ready for relay", "ready_to_finalize"],
    ["Relayed", "finalized"],
    [undefined, null],
    ["Something new", null],
  ])) {
    it(`"${status}" is ${stage}`, () => assert.equal(explorerStage(status), stage));
  }
});
