import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks, routes } from "@dusk-network/networks";

import { STATUS_MAX_AGE_MS, bridgeStatus } from "../src/bridge.js";
import { hex, fakeChain } from "./fixtures/bridge.js";
import { fakeArchive, readFixture } from "./fixtures/helpers.js";

// Recorded on 2026-11-05: BSC's route on mainnet, and DuskEVM's on testnet.
const { mainnet, testnet } = readFixture("bridge-status.json");
const NODE = networks.mainnet.urls.node;
const BSC = /** @type {any} */ (routes(networks.mainnet).find((route) => route.id === "dusk-to-bsc"));
/** When mainnet's was recorded: the head of BNB Smart Chain's time. */
const NOW = mainnet.bsc.headTime * 1000;
const [PAYOUT, POISON] = mainnet.bsc.logs;
const PAYOUT_BLOCK = BigInt(PAYOUT.blockNumber);
const PAYOUT_SECONDS = Number(PAYOUT.blockTimestamp);
/** BNB Smart Chain's pace when it was recorded: a block every 0.45 seconds. */
const bscTime = (/** @type {bigint} */ block) => PAYOUT_SECONDS + Math.round(Number(block - PAYOUT_BLOCK) * 0.45);

/** A recorded log as `fakeChain` answers it. @param {any} log */
const chainLog = (log) => ({ address: log.address, block: BigInt(log.blockNumber), data: log.data, hash: log.transactionHash, topics: log.topics });

/**
 * BSC's route as it was recorded: the node and archive of Dusk, and the chain.
 *
 * @param {{ head?: bigint, logs?: any[], sent?: any[], received?: any[], down?: boolean, chainDown?: boolean, maxRange?: bigint }} [options]
 */
function bscRoute({ chainDown = false, down = false, head = BigInt(mainnet.bsc.head), logs = mainnet.bsc.logs.map(chainLog), maxRange, received = mainnet.received, sent = mainnet.sent } = {}) {
  const archive = fakeArchive({ accounts: { [BSC.account]: { receiver: received, sender: sent } }, details: mainnet.details, finalized: mainnet.finalized, url: NODE });
  const chain = fakeChain({ head, logs, maxRange, stamps: true, timeAt: bscTime });
  const route = {
    archive,
    chain,
    /** @type {string[]} */
    asked: [],
    /** @param {string} url @param {any} init */
    fetch: async (url, init) => {
      route.asked.push(String(url));

      if (String(url) === `${NODE}/on/account:${BSC.account}/status`) {
        if (down) throw new TypeError("fetch failed");

        return new Response(mainnet.accountStatus);
      }

      if (String(url).startsWith(NODE)) {
        if (down) throw new TypeError("fetch failed");

        return archive.fetch(url, init);
      }

      if (chainDown) throw new TypeError("fetch failed");

      const { method, params } = JSON.parse(init.body);

      if (method === "eth_getBalance") {
        chain.calls.push({ method, params, url: String(url) });

        return new Response(JSON.stringify({ id: 1, jsonrpc: "2.0", result: mainnet.bsc.gasWei }));
      }

      return chain.fetch(url, init);
    },
  };

  return route;
}

describe("how a migration route is doing", () => {
  it("says its last payout, and what its payout account holds, to the lux, past what a JSON number holds", async () => {
    const route = bscRoute();
    const status = await bridgeStatus({ fetch: route.fetch, network: 1, now: NOW, route: "bsc-to-dusk" });

    assert.equal(status.canPay, 21_603_964_301_316_070n);
    assert.equal(status.limit, "balance");
    assert.deepEqual(status.lastPayout, { amount: 54_325_305_359n, at: 1793632177000, block: 5657897, hash: mainnet.sent[1].origin });
    assert.equal(status.paying, "yes");
    assert.equal(status.running, true);
    assert.equal(status.gas, null);
    assert.equal(status.error, "");
    // The head, the account's newest, its time and its balance.
    assert.equal(status.requests, 4);
    assert.equal(route.asked.length, 4);
  });

  it("doesn't take an operator's other transfer for a payout", async () => {
    const other = structuredClone(mainnet.sent[1]);

    // A later transfer with an ordinary memo, of the same account.
    other.block_height += 1000;
    other.origin = "ab".repeat(32);
    other.events[0].data.memo = Buffer.from("topping up").toString("hex");

    const status = await bridgeStatus({ fetch: bscRoute({ sent: [...mainnet.sent, other] }).fetch, network: 1, now: NOW, route: "bsc-to-dusk" });

    assert.equal(status.lastPayout?.hash, mainnet.sent[1].origin);
  });

  it("is quiet where the last payout is long ago, and says so where there's none in 30 days", async () => {
    const later = await bridgeStatus({ fetch: bscRoute().fetch, network: 1, now: NOW + 8 * 86_400_000, route: "bsc-to-dusk" });

    assert.equal(later.paying, "quiet");
    assert.equal(later.lastPayout?.hash, mainnet.sent[1].origin);

    const none = await bridgeStatus({ fetch: bscRoute({ sent: [] }).fetch, network: 1, now: NOW, route: "bsc-to-dusk" });

    assert.equal(none.paying, "quiet");
    assert.equal(none.lastPayout, null);
    assert.equal(none.readSince, NOW - 30 * 86_400_000);
    assert.equal(none.canPay, 21_603_964_301_316_070n);
  });
});

describe("how a route out to another chain is doing", () => {
  it("doesn't read a balance that says nothing: its payout address holds no token, and mints what it pays", async () => {
    // Recorded: none between payouts, though it paid 20,300 DUSK a day before.
    assert.equal(BigInt(mainnet.bsc.tokenBalance), 0n);

    const route = bscRoute({ head: PAYOUT_BLOCK + 100_000n });
    const status = await bridgeStatus({ fetch: route.fetch, network: 1, now: NOW, route: "dusk-to-bsc" });

    assert.equal(status.canPay, null);
    assert.equal(status.limit, "mints");
    assert.deepEqual(status.gas, { coin: "BNB", wei: BigInt(mainnet.bsc.gasWei) });
  });

  it("takes the newest payout that paid something, not a Transfer of nothing someone else's transaction wrote", async () => {
    // Recorded after the payout, from its address, of nothing.
    assert.equal(BigInt(POISON.data), 0n);
    assert.ok(BigInt(POISON.blockNumber) > PAYOUT_BLOCK);

    const status = await bridgeStatus({ fetch: bscRoute({ head: PAYOUT_BLOCK + 100_000n }).fetch, network: 1, now: NOW, route: "dusk-to-bsc" });

    assert.deepEqual(status.lastPayout, { amount: 20_300_000_000_000n, at: PAYOUT_SECONDS * 1000, block: Number(PAYOUT_BLOCK), hash: PAYOUT.transactionHash });
    assert.equal(status.paying, "yes");
    // Nothing else is found to say it's more recent.
    assert.equal(status.readSince, null);
  });

  it("says a transfer in waits, and that it's only late past twice the route's usual time", async () => {
    const newest = mainnet.details[mainnet.received.at(-1).origin].blockTimestamp * 1000;
    const head = PAYOUT_BLOCK + 100_000n;

    assert.ok(newest > PAYOUT_SECONDS * 1000, "it came in after the last payout");

    const soon = await bridgeStatus({ fetch: bscRoute({ head }).fetch, network: 1, now: newest + 3_600_000, route: "dusk-to-bsc" });

    assert.equal(soon.waitingSince, newest);
    assert.equal(soon.paying, "yes");

    const overdue = await bridgeStatus({ fetch: bscRoute({ head }).fetch, network: 1, now: newest + 2 * BSC.typicalSeconds * 1000 + 1, route: "dusk-to-bsc" });

    assert.equal(overdue.paying, "late");
    assert.equal(overdue.waitingSince, newest);
  });

  it("doesn't wait for what it won't pay: a transfer in that's no more than its fee, or names no address", async () => {
    const unpayable = structuredClone(mainnet.received.at(-1));

    unpayable.events[0].data.value = "1000000000";

    const under = await bridgeStatus({ fetch: bscRoute({ head: PAYOUT_BLOCK + 100_000n, received: [...mainnet.received.slice(0, -1), unpayable] }).fetch, network: 1, now: NOW, route: "dusk-to-bsc" });

    // The one before it was paid, as its payout came after it.
    assert.equal(under.waitingSince, null);

    const noAddress = structuredClone(mainnet.received.at(-1));

    noAddress.events[0].data.memo = Buffer.from("hello").toString("hex");

    const none = await bridgeStatus({ fetch: bscRoute({ head: PAYOUT_BLOCK + 100_000n, received: [...mainnet.received.slice(0, -1), noAddress] }).fetch, network: 1, now: NOW, route: "dusk-to-bsc" });

    assert.equal(none.waitingSince, null);
  });

  it("no longer waits once a payout came after it", async () => {
    const newest = mainnet.details[mainnet.received.at(-1).origin].blockTimestamp;
    const after = chainLog({ ...PAYOUT, blockNumber: hex(PAYOUT_BLOCK + BigInt(Math.ceil((newest - PAYOUT_SECONDS) / 0.45)) + 10n), transactionHash: `0x${"cd".repeat(32)}` });
    const status = await bridgeStatus({ fetch: bscRoute({ head: after.block + 1000n, logs: [chainLog(PAYOUT), after] }).fetch, network: 1, now: NOW, route: "dusk-to-bsc" });

    assert.equal(status.lastPayout?.hash, after.hash);
    assert.equal(status.waitingSince, null);
    assert.equal(status.paying, "yes");
  });

  it("makes a few requests at most, and says how far back it read where it found none", async () => {
    // As it was recorded: the last payout 213,837 blocks back, past what one read reaches at 50,000 a search.
    const route = bscRoute();
    const cache = new Map();
    const first = await bridgeStatus({ cache, fetch: route.fetch, network: 1, now: NOW, route: "dusk-to-bsc" });
    const logs = route.chain.ranges();

    assert.equal(logs.length, 5, "a search for each 50,000 blocks, up to the payout");
    assert.ok(logs.every(([from, to]) => to - from < 50_000n));
    assert.equal(first.lastPayout?.hash, PAYOUT.transactionHash);
    assert.ok(first.requests <= 12, String(first.requests));
  });

  it("reads on from where it stopped, and only the new blocks once it's found one", async () => {
    // Its payout further back than one read reaches.
    const head = PAYOUT_BLOCK + 700_000n;
    const route = bscRoute({ head });
    const cache = new Map();
    const first = await bridgeStatus({ cache, fetch: route.fetch, network: 1, now: NOW, route: "dusk-to-bsc" });

    assert.equal(first.lastPayout, null);
    assert.equal(first.readSince, bscTime(head - 400_000n + 1n) * 1000);
    assert.equal(first.paying, "quiet");
    assert.equal(route.chain.ranges().length, 8);

    // A later read, past its keeping, starts where the first stopped.
    route.chain.calls.length = 0;

    const second = await bridgeStatus({ cache, fetch: route.fetch, network: 1, now: NOW + STATUS_MAX_AGE_MS + 1, route: "dusk-to-bsc" });

    assert.equal(second.lastPayout?.hash, PAYOUT.transactionHash);
    assert.ok(route.chain.ranges().every(([, to]) => to < head - 400_000n + 1n), "under what was read");

    // The next only reads what's new, which is nothing yet.
    route.chain.calls.length = 0;

    const third = await bridgeStatus({ cache, fetch: route.fetch, network: 1, now: NOW + 2 * STATUS_MAX_AGE_MS + 2, route: "dusk-to-bsc" });

    assert.deepEqual(route.chain.ranges(), []);
    assert.equal(third.lastPayout?.hash, PAYOUT.transactionHash);
  });

  it("starts afresh after a long time, rather than leave blocks unread", async () => {
    const cache = new Map();
    const first = bscRoute({ head: PAYOUT_BLOCK + 100_000n });

    await bridgeStatus({ cache, fetch: first.fetch, network: 1, now: NOW, route: "dusk-to-bsc" });

    const later = bscRoute({ head: PAYOUT_BLOCK + 100_000n + 9n * 50_000n });
    const status = await bridgeStatus({ cache, fetch: later.fetch, network: 1, now: NOW + 86_400_000, route: "dusk-to-bsc" });

    assert.equal(later.chain.ranges().length, 8);
    assert.equal(status.lastPayout, null);
  });

  it("takes fewer blocks at once where an RPC asks for it", async () => {
    const route = bscRoute({ head: PAYOUT_BLOCK + 2_000n, maxRange: 10_000n });
    const status = await bridgeStatus({ fetch: route.fetch, network: 1, now: NOW, route: "dusk-to-bsc" });

    assert.equal(status.lastPayout?.hash, PAYOUT.transactionHash);
  });

  it("doesn't call a quiet route late on what it hasn't read", async () => {
    // A transfer in long ago, and blocks read only since after it: a payout may be before them.
    const head = PAYOUT_BLOCK + 2_000_000n;
    const status = await bridgeStatus({ fetch: bscRoute({ head }).fetch, network: 1, now: NOW + 30 * 86_400_000, route: "dusk-to-bsc" });

    assert.notEqual(status.paying, "late");
  });
});

describe("how DuskEVM's routes are doing", () => {
  const evm = /** @type {NonNullable<typeof networks.testnet.duskEvm>} */ (networks.testnet.duskEvm);
  const NOW_TESTNET = testnet.headTime * 1000;
  const [LOG] = testnet.logs;

  it("says a deposit's last credit, on DuskEVM's own bridge; it has no balance to run out of", async () => {
    const chain = fakeChain({ head: BigInt(testnet.head), logs: testnet.logs.map(chainLog), stamps: true, timeAt: (block) => Number(LOG.blockTimestamp) + 2 * Number(block - BigInt(LOG.blockNumber)) });
    const status = await bridgeStatus({ fetch: chain.fetch, network: 2, now: NOW_TESTNET, route: "dusk-to-dusk-evm" });

    assert.deepEqual(status.lastPayout, { amount: 3_000_000_000n, at: Number(LOG.blockTimestamp) * 1000, block: Number(BigInt(LOG.blockNumber)), hash: LOG.transactionHash });
    assert.equal(status.paying, "yes");
    assert.equal(status.limit, "mints");
    assert.equal(status.canPay, null);
    assert.equal(chain.calls[1].params[0].address, evm.predeploys.l2StandardBridge.toLowerCase());
  });

  it("says what a withdrawal can be paid from, the L1 bridge's balance, and that its owner claims it", async () => {
    /** @type {any[]} */
    const asked = [];
    const status = await bridgeStatus({
      fetch: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
        asked.push([url, Buffer.from(init.body).toString("hex")]);

        return new Response(Buffer.from(testnet.bridgeBalance, "hex"));
      }),
      network: 2,
      now: NOW_TESTNET,
      route: "dusk-evm-to-dusk",
    });

    assert.equal(status.canPay, 367_863_808_000_000n);
    assert.equal(status.limit, "balance");
    assert.equal(status.paying, "on-claim");
    assert.equal(status.lastPayout, null);
    assert.equal(status.requests, 1);
    assert.deepEqual(asked, [[`${networks.testnet.urls.node}/on/contracts:${networks.testnet.contracts.transfer}/contract_balance`, evm.contracts.l1_standard_bridge.contractId]]);
  });
});

describe("a read of a route's status", () => {
  it("asks nothing of a route that isn't running", async () => {
    const status = await bridgeStatus({ fetch: /** @type {any} */ (() => assert.fail("nothing to ask")), network: 2, route: "dusk-to-ethereum" });

    assert.equal(status.paying, "stopped");
    assert.equal(status.running, false);
    assert.equal(status.requests, 0);
    assert.equal(status.lastPayout, null);
  });

  it("is one read on opening the page, kept, as a cache of text keeps it", async () => {
    const route = bscRoute();
    const cache = new Map();
    const first = await bridgeStatus({ cache, fetch: route.fetch, network: 1, now: NOW, route: "bsc-to-dusk" });
    const asked = route.asked.length;
    const again = await bridgeStatus({ cache, fetch: route.fetch, network: 1, now: NOW + STATUS_MAX_AGE_MS - 1, route: "bsc-to-dusk" });

    assert.equal(route.asked.length, asked);
    assert.deepEqual(again, { ...first, requests: 0 });
    assert.ok([...cache.values()].every((value) => typeof value === "string"));

    const later = await bridgeStatus({ cache, fetch: route.fetch, network: 1, now: NOW + STATUS_MAX_AGE_MS, route: "bsc-to-dusk" });

    assert.ok(route.asked.length > asked);
    assert.equal(later.readAt, NOW + STATUS_MAX_AGE_MS);
  });

  it("makes one read of two at once", async () => {
    const route = bscRoute();
    const cache = new Map();
    const [one, two] = await Promise.all([1, 2].map(() => bridgeStatus({ cache, fetch: route.fetch, network: 1, now: NOW, route: "bsc-to-dusk" })));

    assert.equal(route.asked.length, 4);
    assert.deepEqual(one, two);
  });

  it("keeps each route's and each network's apart", async () => {
    const route = bscRoute();
    const cache = new Map();
    const migration = await bridgeStatus({ cache, fetch: route.fetch, network: 1, now: NOW, route: "bsc-to-dusk" });
    const out = await bridgeStatus({ cache, fetch: route.fetch, network: 1, now: NOW, route: "dusk-to-bsc" });

    assert.notEqual(migration.route, out.route);
    assert.equal(out.limit, "mints");
  });

  it("says what it could read, and why not the rest, and tries again next time", async () => {
    const cache = new Map();
    const chainDown = await bridgeStatus({ cache, fetch: bscRoute({ chainDown: true }).fetch, network: 1, now: NOW, route: "dusk-to-bsc" });

    assert.equal(chainDown.paying, "unknown");
    assert.equal(chainDown.lastPayout, null);
    assert.match(chainDown.error, /fetch failed/);

    const fixed = bscRoute({ head: PAYOUT_BLOCK + 100_000n });
    const again = await bridgeStatus({ cache, fetch: fixed.fetch, network: 1, now: NOW + 1, route: "dusk-to-bsc" });

    assert.ok(fixed.asked.length > 0);
    assert.equal(again.paying, "yes");
    assert.equal(again.error, "");

    const nodeDown = await bridgeStatus({ fetch: bscRoute({ down: true }).fetch, network: 1, now: NOW, route: "bsc-to-dusk" });

    assert.equal(nodeDown.paying, "unknown");
    assert.equal(nodeDown.canPay, null);
    assert.match(nodeDown.error, /fetch failed/);
  });

  it("refuses a route the network doesn't have", async () => {
    await assert.rejects(bridgeStatus({ network: 1, route: "dusk-to-the-moon" }), TypeError);
    await assert.rejects(bridgeStatus({ network: 99, route: "dusk-to-bsc" }), TypeError);
  });

  it("uses the app's own archive, node and RPC where it's given them", async () => {
    const route = bscRoute({ head: PAYOUT_BLOCK + 1000n });
    const chainUrls = new Set();
    const status = await bridgeStatus({
      archive: route.archive.archiveClient(),
      fetch: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
        chainUrls.add(url);

        return route.fetch(url === "https://my.rpc" ? BSC.chain.rpcUrl : url, init);
      }),
      network: 1,
      now: NOW,
      route: "dusk-to-bsc",
      rpcUrl: "https://my.rpc",
    });

    assert.equal(status.lastPayout?.hash, PAYOUT.transactionHash);
    assert.deepEqual([...chainUrls], ["https://my.rpc"]);
  });
});

describe("a read that can't finish", () => {
  it("doesn't call a list too full to read to its end a route with no payouts", async () => {
    // Plain transfers fill every page, and pages run oldest first.
    const sent = Array.from({ length: 400 }, (_, i) => {
      const entry = structuredClone(mainnet.sent[0]);

      entry.block_height -= 400 - i;
      for (const event of entry.events ?? []) if (event.data?.memo !== undefined) event.data.memo = "";

      return entry;
    });
    const status = await bridgeStatus({ fetch: bscRoute({ sent }).fetch, network: 1, now: NOW, route: "bsc-to-dusk" });

    assert.equal(status.lastPayout, null);
    assert.equal(status.readSince, null);
    assert.equal(status.paying, "unknown");
  });

  it("finds a payout in a stretch a narrowed read didn't reach, on the reads after", async () => {
    const start = BigInt(mainnet.bsc.head);
    const cache = new Map();
    const at = start + 30_000n;
    const logs = [...mainnet.bsc.logs.map(chainLog), { ...chainLog(PAYOUT), block: at, hash: `0x${"ab".repeat(32)}` }];

    await bridgeStatus({ cache, fetch: bscRoute({ head: start, logs: mainnet.bsc.logs.map(chainLog) }).fetch, network: 1, now: NOW, route: "dusk-to-bsc" });

    let status;

    for (let read = 1; read <= 12; read += 1) {
      status = await bridgeStatus({ cache, fetch: bscRoute({ head: start + 90_000n, logs, maxRange: 5_000n }).fetch, network: 1, now: NOW + read * (STATUS_MAX_AGE_MS + 1), route: "dusk-to-bsc" });

      // Reading on doesn't lose the payout already known, nor say a route is late while it's still behind.
      assert.notEqual(status.lastPayout, null);
      assert.notEqual(status.paying, "late");

      if (status.lastPayout?.block === Number(at)) break;
    }

    assert.equal(status?.lastPayout?.block, Number(at));
  });
});
