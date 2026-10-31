#!/usr/bin/env node
/**
 * Counts the requests the apps' bridge views make through this package,
 * which CI doesn't run: each request by where it went and what it asked
 * (its JSON-RPC methods, the archive's GraphQL fields, or the explorer's
 * path), with the bytes each way and the time, through a counting `fetch`.
 * Read-only, on testnet with user1's and user2's accounts, the apps' own
 * options, and one transfer out on mainnet's BNB Smart Chain route, a
 * handful of requests there. It signs and sends nothing.
 *
 * - my-transfers: the bridge site's My transfers on a first visit, user2:
 *   the account's history (6 requests, no details), its entries' details,
 *   and user2's DuskEVM withdrawals (12 requests); then a second visit.
 * - bridge-activity: the web wallet's Bridge activity, user2: its deposits
 *   on DuskEVM's RPC, all at once, and its withdrawals on the explorer.
 * - arrivals: the extension's arrivals, user1: its deposits on the RPC.
 * - withdrawals-sync: user2's withdrawals, synced from nothing, run after
 *   run of 8 requests, then one more run.
 * - waiting: one deposit waiting for its arrival, checked every 15 s.
 * - bsc: one transfer out to BNB Smart Chain on mainnet, from about its
 *   payout's block.
 *
 *   node scripts/measure-reads.js [--only=name,...] [--minutes=5] [--json]
 */

import { networks } from "@dusk-network/networks";

import { depositArrivals, depositOf, serviceArrivals } from "../src/bridge.js";
import { explorerWithdrawals, syncWithdrawals } from "../src/duskevm-withdrawals.js";
import { createArchive, createHistory } from "../src/history.js";

const testnet = networks.testnet;
const duskEvm = /** @type {NonNullable<typeof testnet.duskEvm>} */ (testnet.duskEvm);
// user1 and user2 on testnet, and the DuskEVM address user2 withdraws from.
const USER1 = "qxwSidLBa1rJ74ngfP4GUCaNsAYjMboDPHzbmiVEMmNNK26hVkYe8QccH6ipYdVRsUDnx9QS1KBeu8ZoMDFpXJJE6YCcHy2AykvJ7eEAGc7PGDgCZFV5YJBxzukADkQ2Bgr";
const USER2 = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const USER2_EVM = "0xc11d5aab4234e255e214ac6e8c0ad61fa0836473";
// A transfer out of 70 DUSK on mainnet, paid at block 130,238,733 of BNB Smart Chain.
const OUT = { block: 130_238_000, hash: "da5f4c6aa54a727525ac1d0a5b9e9139a3d504be67c036f1120940764ca2c340" };

const args = process.argv.slice(2);
const only = (args.find((arg) => arg.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const minutes = Number((args.find((arg) => arg.startsWith("--minutes=")) ?? "--minutes=5").slice(10));
const json = args.includes("--json");

/**
 * What a request asked: its JSON-RPC methods, the archive's GraphQL fields
 * with how many of each, or the explorer's path.
 *
 * @param {URL} url
 * @param {string} body
 */
function kindOf(url, body) {
  if (body.startsWith("{") || body.startsWith("[")) {
    try {
      const parsed = JSON.parse(body);
      const calls = Array.isArray(parsed) ? parsed : [parsed];

      if (calls.every((call) => typeof call?.method === "string")) return calls.map((call) => call.method).join("+");
    } catch {
      // Not JSON-RPC.
    }
  }

  if (url.pathname.endsWith("/graphql/query")) {
    /** @type {Record<string, number>} */
    const fields = {};

    // Each field asked is aliased: `m0: transactionsByMemo(…)`, `pair: lastBlockPair { … }`.
    for (const [, field] of body.matchAll(/\w+:\s*(\w+)\s*[({]/g)) fields[field] = (fields[field] ?? 0) + 1;

    return Object.entries(fields)
      .map(([field, n]) => (n > 1 ? `${field}×${n}` : field))
      .join(" ");
  }

  return url.pathname.replace(/0x[0-9a-fA-F]{64}/g, "{hash}").replace(/0x[0-9a-fA-F]{40}/g, "{address}");
}

/** A fetch that counts each request, with the bytes each way and the time. */
function countingFetch() {
  /** @type {Map<string, { requests: number, sent: number, received: number, ms: number }>} */
  const rows = new Map();

  /** @type {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} */
  const counted = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init.body === "string" ? init.body : "";
    const key = `${url.host} ${kindOf(url, body)}`;
    const started = performance.now();
    const response = await fetch(input, init);
    const text = await response.text();
    const row = rows.get(key) ?? { ms: 0, received: 0, requests: 0, sent: 0 };

    row.requests += 1;
    row.sent += Buffer.byteLength(body);
    row.received += Buffer.byteLength(text);
    row.ms += performance.now() - started;
    rows.set(key, row);

    const headers = new Headers(response.headers);

    headers.delete("content-encoding");
    headers.delete("content-length");

    return new Response(text, { headers, status: response.status, statusText: response.statusText });
  };

  return { fetch: counted, rows };
}

/** An account's history, kept in memory as the apps keep theirs. */
function memoryStore() {
  /** @type {any} */
  let state = null;
  /** @type {Map<string, any>} */
  const rows = new Map();

  return {
    clear: () => {
      state = null;
      rows.clear();
    },
    commit: (/** @type {any[]} */ entries, /** @type {(kept: any) => any} */ update) => {
      state = update(state);
      for (const entry of entries) rows.set(entry.hash, { ...rows.get(entry.hash), ...entry });

      return state;
    },
    getState: () => state,
    list: (/** @type {{ before?: number, limit: number }} */ { before, limit }) =>
      [...rows.values()]
        .filter((row) => before === undefined || row.blockHeight < before)
        .sort((a, b) => b.blockHeight - a.blockHeight)
        .slice(0, limit),
    patch: (/** @type {Map<string, any>} */ details) => {
      for (const [hash, found] of details) {
        const row = rows.get(hash);

        if (row) rows.set(hash, { ...row, ...found });
      }
    },
  };
}

/**
 * An account's deposits to DuskEVM, as its history gives them once read
 * whole: not counted.
 *
 * @param {string} account
 */
async function depositsOf(account) {
  const store = memoryStore();
  const history = createHistory({ account, archive: createArchive({ url: testnet.urls.node }), network: testnet, store: /** @type {any} */ (store) });

  for (let run = 0; run < 40; run += 1) if ((await history.sync({ maxDetailRequests: 8, maxRequests: 8 })).complete) break;

  await history.fillDetails(store.list({ limit: Infinity }));

  const { entries } = await history.read({ limit: 10_000 });

  return { deposits: entries.flatMap((entry) => depositOf(/** @type {any} */ (entry), account) ?? []), entries };
}

/** @type {Record<string, (fetch: ReturnType<typeof countingFetch>["fetch"]) => Promise<string>>} */
const scenarios = {
  // The bridge site's My transfers, on a first visit and the next.
  "my-transfers": async (fetch) => {
    const archive = createArchive({ fetch, url: testnet.urls.node });
    const store = memoryStore();
    /** @type {any} */
    let withdrawals = null;
    let found = 0;

    for (let visit = 0; visit < 2; visit += 1) {
      const history = createHistory({ account: USER2, archive, network: testnet, store: /** @type {any} */ (store) });

      await history.sync({ maxDetailRequests: 0, maxRequests: 6 });
      await history.fillDetails(store.list({ limit: Infinity })).catch(() => {});

      const sync = await syncWithdrawals({ address: USER2_EVM, bridge: duskEvm.predeploys.l2StandardBridge, duskEvm: { fetch, url: duskEvm.rpcUrl }, maxRequests: 12, state: withdrawals });

      withdrawals = sync.state;
      found += sync.found.length;
    }

    return `two visits: ${store.list({ limit: Infinity }).length} entries, ${found} withdrawals found`;
  },

  // The web wallet's Bridge activity: the deposits on their way, all at once, and the withdrawals on the explorer.
  "bridge-activity": async (fetch) => {
    const { deposits } = await depositsOf(USER2);
    const blockTimes = new Map();
    const { arrivals } = await depositArrivals({ archive: createArchive({ fetch, url: testnet.urls.node }), blockTimes, deposits, fetch, network: testnet, via: "rpc", waitMs: Infinity });
    const listed = await explorerWithdrawals({ address: USER2_EVM, fetch, maxItems: 50, network: testnet });

    return `${[...arrivals.values()].filter((a) => a.state === "arrived").length} of ${deposits.length} deposits arrived, ${listed.length} withdrawals listed`;
  },

  // The extension's arrivals: the account's deposits on their way, as its popup asks.
  arrivals: async (fetch) => {
    const { deposits } = await depositsOf(USER1);
    const { arrivals } = await depositArrivals({ archive: createArchive({ fetch, url: testnet.urls.node }), blockTimes: new Map(), deposits, fetch, network: testnet, via: "rpc" });

    return `${[...arrivals.values()].filter((a) => a.state === "arrived").length} of ${deposits.length} deposits arrived`;
  },

  // user2's withdrawals, synced from nothing, run after run, then once more.
  "withdrawals-sync": async (fetch) => {
    /** @type {any} */
    let state = null;
    let runs = 0;
    let found = 0;

    do {
      const sync = await syncWithdrawals({ address: USER2_EVM, duskEvm: { fetch, url: duskEvm.rpcUrl }, network: testnet, state });

      state = sync.state;
      found += sync.found.length;
      runs += 1;
    } while (runs < 60 && !(state.covered.length === 1 && state.covered[0][0] === 0));

    const again = await syncWithdrawals({ address: USER2_EVM, duskEvm: { fetch, url: duskEvm.rpcUrl }, network: testnet, state });

    return `${found + again.found.length} withdrawals in ${runs} runs, then one more run`;
  },

  // One deposit waiting for its arrival, checked every 15 s: its credit is another's here.
  waiting: async (fetch) => {
    const { deposits } = await depositsOf(USER1);
    const [deposit] = deposits;
    const first = await depositArrivals({ archive: createArchive({ url: testnet.urls.node }), deposits: [deposit], network: testnet, via: "rpc", waitMs: Infinity });
    const credit = /** @type {any} */ (first.arrivals.get(deposit.hash))?.hash;
    const archive = createArchive({ fetch, url: testnet.urls.node });
    const blockTimes = new Map();
    /** @type {any} */
    let scan;
    let checks = 0;
    const until = Date.now() + minutes * 60_000;

    while (Date.now() < until) {
      const { arrivals } = await depositArrivals({ archive, blockTimes, deposits: [{ ...deposit, scan }], fetch, network: testnet, taken: credit ? [credit] : [], via: "rpc", waitMs: Infinity });

      scan = /** @type {any} */ (arrivals.get(deposit.hash))?.scan;
      checks += 1;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }

    return `${checks} checks in ${minutes} min`;
  },

  // One transfer out on mainnet, from about its payout's block: a handful of requests on BNB Smart Chain.
  bsc: async (fetch) => {
    const { arrivals } = await serviceArrivals({
      archive: createArchive({ fetch, url: networks.mainnet.urls.node }),
      fetch,
      network: networks.mainnet,
      transfers: [{ hash: OUT.hash, notBefore: OUT.block, route: "dusk-to-bsc" }],
      waitMs: Infinity,
    });
    const arrival = /** @type {any} */ (arrivals.get(OUT.hash));

    return arrival?.state === "arrived" ? `arrived in ${arrival.hash.slice(0, 10)}… at block ${arrival.block}` : `${arrival?.state} ${arrival?.reason ?? ""}`;
  },
};

/** @type {Record<string, { outcome: string, ms: number, rows: Record<string, { requests: number, sent: number, received: number, ms: number }> }>} */
const report = {};

for (const [name, scenario] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;

  const counter = countingFetch();
  const started = performance.now();
  const outcome = await scenario(counter.fetch).catch((error) => `failed: ${error?.message ?? error}`);

  report[name] = { ms: Math.round(performance.now() - started), outcome, rows: Object.fromEntries([...counter.rows].sort(([a], [b]) => a.localeCompare(b))) };
}

if (json) {
  console.log(JSON.stringify(report, null, 1));
} else {
  for (const [name, { ms, outcome, rows }] of Object.entries(report)) {
    const total = Object.values(rows).reduce((sum, row) => ({ received: sum.received + row.received, requests: sum.requests + row.requests, sent: sum.sent + row.sent }), { received: 0, requests: 0, sent: 0 });

    console.log(`\n${name}: ${outcome}; ${total.requests} requests, ${(total.sent / 1024).toFixed(1)} KB sent, ${(total.received / 1024).toFixed(1)} KB received, ${(ms / 1000).toFixed(1)} s`);
    for (const [key, row] of Object.entries(rows)) {
      console.log(`  ${String(row.requests).padStart(5)}  ${(row.sent / 1024).toFixed(1).padStart(7)} KB  ${(row.received / 1024).toFixed(1).padStart(8)} KB  ${key}`);
    }
  }
}
