/**
 * What `/bridge` and `/bridge-explorer` share: values read from the chains
 * and the app, requests with the app's fetch, the network a read takes, and
 * the matching of credits to transfers. Not an entry point.
 *
 * @module
 */

import { networkFor } from "@dusk-network/networks";
import { isAccount } from "@dusk-network/networks/account";

/** @typedef {import("./bridge.js").Arrival} Arrival */
/** @typedef {import("./bridge.js").Deposit} Deposit */
/** @typedef {import("./bridge.js").FetchLike} FetchLike */
/** @typedef {import("./bridge.js").Scan} Scan */
/** @typedef {import("@dusk-network/networks").Network} Network */
/** @typedef {import("@dusk-network/networks").NetworkRef} NetworkRef */

/**
 * A transfer as the matching sees it: when it was sent, the block on the
 * other chain its credit can't be before, and whether it is one of the
 * app's own (`given`) or one read from the chain.
 *
 * @typedef {{ hash: string, at: number, notBefore: bigint | null, given: boolean, scan: Scan | null }} Queued
 */

/**
 * A credit on the other chain: its transaction, its block and time, its
 * amount in wei, whether it went through, and the address it came from as
 * its log names it (lower case; null where it isn't named). Found by an RPC
 * search, the passes over its blocks again done before it was (`pass`).
 *
 * @typedef {{ hash: string, block: bigint | null, at: number, wei: bigint, success: boolean, from: string | null, pass?: number }} Credit
 */

/**
 * What a group's matching gave each transfer.
 *
 * @typedef {"arrived" | "waiting" | "unsure" | "late"} Verdict
 */

export const CREDIT_WINDOW_MS = 120_000;
export const WAIT_MS = 7 * 24 * 60 * 60_000;
export const EXPLORER_PAGES = 5;

export const WEI_PER_LUX = 1_000_000_000n;
const MAX_U64 = (1n << 64n) - 1n;
export const TIMEOUT_MS = 8_000;
const DUSK_HASH = /^[0-9a-f]{64}$/;
export const EVM_HASH = /^0x[0-9a-f]{64}$/;
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * Lux from a bigint, a safe integer or its decimal text: null for anything
 * else, and past a u64.
 *
 * @param {unknown} value
 * @returns {bigint | null}
 */
export function luxOf(value) {
  /** @type {bigint} */
  let n;

  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && /^\d+$/.test(value.trim())) n = BigInt(value.trim());
  else return null;

  return n >= 0n && n <= MAX_U64 ? n : null;
}

/**
 * A block number or a time as JSON-RPC writes it (hex), or as decimal: null
 * for anything else.
 *
 * @param {unknown} value
 * @returns {bigint | null}
 */
export function quantityOf(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;

  const text = String(value ?? "").trim();

  return /^0x[0-9a-fA-F]+$/.test(text) || /^\d+$/.test(text) ? BigInt(text) : null;
}

/**
 * A Dusk transaction's hash, lower case, without 0x; "" for anything else.
 *
 * @param {unknown} value
 */
export const duskHashOf = (value) => {
  const hash = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^0x/, "");

  return DUSK_HASH.test(hash) ? hash : "";
};

/**
 * An EVM transaction's hash, lower case; "" for anything else.
 *
 * @param {unknown} value
 */
export const evmHashOf = (value) => {
  const hash = String(value ?? "")
    .trim()
    .toLowerCase();

  return EVM_HASH.test(hash) ? hash : "";
};

/**
 * An EVM address, lower case; "" for anything else.
 *
 * @param {unknown} value
 */
export const addressOf = (value) => (typeof value === "string" && EVM_ADDRESS.test(value) ? value.toLowerCase() : "");

/**
 * @param {unknown} error
 * @returns {string}
 */
export const messageOf = (error) => String(/** @type {any} */ (error)?.message ?? error ?? "");

/**
 * A time in milliseconds, or null.
 *
 * @param {unknown} value
 */
export const msOf = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/**
 * A height, or null.
 *
 * @param {unknown} value
 */
export const heightOf = (value) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * @template T
 * @param {Iterable<T>} items
 * @param {(item: T) => string} keyOf
 * @returns {Map<string, T[]>}
 */
export function groupBy(items, keyOf) {
  /** @type {Map<string, T[]>} */
  const out = new Map();

  for (const item of items) {
    const key = keyOf(item);

    out.set(key, [...(out.get(key) ?? []), item]);
  }

  return out;
}

/**
 * Oldest first, then by hash, so the order is the same everywhere.
 *
 * @param {{ at: number, hash: string, block?: bigint | null }} a
 * @param {{ at: number, hash: string, block?: bigint | null }} b
 */
export const byTime = (a, b) =>
  a.at - b.at || (a.block !== undefined && b.block !== undefined && a.block !== null && b.block !== null && a.block !== b.block ? (a.block < b.block ? -1 : 1) : 0) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

// ---------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------

/**
 * The network a reference names; a TypeError for none there's a file for.
 *
 * @param {NetworkRef} network
 * @returns {Network}
 */
export function networkOf(network) {
  const net = network && typeof network === "object" ? network : networkFor(/** @type {number | bigint | string} */ (network));

  if (!net || typeof net.chainId !== "number" || !net.routes) throw new TypeError("Not one of the networks");

  return net;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The app's fetch, each request within `timeoutMs`, counted.
 *
 * @param {FetchLike | undefined} fetchFn
 * @param {number} timeoutMs
 */
export function reader(fetchFn, timeoutMs) {
  const counter = { requests: 0 };

  /**
   * @param {string} url
   * @param {{ method: "GET" | "POST", headers: Record<string, string>, body?: string }} init
   * @returns {Promise<{ ok: boolean, status: number, body: any, host: string }>}
   */
  async function exchange(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const host = hostOf(url);

    counter.requests += 1;

    try {
      const send = fetchFn ?? globalThis.fetch;
      const response = await send(url, { ...init, signal: controller.signal });
      const text = await response.text();
      /** @type {any} */
      let body;

      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(response.ok ? `${host} didn't answer with JSON` : `${host} answers with HTTP ${response.status}`);
      }

      return { body, host, ok: response.ok, status: response.status };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${host} didn't answer within ${Math.round(timeoutMs / 100) / 10} s`);

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    counter,
    // What a call reads once for all its searches, by what and where: a
    // chain's head and pace.
    /** @type {Map<string, Promise<any>>} */
    once: new Map(),

    /**
     * @param {string} url
     * @returns {Promise<any>}
     */
    async getJson(url) {
      const answer = await exchange(url, { headers: { accept: "application/json" }, method: "GET" });

      if (!answer.ok) throw new Error(`${answer.host} answers with HTTP ${answer.status}`);

      return answer.body;
    },

    /**
     * One JSON-RPC call; its error's message, with its code, when it refuses.
     *
     * @param {string} url
     * @param {string} method
     * @param {unknown[]} params
     * @returns {Promise<any>}
     */
    async rpc(url, method, params) {
      const answer = await exchange(url, {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const error = answer.body?.error;

      if (error) throw Object.assign(new Error(String(error.message ?? `${method} was refused`)), { code: error.code });
      if (!answer.ok) throw new Error(`${answer.host} answers ${method} with HTTP ${answer.status}`);

      return answer.body?.result;
    },
  };
}

/** @typedef {ReturnType<typeof reader>} Reader */

// ---------------------------------------------------------------------------
// Matching: each credit pays one transfer, in the order they were sent
// ---------------------------------------------------------------------------

/**
 * Transfers whose windows touch, each window from `windowMs` before its
 * time to `windowMs` after: a credit in one could be another's.
 *
 * @param {ReadonlyArray<Queued>} queue oldest first
 * @param {number} windowMs
 * @returns {Queued[][]}
 */
function clustersOf(queue, windowMs) {
  /** @type {Queued[][]} */
  const out = [];

  for (const item of queue) {
    const last = out[out.length - 1];

    if (last && item.at - windowMs <= last[last.length - 1].at + windowMs) last.push(item);
    else out.push([item]);
  }

  return out;
}

/**
 * Whether every window of the queue is still open: nothing in it can be
 * told apart yet.
 *
 * @param {ReadonlyArray<Queued>} queue
 * @param {number} windowMs
 * @param {number} now
 */
export const allOpen = (queue, windowMs, now) => clustersOf(queue, windowMs).every((cluster) => now < cluster[cluster.length - 1].at + windowMs);

/**
 * How a group's credits are matched: see `settle`.
 *
 * @typedef {{ guarded: boolean, now: number, slackMs: number, used: ReadonlySet<string>, windowMs: number, rivals?: ReadonlySet<string> }} Rules
 */

/**
 * Whether a credit could pay a transfer, whether or not another one took it:
 * it went through, isn't one the app gave another of its transfers when
 * this one is the app's, comes from none of `rivals`, and is in the
 * transfer's time and at or after the block it can't be before.
 *
 * @param {Queued} item
 * @param {Credit} credit
 * @param {Rules} rules
 */
export function pays(item, credit, { guarded, rivals = new Set(), slackMs, used, windowMs }) {
  const lo = item.at - (guarded ? windowMs : slackMs);
  const hi = guarded ? item.at + windowMs : Infinity;

  return (
    credit.success &&
    (!item.given || !used.has(credit.hash)) &&
    (credit.from === null || !rivals.has(credit.from)) &&
    credit.at >= lo &&
    credit.at <= hi &&
    (item.notBefore === null || credit.block === null || credit.block >= item.notBefore)
  );
}

/**
 * Each transfer of a queue of equal ones, oldest first, takes the first
 * credit that went through after it that no earlier one took: from
 * `slackMs` before it on, and at or after the block it can't be before.
 * None comes from an address of `rivals`: the senders of other transfers
 * the app gave, whose credits these could be. A credit the app gave another
 * of its transfers (`used`) is none of the app's own waiting ones; a
 * transfer read from the chain may have it, as the one it paid comes back
 * among them.
 *
 * Where the queue may not hold every transfer that could have made the
 * credits (`guarded`), a credit is a transfer's only within `windowMs`
 * either side of it, and once the windows that touch its own are over,
 * only when every payment of its amount in them (those that failed too) is
 * one of those transfers' credits, or one the app gave another. Otherwise
 * it could be another transfer's: unsure. A transfer whose windows closed
 * without a credit is late: one coming later can't be told apart.
 *
 * @param {ReadonlyArray<Queued>} queue oldest first
 * @param {ReadonlyArray<Credit>} credits
 * @param {Rules} rules
 * @returns {{ assigned: Map<string, Credit>, verdicts: Map<string, Verdict> }}
 */
export function settle(queue, credits, rules) {
  const { guarded, now, used, windowMs } = rules;
  const sorted = [...credits].sort(byTime);
  /** @type {Map<string, Credit>} */
  const assigned = new Map();
  const taken = new Set();
  /** @type {Map<string, Verdict>} */
  const verdicts = new Map();

  for (const item of queue) {
    const credit = sorted.find((c) => !taken.has(c.hash) && pays(item, c, rules));

    if (credit) {
      assigned.set(item.hash, credit);
      taken.add(credit.hash);
    }
  }

  if (!guarded) {
    for (const item of queue) verdicts.set(item.hash, assigned.has(item.hash) ? "arrived" : "waiting");

    return { assigned, verdicts };
  }

  for (const cluster of clustersOf(queue, windowMs)) {
    const lo = cluster[0].at - windowMs;
    const hi = cluster[cluster.length - 1].at + windowMs;
    const own = new Set(cluster.flatMap((item) => (assigned.has(item.hash) ? [/** @type {Credit} */ (assigned.get(item.hash)).hash] : [])));
    const stray = sorted.some((c) => c.at >= lo && c.at <= hi && !used.has(c.hash) && !own.has(c.hash));

    for (const item of cluster) {
      verdicts.set(item.hash, now < hi ? "waiting" : stray ? "unsure" : assigned.has(item.hash) ? "arrived" : "late");
    }
  }

  return { assigned, verdicts };
}

/**
 * A queue of equal transfers where the credits can't be told apart, with
 * the ones the app gave but no longer looks for (waited for too long) whose
 * windows touch theirs: those were sent first, and take their credits
 * first.
 *
 * @param {ReadonlyArray<Queued>} given
 * @param {ReadonlyArray<Queued>} past
 * @param {number} windowMs
 * @returns {Queued[]}
 */
export function withPast(given, past, windowMs) {
  const polled = new Set(given.map((item) => item.hash));

  return clustersOf([...given, ...past].sort(byTime), windowMs)
    .filter((cluster) => cluster.some((item) => polled.has(item.hash)))
    .flat();
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A deposit as given, checked.
 *
 * @typedef {{ amount: bigint, at: number | null, hash: string, height: number | null, notBefore: bigint | null, scan: Scan | null, sender: string | null, to: string }} DepositItem
 */

/**
 * @param {Deposit} deposit
 * @param {(scan: unknown) => Scan | null} scanOf how its scan is read
 * @returns {DepositItem}
 */
function depositIn(deposit, scanOf) {
  const hash = duskHashOf(deposit?.hash);
  const amount = luxOf(deposit?.amount);
  const to = addressOf(deposit?.to);
  const sender = deposit?.sender ?? null;

  if (!hash) throw new TypeError("A deposit's hash is its Dusk transaction's: 64 hex digits");
  if (amount === null || amount === 0n) throw new TypeError("A deposit's amount is lux: more than 0, at most a u64");
  if (!to) throw new TypeError("A deposit pays a DuskEVM address: 0x and 40 hex digits");
  if (sender !== null && !isAccount(sender)) throw new TypeError("A deposit's sender is a Dusk account");

  return {
    amount,
    at: msOf(deposit.at),
    hash,
    height: heightOf(deposit.height),
    notBefore: quantityOf(deposit.notBefore),
    scan: scanOf(deposit.scan),
    sender: /** @type {string | null} */ (sender),
    to,
  };
}

/**
 * @param {{ hash: string, at: number | null, notBefore: bigint | null, scan: Scan | null }} item
 * @returns {Queued}
 */
export const queued = (item) => ({ at: /** @type {number} */ (item.at), given: true, hash: item.hash, notBefore: item.notBefore, scan: item.scan });

/**
 * Sorts out the transfers that aren't looked for: without their block's
 * time yet, waiting; sent longer ago than they're waited for, unknown.
 *
 * @template {{ hash: string, at: number | null }} T
 * @param {ReadonlyArray<T>} list
 * @param {Map<string, Arrival>} results
 * @param {{ now: number, waitMs: number }} options
 * @returns {T[]}
 */
export function triage(list, results, { now, waitMs }) {
  /** @type {T[]} */
  const live = [];

  for (const item of list) {
    if (item.at === null) results.set(item.hash, { state: "waiting" });
    else if (now - item.at > waitMs) results.set(item.hash, { reason: "expired", state: "unknown" });
    else live.push(item);
  }

  return live;
}

/**
 * Each item once, by hash: the first.
 *
 * @template {{ hash: string }} T
 * @param {ReadonlyArray<T>} list
 * @returns {T[]}
 */
export function uniqueByHash(list) {
  const seen = new Set();

  return list.filter((item) => !seen.has(item.hash) && Boolean(seen.add(item.hash)));
}

/**
 * The results in the order the transfers came.
 *
 * @param {ReadonlyArray<{ hash: string }>} list
 * @param {Map<string, Arrival>} results
 * @returns {Map<string, Arrival>}
 */
export const inOrder = (list, results) => new Map(list.map((item) => [item.hash, /** @type {Arrival} */ (results.get(item.hash))]));

/**
 * @param {Iterable<string> | undefined} taken
 * @param {(value: unknown) => string} hashOf
 */
export const usedOf = (taken, hashOf) => new Set([...(taken ?? [])].map(hashOf).filter(Boolean));

/**
 * What a call that follows deposits starts from, on either path: the
 * network, its DuskEVM (null without: every deposit is `no-route`), the
 * deposits given, checked, each once (`list`), those looked for (`live`),
 * those waited for too long, which still take their credits first (`past`),
 * the results so far, and the credits the app's other deposits arrived
 * with. A TypeError for a network or a deposit that isn't one.
 *
 * @param {{ network: NetworkRef, deposits: Iterable<Deposit> | undefined, taken: Iterable<string> | undefined, now: number, waitMs: number }} options
 * @param {(scan: unknown) => Scan | null} [scanOf] how a deposit's scan is read: on the explorer, not at all
 */
export function depositsIn({ deposits, network, now, taken, waitMs }, scanOf = () => null) {
  const net = networkOf(network);
  const list = uniqueByHash(Array.from(deposits ?? [], (deposit) => depositIn(deposit, scanOf)));
  /** @type {Map<string, Arrival>} */
  const results = new Map();
  const evm = net.duskEvm;

  if (!evm) for (const item of list) results.set(item.hash, { reason: "no-route", state: "unknown" });

  return {
    evm,
    list,
    live: evm ? triage(list, results, { now, waitMs }) : [],
    net,
    // Waited for too long: not looked for, though still before the newer ones.
    past: list.filter((item) => item.at !== null && now - item.at > waitMs),
    results,
    used: usedOf(taken, evmHashOf),
  };
}

