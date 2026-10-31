/* @ts-self-types="./bridge.d.ts" */
/**
 * The other side of the bridge's routes, as facts: whether a deposit to
 * DuskEVM arrived there, whether a migration into Dusk was paid out, and
 * whether a transfer out to another chain arrived there. Each credit pays
 * one transfer, in the order they were sent. The app passes its fetch, the
 * URLs and the archive it reads, and its own caches; nothing here keeps
 * state outside the calls.
 *
 * @module
 */

import { networkFor, routeForAccount, routes } from "@dusk-network/networks";
import { isAccount } from "@dusk-network/networks/account";
import { BRIDGE_FUNCTIONS, duskEvmContracts, evmAddressOf } from "@dusk-network/networks/duskevm";
import { DETAILS_BATCH, TRANSFER_CONTRACT, fetchTxDetails, historyRange } from "./history.js";

/** @typedef {import("./bridge.js").Arrival} Arrival */
/** @typedef {import("./bridge.js").BlockTimes} BlockTimes */
/** @typedef {import("./bridge.js").Deposit} Deposit */
/** @typedef {import("./bridge.js").DepositArrivalOptions} DepositArrivalOptions */
/** @typedef {import("./bridge.js").FetchLike} FetchLike */
/** @typedef {import("./bridge.js").HistoryLike} HistoryLike */
/** @typedef {import("./bridge.js").HistoryScan} HistoryScan */
/** @typedef {import("./bridge.js").Migration} Migration */
/** @typedef {import("./bridge.js").MigrationPayout} MigrationPayout */
/** @typedef {import("./bridge.js").MigrationPayoutOptions} MigrationPayoutOptions */
/** @typedef {import("./bridge.js").Scan} Scan */
/** @typedef {import("./bridge.js").ServiceArrivalOptions} ServiceArrivalOptions */
/** @typedef {import("./bridge.js").ServiceTransfer} ServiceTransfer */
/** @typedef {import("./bridge.js").ServiceTransferFacts} ServiceTransferFacts */
/** @typedef {import("./bridge.js").UnknownReason} UnknownReason */
/** @typedef {import("./history.js").Archive} Archive */
/** @typedef {import("./history.js").HistoryEntry} HistoryEntry */
/** @typedef {import("@dusk-network/networks").Network} Network */
/** @typedef {import("@dusk-network/networks").NetworkRef} NetworkRef */
/** @typedef {import("@dusk-network/networks").Route} Route */

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

export const CLOCK_SLACK_MS = 120_000;
export const CREDIT_WINDOW_MS = 120_000;
export const WAIT_MS = 7 * 24 * 60 * 60_000;
export const EXPLORER_PAGES = 5;
export const LOG_WINDOW = 5_000;
export const LOG_WINDOWS = 8;
export const DEPOSIT_HORIZON_MS = 2 * 60 * 60_000;
export const SERVICE_HORIZON_MS = 12 * 60 * 60_000;
export const HISTORY_PAGES = 4;
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ETH_BRIDGE_FINALIZED_TOPIC = "0x31b2166ff604fc5672ea5df08a78081d2bc6d746cadce880747f3643d819e83d";

const WEI_PER_LUX = 1_000_000_000n;
const MAX_U64 = (1n << 64n) - 1n;
const TIMEOUT_MS = 8_000;
// About one Dusk block every 10 seconds: how far back a sender's history is read.
const DUSK_BLOCK_MS = 10_000;
// The blocks the chain's pace is read over, from a block rounded down to a
// multiple of `PACE_STEP` so that the app's cache keeps its time, and how
// long before the transfer a search starts as the pace says: the block is
// then checked by its time, and stepped back while it's still later.
const PACE_SAMPLE = 100_000n;
const PACE_STEP = 10_000n;
const START_MS = 10 * 60_000;
const MIN_WINDOW = 50n;
// The widest a search's windows grow, while the RPC answers them whole.
const MAX_WINDOW = 100_000n;
// How far back from the head a search's last window reaches: those blocks
// are read again on each call.
const OVERLAP = 1_000n;
// How long after a search first reaches the head it reads its blocks again
// from its first one; each pass after waits as long again as it has been
// since then, so the waits about double each time.
const RECHECK_MS = 60_000;
// How many passes over the blocks before a credit, since it was found, a
// transfer waits for before it takes the credit where a later equal one,
// still without its own, could have had it instead.
const CONFIRM_PASSES = 8;
// What an RPC says when it won't search that many blocks at once.
const RANGE_REFUSED = /limit|range|too many|exceed/i;
const DUSK_HASH = /^[0-9a-f]{64}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORDS = /^0x(?:[0-9a-fA-F]{64})+$/;

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
function luxOf(value) {
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
function quantityOf(value) {
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
const duskHashOf = (value) => {
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
const evmHashOf = (value) => {
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
const addressOf = (value) => (typeof value === "string" && EVM_ADDRESS.test(value) ? value.toLowerCase() : "");

/**
 * An address as an indexed log topic: 32 bytes, lower case.
 *
 * @param {string} address
 */
const topicOf = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** @param {bigint} n */
const hex = (n) => `0x${n.toString(16)}`;

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = (error) => String(/** @type {any} */ (error)?.message ?? error ?? "");

/**
 * A Blockscout time ("2026-10-27T05:52:13.000000Z") in milliseconds.
 *
 * @param {unknown} text
 */
const timeOf = (text) => Date.parse(String(text ?? "").replace(/(\.\d{3})\d+/, "$1"));

/**
 * A time in milliseconds, or null.
 *
 * @param {unknown} value
 */
const msOf = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/**
 * A height, or null.
 *
 * @param {unknown} value
 */
const heightOf = (value) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * How far a transfer's history is read, as a result gave it; null for
 * anything else.
 *
 * @param {unknown} value
 * @returns {HistoryScan | null}
 */
function historyScanOf(value) {
  const read = /** @type {any} */ (value);

  if (!read || typeof read !== "object" || typeof read.of !== "string" || !Array.isArray(read.found)) return null;

  const lo = read.lo === null ? null : heightOf(read.lo);
  const next = read.next === null ? null : { from: heightOf(read.next?.from), page: heightOf(read.next?.page), to: heightOf(read.next?.to) };

  if ((read.lo !== null && lo === null) || (lo === null && next === null)) return null;
  if (next && (next.from === null || next.to === null || next.page === null || next.page < 1 || next.from > next.to)) return null;

  const found = read.found.flatMap((/** @type {any} */ each) => {
    const hash = duskHashOf(each?.hash);
    const height = heightOf(each?.height);
    const value = each?.value;

    return hash && height !== null && typeof value === "string" && /^\d{1,20}$/.test(value) ? [{ hash, height, value }] : [];
  });

  // One left out could be equal: it's read afresh.
  if (found.length !== read.found.length) return null;

  return { found, lo, next: /** @type {HistoryScan["next"]} */ (next), of: read.of };
}

/**
 * Where a search stopped, what it searched for, the credits it found
 * before, the width of its windows, and how far the transfer's history is
 * read, as a result gave them; null for anything else.
 *
 * @param {unknown} value
 * @returns {Scan | null}
 */
function scanOf(value) {
  const scan = /** @type {any} */ (value);
  const from = quantityOf(scan?.from);
  const history = historyScanOf(scan?.history);
  /** @type {Scan} */
  const out = history ? { history } : {};

  if (from !== null && typeof scan?.basis === "number" && Number.isFinite(scan.basis) && typeof scan.search === "string") {
    const seen = (Array.isArray(scan.seen) ? scan.seen : []).flatMap((/** @type {any} */ credit) => {
      const hash = evmHashOf(credit?.hash);
      const block = quantityOf(credit?.block);
      const at = msOf(credit?.at);
      const sender = credit?.sender === null ? null : addressOf(credit?.sender);
      // The passes done before it was found: none where it isn't said.
      const pass = Number.isSafeInteger(credit?.pass) && credit.pass >= 0 ? credit.pass : 0;

      return hash && block !== null && at !== null && sender !== "" ? [{ at, block: block.toString(), hash, pass, sender }] : [];
    });
    // Where it began, and its passes over the blocks again: without them,
    // as a search kept by an earlier version.
    const start = quantityOf(scan.start);
    const recheck = start === null ? null : recheckOf(scan.recheck);
    // The width of its windows, as an earlier version kept it for its passes
    // where it isn't said; and the narrowest the RPC refused.
    const size = Number.isSafeInteger(scan.size) && scan.size >= Number(MIN_WINDOW) && scan.size <= Number(MAX_WINDOW) ? scan.size : (recheck?.size ?? null);
    const refused = Number.isSafeInteger(scan.refused) && scan.refused > 0 ? scan.refused : null;

    Object.assign(out, { basis: scan.basis, from: from.toString(), search: scan.search, seen });
    if (start !== null) out.start = start.toString();
    if (recheck) out.recheck = recheckIn(recheck);
    if (size !== null) out.size = size;
    if (refused !== null) out.refused = refused;
  } else if (!history) {
    return null;
  }

  return out;
}

/**
 * The network a reference names; a TypeError for none there's a file for.
 *
 * @param {NetworkRef} network
 * @returns {Network}
 */
function networkOf(network) {
  const net = network && typeof network === "object" ? network : networkFor(/** @type {number | bigint | string} */ (network));

  if (!net || typeof net.chainId !== "number" || !net.routes) throw new TypeError("Not one of the networks");

  return net;
}

/**
 * @template T
 * @param {Iterable<T>} items
 * @param {(item: T) => string} keyOf
 * @returns {Map<string, T[]>}
 */
function groupBy(items, keyOf) {
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
const byTime = (a, b) =>
  a.at - b.at || (a.block !== undefined && b.block !== undefined && a.block !== null && b.block !== null && a.block !== b.block ? (a.block < b.block ? -1 : 1) : 0) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

/**
 * @param {ReadonlyArray<bigint>} list
 * @returns {bigint}
 */
const minOf = (list) => list.reduce((a, b) => (b < a ? b : a));

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
function reader(fetchFn, timeoutMs) {
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
const allOpen = (queue, windowMs, now) => clustersOf(queue, windowMs).every((cluster) => now < cluster[cluster.length - 1].at + windowMs);

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
function pays(item, credit, { guarded, rivals = new Set(), slackMs, used, windowMs }) {
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
function settle(queue, credits, rules) {
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
 * The queue of equal transfers: the app's, and those read from the chain
 * that were sent shortly before one of them, each within `horizonMs` of the
 * next. Older ones were paid before. The app's own win over a read of the
 * same transfer.
 *
 * @param {ReadonlyArray<Queued>} given
 * @param {ReadonlyArray<Queued>} read
 * @param {number} horizonMs
 * @returns {Queued[]}
 */
function queueOf(given, read, horizonMs) {
  const all = [...new Map([...read, ...given].map((item) => [item.hash, item])).values()].sort(byTime);
  const kept = all.map((item) => item.given);

  for (let i = all.length - 1; i > 0; i -= 1) {
    if (kept[i] && all[i].at - all[i - 1].at <= horizonMs) kept[i - 1] = true;
  }

  return all.filter((_, i) => kept[i]);
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
function withPast(given, past, windowMs) {
  const polled = new Set(given.map((item) => item.hash));

  return clustersOf([...given, ...past].sort(byTime), windowMs)
    .filter((cluster) => cluster.some((item) => polled.has(item.hash)))
    .flat();
}

/**
 * The first transfer of the run of equal ones before `item`, each within
 * `horizonMs` of the next.
 *
 * @param {ReadonlyArray<Queued>} queue oldest first
 * @param {Queued} item
 * @param {number} horizonMs
 */
function runStart(queue, item, horizonMs) {
  let i = queue.indexOf(item);

  while (i > 0 && queue[i].at - queue[i - 1].at <= horizonMs) i -= 1;

  return queue[Math.max(i, 0)];
}

// ---------------------------------------------------------------------------
// EVM logs
// ---------------------------------------------------------------------------

/**
 * `Transfer(address indexed, address indexed, uint256)`'s data: the value,
 * one word.
 *
 * @param {string} data
 * @returns {bigint | null}
 */
function transferValue(data) {
  return /^0x[0-9a-fA-F]{64}$/.test(data) ? BigInt(data) : null;
}

/**
 * `ETHBridgeFinalized(address indexed from, address indexed to, uint256
 * amount, bytes extraData)`'s data: the amount, then where the extra data
 * starts (0x40), its length, and its words.
 *
 * @param {string} data
 * @returns {bigint | null}
 */
function bridgeFinalizedAmount(data) {
  if (!WORDS.test(data)) return null;

  const words = (data.length - 2) / 64;
  /** @param {number} i */
  const word = (i) => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);

  if (words < 3 || word(1) !== 0x40n || BigInt(words) !== 3n + (word(2) + 31n) / 32n) return null;

  return word(0);
}

/**
 * A log as one of the credits searched for: not removed, from the contract
 * asked, with the topics asked, in the blocks asked, of the amount asked.
 *
 * @param {any} log
 * @param {{ address: string, topics: ReadonlyArray<string | null>, wei: bigint, amountOf: (data: string) => bigint | null, from: bigint, to: bigint }} ask
 * @returns {{ hash: string, block: bigint, at: number | null, from: string } | null}
 */
function creditLog(log, { address, amountOf, from, to, topics, wei }) {
  if (!log || typeof log !== "object" || log.removed === true) return null;
  if (String(log.address ?? "").toLowerCase() !== address) return null;

  const got = Array.isArray(log.topics) ? log.topics.map((/** @type {unknown} */ topic) => String(topic).toLowerCase()) : [];

  if (got.length !== topics.length || topics.some((topic, i) => topic !== null && got[i] !== topic)) return null;

  const hash = evmHashOf(log.transactionHash);
  const block = quantityOf(log.blockNumber);

  if (!hash || block === null || block < from || block > to || amountOf(String(log.data ?? "")) !== wei) return null;

  const seconds = quantityOf(log.blockTimestamp);

  return { at: seconds === null ? null : Number(seconds) * 1000, block, from: `0x${got[1].slice(-40)}`, hash };
}

/**
 * A block's time, in milliseconds: from the app's cache, else the chain.
 *
 * @param {Reader} read
 * @param {string} url
 * @param {bigint} block
 * @param {BlockTimes | undefined} cache
 * @returns {Promise<number>}
 */
async function blockTime(read, url, block, cache) {
  const kept = cache?.get(Number(block));

  if (typeof kept === "number" && Number.isFinite(kept)) return kept;

  return once(read, `time ${url} ${block}`, async () => {
    const seconds = quantityOf((await read.rpc(url, "eth_getBlockByNumber", [hex(block), false]))?.timestamp);

    if (seconds === null) throw new Error(`The chain gave no time for block ${block}`);

    const at = Number(seconds) * 1000;

    cache?.set(Number(block), at);

    return at;
  });
}

/**
 * What a call reads once for all its searches on a chain.
 *
 * @template T
 * @param {Reader} read
 * @param {string} key
 * @param {() => Promise<T>} get
 * @returns {Promise<T>}
 */
function once(read, key, get) {
  const kept = read.once.get(key);

  if (kept) return kept;

  const got = get();

  read.once.set(key, got);
  // One that failed is read again by the next search.
  got.catch(() => read.once.delete(key));

  return got;
}

/**
 * The chain's head, read once a call: the head its pace was read with, where
 * the call read that.
 *
 * @param {Reader} read
 * @param {string} url
 * @returns {Promise<bigint>}
 */
async function headOf(read, url) {
  const paced = read.once.get(`pace ${url}`);

  if (paced) return (await paced).head;

  return once(read, `head ${url}`, async () => {
    const head = quantityOf(await read.rpc(url, "eth_blockNumber", []));

    if (head === null) throw new Error("The chain gave no head");

    return head;
  });
}

/**
 * The chain's head, its time, and its pace (blocks a second) over its last
 * 100,000 blocks or so, read once a call.
 *
 * @param {Reader} read
 * @param {string} url
 * @param {BlockTimes | undefined} cache
 * @returns {Promise<{ head: bigint, seconds: number, pace: number }>}
 */
function paceOf(read, url, cache) {
  return once(read, `pace ${url}`, async () => {
    const latest = await read.rpc(url, "eth_getBlockByNumber", ["latest", false]);
    const head = quantityOf(latest?.number);
    const headSeconds = quantityOf(latest?.timestamp);

    if (head === null || headSeconds === null) throw new Error("The chain gave no head");

    cache?.set(Number(head), Number(headSeconds) * 1000);
    read.once.set(`time ${url} ${head}`, Promise.resolve(Number(headSeconds) * 1000));

    const back = head < PACE_SAMPLE ? 0n : ((head - PACE_SAMPLE) / PACE_STEP) * PACE_STEP;
    let pace = 1;

    if (back < head) {
      const span = Number(headSeconds) - (await blockTime(read, url, back, cache)) / 1000;

      if (span > 0) pace = Number(head - back) / span;
    }

    return { head, pace, seconds: Number(headSeconds) };
  });
}

/**
 * The chain's head, and a block from before `atMs`: the block 10 minutes
 * before it, as the chain's pace says, checked by its time, and stepped back
 * while that's still later, twice as far each time, as the chain's pace may
 * have changed.
 *
 * @param {Reader} read
 * @param {string} url
 * @param {number} atMs
 * @param {BlockTimes | undefined} cache
 * @returns {Promise<{ head: bigint, start: bigint }>}
 */
async function startBefore(read, url, atMs, cache) {
  const { head, pace, seconds } = await paceOf(read, url, cache);
  /** @param {bigint} block @param {number} ms @param {number} times */
  const back = (block, ms, times) => {
    const step = BigInt(Math.ceil((Math.max(0, ms) / 1000) * pace * times));

    return block > step ? block - step : 0n;
  };
  let start = back(head, seconds * 1000 - atMs + START_MS, 1);

  for (let times = 2; start > 0n; times *= 2) {
    const at = await blockTime(read, url, start, cache);

    if (at <= atMs) break;

    start = back(start, at - atMs + START_MS, times);
  }

  return { head, start };
}

/**
 * The credits asked for from block `start`, a window of blocks at a time, at
 * most `maxWindows`, until `head`, `enough`, or a window ending after
 * `until` (`covered`, as the block before `start` may already be, where a
 * search before stopped there): each checked against what was asked, with
 * its block's time. Each window is `size` blocks wide, twice as wide after
 * one the RPC answered whole, up to `MAX_WINDOW`, and narrower than any it
 * refused (`refused`, the narrowest). One it won't search at once, or one
 * wider than `LOG_WINDOW` that isn't answered, is asked again a quarter as
 * wide, or as wide as the widest it answered where that's wider: `size` and
 * `refused` are as the search leaves them. The window ending at `head`
 * reaches back up to `overlap` blocks from it, no wider than `size`, though
 * not under `floor`: those blocks are read again (from `low`). `asked`: the
 * windows asked.
 *
 * @param {Reader} read
 * @param {{ url: string, address: string, topics: ReadonlyArray<string | null>, wei: bigint, amountOf: (data: string) => bigint | null, start: bigint, floor: bigint, head: bigint, size: bigint, refused: bigint | null, overlap?: bigint, maxWindows: number, blockTimes: BlockTimes | undefined, enough: (credits: Credit[]) => boolean, until: number | null, known: Credit[] }} search
 * @returns {Promise<{ asked: number, complete: boolean, covered: boolean, credits: Credit[], low: bigint | null, next: bigint, refused: bigint | null, size: bigint }>}
 */
async function searchLogs(read, { address, amountOf, blockTimes, enough, floor, head, known, maxWindows, overlap = OVERLAP, refused: kept, size: width, start, topics, until, url, wei }) {
  // What an earlier search found before `start`.
  /** @type {Credit[]} */
  const credits = [...known];
  let from = start;
  let size = width;
  let refused = kept;
  let covered = false;
  let asked = 0;
  /** @type {bigint | null} */
  let low = null;
  /** @type {bigint | null} */
  let took = null;

  if (until !== null && start > floor && start <= head) covered = (await blockTime(read, url, start - 1n, blockTimes)) > until;

  while (!covered && asked < maxWindows && from <= head) {
    const to = from + size - 1n < head ? from + size - 1n : head;
    const back = head + 1n - (size < overlap ? size : overlap);
    const lo = to === head && back < from ? (back > floor ? back : floor) : from;
    const blocks = to - lo + 1n;
    /** @type {any} */
    let logs;

    asked += 1;

    try {
      logs = await read.rpc(url, "eth_getLogs", [{ address, fromBlock: hex(lo), toBlock: hex(to), topics }]);
    } catch (error) {
      if (blocks > MIN_WINDOW && (blocks > BigInt(LOG_WINDOW) || RANGE_REFUSED.test(messageOf(error)))) {
        const fits = took !== null && took < blocks && took > blocks / 4n ? took : blocks / 4n;

        if (refused === null || blocks < refused) refused = blocks;
        size = fits > MIN_WINDOW ? fits : MIN_WINDOW;
        continue;
      }

      throw error;
    }

    if (to === head) low = lo;
    if (took === null || blocks > took) took = blocks;

    // Answered whole: the next one twice as wide, while narrower than any refused.
    if (blocks === size) {
      const wider = size * 2n < MAX_WINDOW ? size * 2n : MAX_WINDOW;

      if (refused === null || wider < refused) size = wider;
    }

    for (const log of Array.isArray(logs) ? logs : []) {
      const found = creditLog(log, { address, amountOf, from: lo, to, topics, wei });

      if (!found || credits.some((credit) => credit.hash === found.hash)) continue;
      if (found.at !== null) blockTimes?.set(Number(found.block), found.at);

      credits.push({ at: found.at ?? (await blockTime(read, url, found.block, blockTimes)), block: found.block, from: found.from, hash: found.hash, success: true, wei });
    }

    from = to + 1n;

    if (enough(credits)) break;
    if (until !== null && from <= head && (await blockTime(read, url, to, blockTimes)) > until) {
      covered = true;
      break;
    }
  }

  return { asked, complete: from > head, covered, credits, low, next: from, refused, size };
}

/**
 * A search's passes over its blocks again, as a result gave them: where the
 * one under way is (null between two), when the next begins, how many are
 * done, when the search first reached the head, and the width of the
 * windows it read them in, as an earlier version kept it; null for anything
 * else.
 *
 * @param {unknown} value
 * @returns {{ at: number, from: bigint | null, passes: number, since: number, size: number | null } | null}
 */
function recheckOf(value) {
  const kept = /** @type {any} */ (value);
  const from = kept?.from === null ? null : quantityOf(kept?.from);
  /** @param {unknown} ms */
  const time = (ms) => typeof ms === "number" && Number.isFinite(ms);
  const size = Number.isSafeInteger(kept?.size) && kept.size >= Number(MIN_WINDOW) && kept.size <= LOG_WINDOW ? kept.size : null;

  if (!kept || !time(kept.at) || !time(kept.since) || !Number.isSafeInteger(kept.passes) || kept.passes < 0) return null;
  if (kept.from !== null && from === null) return null;

  return { at: kept.at, from, passes: kept.passes, since: kept.since, size };
}

/**
 * A search's passes over its blocks again, as its scan keeps them.
 *
 * @param {NonNullable<ReturnType<typeof recheckOf>>} recheck
 * @returns {NonNullable<Scan["recheck"]>}
 */
function recheckIn({ at, from, passes, since }) {
  return { at, from: from === null ? null : from.toString(), passes, since };
}

/**
 * One group of equal transfers followed to their credits in a chain's logs:
 * from where the last search for the same logs stopped when it began no
 * later than the group's first transfer, else from the block the first was
 * sent at (as the app saw the chain's head then), else from about when it
 * was sent.
 *
 * Each block is read more than once: on each call, those up to `OVERLAP`
 * under the head, and once the search has reached the head with a transfer
 * not arrived, all of them again from where the search began, a pass at a
 * time: the first a minute later, each after as long again as it has been
 * since then, and one after the other, as far as its credit, while an
 * arrival is held back. A pass under way takes what the search ahead leaves
 * of a call's windows, one at least. A pass counts once it read the blocks
 * again, as does a call whose window at the head reached back to where the
 * search began. Both go on in windows as wide as the searches before left
 * them, narrower than the narrowest the RPC refused.
 *
 * @param {Reader} read
 * @param {{ given: Queued[], queue: Queued[], guarded: boolean, unsure: ReadonlySet<string>, rivals?: ReadonlySet<string>, filter: { address: string, topics: ReadonlyArray<string | null>, wei: bigint, amountOf: (data: string) => bigint | null } }} group
 * @param {{ url: string, maxWindows: number, blockTimes: BlockTimes | undefined, now: number, slackMs: number, windowMs: number, used: Set<string> }} options
 * @returns {Promise<Map<string, Arrival>>}
 */
async function followLogs(read, { filter, given, guarded, queue, rivals, unsure }, { blockTimes, maxWindows, now, slackMs, url, used, windowMs }) {
  /** @type {Map<string, Arrival>} */
  const out = new Map();
  const live = given.filter((item) => !unsure.has(item.hash));

  for (const item of given) if (unsure.has(item.hash)) out.set(item.hash, { reason: "unsure", state: "unknown" });

  if (!live.length) return out;

  if (guarded && allOpen(queue, windowMs, now)) {
    for (const item of live) out.set(item.hash, { state: "waiting" });

    return out;
  }

  const rules = { guarded, now, rivals, slackMs, used, windowMs };
  const first = queue[0];
  const reach = first.at - (guarded ? windowMs : slackMs);
  // The logs searched for: a search for others, as for another sender or
  // amount, isn't carried on.
  const search = [filter.address, ...filter.topics.map((topic) => topic ?? "*"), filter.wei.toString()].join(":");
  /** @type {{ basis: number, from: string, seen?: Scan["seen"], start?: string, recheck?: Scan["recheck"], size?: number, refused?: number }[]} */
  const resumed = live.flatMap(({ scan }) =>
    scan?.from !== undefined && scan.search === search && scan.basis !== undefined && scan.basis <= first.at
      ? [{ basis: scan.basis, from: scan.from, recheck: scan.recheck, refused: scan.refused, seen: scan.seen, size: scan.size, start: scan.start }]
      : []
  );
  /** @type {Map<string, Credit>} */
  const carried = new Map();

  // The credits found before where an earlier search stopped: every one
  // counts again, as the transfer it paid may be among the queue's.
  for (const scan of resumed) {
    for (const credit of scan.seen ?? []) {
      if (credit.at >= reach) carried.set(credit.hash, { at: credit.at, block: BigInt(credit.block), from: credit.sender, hash: credit.hash, pass: credit.pass ?? 0, success: true, wei: filter.wei });
    }
  }

  /** @type {bigint} */
  let head;
  /** @type {bigint} */
  let start;
  // The block the search began at, and its passes over the blocks before.
  /** @type {bigint} */
  let floor;
  /** @type {ReturnType<typeof recheckOf>} */
  let recheck = null;

  if (resumed.length && resumed.every((scan) => scan.basis === first.at)) {
    const kept = resumed.reduce((a, b) => (BigInt(b.from) < BigInt(a.from) ? b : a));

    start = BigInt(kept.from);
    recheck = recheckOf(kept.recheck);

    if (resumed.every((scan) => scan.start !== undefined)) {
      floor = minOf(resumed.map((scan) => BigInt(/** @type {string} */ (scan.start))));
      head = await headOf(read, url);
    } else {
      // Kept without where it began: from where a search from the first
      // begins.
      const fresh = first.notBefore !== null ? { head: await headOf(read, url), start: first.notBefore } : await startBefore(read, url, reach, blockTimes);

      floor = fresh.start;
      head = fresh.head;
    }
  } else if (resumed.length) {
    // Begun from a transfer before the first now, as one that since
    // arrived: none of the queue's credits is before where a search from
    // the first starts, which it skips to.
    const from = minOf(resumed.map((scan) => BigInt(scan.from)));
    const fresh = first.notBefore !== null ? { head: await headOf(read, url), start: first.notBefore } : await startBefore(read, url, reach, blockTimes);

    head = fresh.head;
    start = from > fresh.start ? from : fresh.start;
    floor = fresh.start;
  } else if (first.notBefore !== null) {
    start = first.notBefore;
    floor = start;
    head = await headOf(read, url);
  } else {
    ({ head, start } = await startBefore(read, url, reach, blockTimes));
    floor = start;
  }

  if (floor > start) floor = start;

  // No later than a credit found before: the blocks are read again from it.
  for (const credit of carried.values()) if (credit.block !== null && credit.block < floor) floor = credit.block;

  // The width of the windows, and the narrowest the RPC refused, as the
  // searches before left them: the narrowest of each.
  const sizes = resumed.flatMap((scan) => (scan.size === undefined ? [] : [BigInt(scan.size)]));
  const refusals = resumed.flatMap((scan) => (scan.refused === undefined ? [] : [BigInt(scan.refused)]));
  const width = sizes.length ? minOf(sizes) : BigInt(LOG_WINDOW);

  /**
   * The given transfers' credits with `found`: those that arrived, by their
   * credits, and those held back (`held`), with the last of their credits'
   * blocks (`top`). One a later transfer of the queue, still without a
   * credit, could have had the credit of instead is held back until the
   * blocks before it are read again `CONFIRM_PASSES` times since it was
   * found: its own may yet be found there.
   *
   * @param {Credit[]} found
   * @param {boolean} seen
   */
  const settled = (found, seen) => {
    const { assigned, verdicts } = settle(queue, found, rules);
    const passes = recheck?.passes ?? 0;
    const mine = new Set(live.map((item) => item.hash));
    /** @type {Set<string>} */
    const arrived = new Set();
    /** @type {Set<string>} */
    const held = new Set();
    /** @type {bigint | null} */
    let top = null;

    queue.forEach((item, i) => {
      const credit = assigned.get(item.hash);

      if (!credit || !mine.has(item.hash) || verdicts.get(item.hash) !== "arrived" || !(seen || !guarded)) return;

      // A later one without a credit could have had this one instead.
      const doubt = !guarded && passes - (credit.pass ?? 0) < CONFIRM_PASSES && queue.slice(i + 1).some((later) => !assigned.has(later.hash) && pays(later, credit, rules));

      if (!doubt) {
        arrived.add(credit.hash);
      } else {
        held.add(item.hash);
        if (credit.block !== null && (top === null || credit.block > top)) top = credit.block;
      }
    });

    return { arrived, assigned, held, top, verdicts };
  };
  /**
   * The credits found in this call, with the passes done before the next
   * one to begin.
   *
   * @param {Credit[]} found
   * @returns {Credit[]}
   */
  const mark = (found) => {
    const pass = recheck === null ? 0 : recheck.passes + (recheck.from !== null ? 1 : 0);

    return found.map((credit) => (credit.pass === undefined ? { ...credit, pass } : credit));
  };
  // Where the credits can't be told apart, only those in the transfers'
  // windows count: once they're all over, read no further than the last.
  const last = queue[queue.length - 1].at + windowMs;
  const until = guarded && now >= last ? last : null;
  const due = recheck !== null && (recheck.from !== null || now >= recheck.at);
  const ahead = await searchLogs(read, {
    ...filter,
    blockTimes,
    // Once every transfer of the queue has its credit: read no further.
    enough: (found) => !guarded && settle(queue, found, rules).assigned.size === queue.length,
    floor,
    head,
    known: [...carried.values()],
    maxWindows,
    refused: refusals.length ? minOf(refusals) : null,
    size: width,
    start,
    until,
    url,
  });
  const { complete, covered, next } = ahead;
  const seen = complete || covered;
  // Its window at the head reached back to where the search began: every
  // block read before this call is read again, as by a pass.
  const again = recheck !== null && ahead.low !== null && ahead.low <= floor && start > floor;

  if (again && recheck !== null) recheck = { ...recheck, passes: recheck.passes + 1 };

  let credits = mark(ahead.credits);
  const before = settled(credits, seen);
  let { refused, size } = ahead;

  if ((seen || before.held.size) && recheck === null) recheck = { at: before.held.size ? now : now + RECHECK_MS, from: null, passes: 0, since: now, size: null };

  // A transfer not arrived yet: the blocks read before this call, again, as
  // far as the search ahead reads; while an arrival is held back, as far as
  // its credit. With what the search ahead leaves of a call's windows, one
  // at least.
  if (recheck !== null && (due || before.held.size) && before.arrived.size < live.length) {
    const from = recheck.from !== null && recheck.from > floor ? recheck.from : floor;
    const below = ahead.low !== null && ahead.low < start ? ahead.low : start;
    const pass = await searchLogs(read, {
      ...filter,
      blockTimes,
      // Read through: a credit further on, still before those found ahead,
      // could be a transfer's first.
      enough: () => false,
      floor: from,
      head: before.top !== null && before.top < below ? before.top : below - 1n,
      known: credits,
      maxWindows: maxWindows < 1 ? 0 : Math.max(1, maxWindows - ahead.asked),
      refused,
      size,
      start: from,
      until,
      url,
    });
    const done = pass.complete || pass.covered;
    // A pass that read no block is none: only one that read the blocks again
    // counts, and not twice in a call.
    const counted = done && !again && pass.next > floor;

    recheck = done ? { ...recheck, at: now + Math.max(RECHECK_MS, now - recheck.since), from: null, passes: recheck.passes + (counted ? 1 : 0) } : { ...recheck, from: pass.next };
    credits = mark(pass.credits);
    ({ refused, size } = pass);
  }

  const { arrived, assigned, held, verdicts } = settled(credits, seen);

  // Passes go on one after the other while an arrival is held back; once one
  // arrives with others still waiting, theirs begin again a minute later,
  // the waits growing from there.
  if (recheck !== null && held.size) recheck = { ...recheck, at: Math.min(recheck.at, now) };
  else if (recheck !== null && arrived.size && arrived.size < live.length) recheck = { ...recheck, at: Math.min(recheck.at, now + RECHECK_MS), since: now };

  // The next search carries on from where this one stopped, with the
  // credits found so far: a transfer that arrived may come back from the
  // chain among those before the next one, and takes its own again.
  /** @type {Scan} */
  const scan = {
    basis: first.at,
    from: next.toString(),
    ...(recheck ? { recheck: recheckIn(recheck) } : {}),
    ...(refused === null ? {} : { refused: Number(refused) }),
    search,
    seen: credits.flatMap((credit) => (credit.at >= reach && credit.block !== null ? [{ at: credit.at, block: credit.block.toString(), hash: credit.hash, pass: credit.pass ?? 0, sender: credit.from }] : [])),
    size: Number(size),
    start: floor.toString(),
  };

  for (const item of live) {
    const credit = assigned.get(item.hash);
    const verdict = verdicts.get(item.hash);

    if (held.has(item.hash)) {
      out.set(item.hash, { scan, state: "waiting" });
    } else if (credit && arrived.has(credit.hash)) {
      used.add(credit.hash);
      out.set(item.hash, {
        amount: credit.wei / WEI_PER_LUX,
        at: credit.at,
        block: credit.block === null ? null : Number(credit.block),
        hash: credit.hash,
        state: "arrived",
      });
    } else if (guarded ? !seen : verdict === "waiting" && !complete) {
      out.set(item.hash, { reason: "searching", scan, state: "unknown" });
    } else if (verdict === "waiting") {
      out.set(item.hash, { scan, state: "waiting" });
    } else {
      out.set(item.hash, { reason: verdict === "unsure" ? "unsure" : "late", scan, state: "unknown" });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

/**
 * The transfers whose memo is exactly each of `memos`, as the archive lists
 * them: one request.
 *
 * @param {Archive} archive
 * @param {Iterable<string>} memos
 * @param {{ requests: number }} counter
 * @returns {Promise<Map<string, any[]>>}
 */
async function byMemo(archive, memos, counter) {
  const list = [...new Set(memos)];

  if (!list.length) return new Map();

  counter.requests += 1;

  const data = await archive.query(`query { ${list.map((memo, i) => `m${i}: transactionsByMemo(memo: ${JSON.stringify(memo)}) { json }`).join(" ")} }`);

  return new Map(list.map((memo, i) => [memo, Array.isArray(data?.[`m${i}`]?.json) ? data[`m${i}`].json : []]));
}

// A JSON string, or a whole JSON number: outside strings, only numbers have digits.
const TOKEN = /("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/**
 * JSON.parse, with the integers past 2^53 kept exact, as their text: the
 * node writes a transaction's amounts as bare numbers.
 *
 * @param {string} text
 * @returns {any}
 */
function exactJson(text) {
  return JSON.parse(text.replace(TOKEN, (match, string) => string ?? (/^-?\d+$/.test(match) && !Number.isSafeInteger(Number(match)) ? `"${match}"` : match)));
}

const utf8 = new TextDecoder();

/**
 * A memo's bytes, given as hex, as text, read as the route's bridge reads
 * them: as UTF-8, bytes that aren't UTF-8 becoming the replacement
 * character; "" for none.
 *
 * @param {unknown} hex
 */
function memoOf(hex) {
  const text = String(hex ?? "").replace(/^0x/i, "");

  return /^(?:[0-9a-fA-F]{2})+$/.test(text) ? utf8.decode(Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16))) : "";
}

/**
 * A transaction as `tx(hash) { blockHeight blockTimestamp err tx { memo
 * json } }` gives it: its block's height and time, whether it failed, its
 * kind, and as a public transfer, whom it paid how much and its memo as the
 * route's bridge reads it. Null for none; `kind` null when its JSON can't be
 * read.
 *
 * @param {any} raw
 * @returns {{ at: number | null, failed: boolean, height: number | null, kind: string | null, memo: string, receiver: string | null, value: bigint | null } | null}
 */
function transferFacts(raw) {
  if (!raw || typeof raw !== "object") return null;

  /** @type {any} */
  let json = null;

  try {
    json = exactJson(String(raw.tx?.json ?? ""));
  } catch {
    json = null;
  }

  const seconds = Number(raw.blockTimestamp);

  return {
    at: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    failed: raw.err !== null && raw.err !== undefined,
    height: /^\d+$/.test(String(raw.blockHeight)) ? heightOf(Number(raw.blockHeight)) : null,
    kind: typeof json?.type === "string" ? json.type : null,
    memo: memoOf(raw.tx?.memo),
    receiver: typeof json?.receiver === "string" ? json.receiver : null,
    value: luxOf(json?.value),
  };
}

/** @typedef {NonNullable<ReturnType<typeof transferFacts>>} TransferFacts */

/**
 * Transactions as `transferFacts` reads them, by hash, a batch per request:
 * those the archive has.
 *
 * @param {Archive} archive
 * @param {ReadonlyArray<string>} hashes
 * @param {{ requests: number }} counter
 * @returns {Promise<Map<string, TransferFacts>>}
 */
async function transfersOf(archive, hashes, counter) {
  /** @type {Map<string, TransferFacts>} */
  const out = new Map();
  const list = [...new Set(hashes)];

  for (let i = 0; i < list.length; i += DETAILS_BATCH) {
    const batch = list.slice(i, i + DETAILS_BATCH);

    counter.requests += 1;

    const data = await archive.query(`query { ${batch.map((hash, j) => `x${j}: tx(hash: "${hash}") { blockHeight blockTimestamp err tx { memo json } }`).join(" ")} }`);

    batch.forEach((hash, j) => {
      const facts = transferFacts(data?.[`x${j}`]);

      if (facts) out.set(hash, facts);
    });
  }

  return out;
}

/**
 * Details of transactions, a batch per request.
 *
 * @param {Archive} archive
 * @param {ReadonlyArray<string>} hashes
 * @param {{ network?: Network, args?: boolean }} options
 * @param {{ requests: number }} counter
 */
async function detailsOf(archive, hashes, { args = false, network }, counter) {
  /** @type {Map<string, any>} */
  const out = new Map();
  const list = [...new Set(hashes)];

  for (let i = 0; i < list.length; i += DETAILS_BATCH) {
    const batch = list.slice(i, i + DETAILS_BATCH);

    counter.requests += 1;

    for (const [hash, found] of await fetchTxDetails(archive, batch, { args: args ? new Set(batch) : undefined, network })) out.set(hash, found);
  }

  return out;
}

/**
 * A transfer whose history is read: its hash, its Dusk block's time and
 * height, the block on the other chain its credit can't be before, and its
 * scan.
 *
 * @typedef {{ hash: string, at: number, height: number, notBefore: bigint | null, scan: Scan | null }} Reading
 */

/**
 * The history a group of equal transfers needs, each transfer's read on
 * from where its scan stopped: its account's history from `reach` blocks
 * under its block up to it, and `reach` further down at a time while the
 * run of equal transfers it is in reaches within `horizonMs` of the bottom.
 * The transfer itself must be listed there: until it is, the archive
 * hasn't read its block. Each transfer reads `pages` pages at most, so a
 * later one's history never keeps an earlier one waiting.
 *
 * Those whose history is all read are `covered`, and `given` as the queue
 * holds them, with `queue`: theirs and the equal transfers found
 * (`peersOf`), and `unread`: by transfer, the heights it read of those that
 * could be equal but can't be read. Each one's reading, done or not, is in
 * `states`.
 *
 * @param {Archive} archive
 * @param {ReadonlyArray<Reading>} items
 * @param {{ account: string, direction: "in" | "out", horizonMs: number, reach: number, pages: number, keep: (entry: HistoryEntry) => boolean, of: (item: Reading) => string, peersOf: (found: HistoryScan["found"]) => Promise<{ peers: Queued[], unread: ReadonlyArray<{ hash: string, height: number }> }> }} read
 * @param {{ requests: number }} counter
 */
async function readHistories(archive, items, { account, direction, horizonMs, keep, of, pages, peersOf, reach }, counter) {
  const walks = items.map((item) => {
    const kept = item.scan?.history;
    /** @type {HistoryScan} */
    const state =
      kept && kept.of === of(item)
        ? structuredClone(/** @type {HistoryScan} */ (kept))
        : { found: [], lo: null, next: { from: Math.max(0, item.height - reach), page: 1, to: item.height }, of: of(item) };

    return { item, left: pages, state };
  });
  /** @type {Reading[]} */
  let covered = [];
  /** @type {Queued[]} */
  let given = [];
  /** @type {Queued[]} */
  let queue = [];
  /** @type {Map<string, number[]>} */
  const unread = new Map();

  for (;;) {
    // Each one's next range, as far as its pages go.
    for (const walk of walks) {
      const { state } = walk;

      while (state.next && walk.left > 0) {
        const next = /** @type {NonNullable<HistoryScan["next"]>} */ (state.next);
        const range = await historyRange(archive, { account, direction, from: next.from, page: next.page, pages: walk.left, to: next.to });
        const found = /** @type {HistoryScan["found"][number][]} */ (state.found);

        counter.requests += range.requests;
        walk.left -= range.requests;

        for (const entry of range.entries) {
          if (keep(entry) && !found.some((each) => each.hash === entry.hash)) found.push({ hash: entry.hash, height: entry.blockHeight, value: String(entry.value) });
        }

        if (!range.complete) {
          state.next = { ...next, page: next.page + range.requests };
        } else if (state.lo === null && !found.some((each) => each.hash === walk.item.hash)) {
          // Its own block isn't read yet: its last page is read again.
          state.next = { ...next, page: next.page + range.requests - 1 };
          walk.left = 0;
        } else {
          state.lo = next.from;
          state.next = null;
        }
      }
    }

    const done = walks.filter((walk) => !walk.state.next);

    if (!done.length) {
      covered = [];
      given = [];
      break;
    }

    given = done.map((walk) => queued(walk.item)).sort(byTime);

    const mine = new Set(given.map((item) => item.hash));
    // The others found: those given are in the queue as they are.
    const { peers, unread: unknown } = await peersOf(uniqueByHash(done.flatMap((walk) => walk.state.found)).filter((entry) => !mine.has(entry.hash)));
    let deeper = false;

    queue = queueOf(given, peers, horizonMs);

    // A run reaching within a horizon of the bottom may go on under it: the
    // history is read further down.
    for (const walk of done) {
      const lo = /** @type {number} */ (walk.state.lo);
      const bottomAt = lo === 0 ? -Infinity : walk.item.at - (walk.item.height - lo) * DUSK_BLOCK_MS;
      const self = /** @type {Queued} */ (given.find((each) => each.hash === walk.item.hash));

      if (runStart(queue, self, horizonMs).at - bottomAt < horizonMs) {
        walk.state.next = { from: Math.max(0, lo - reach), page: 1, to: lo - 1 };
        deeper = true;
      } else {
        unread.set(
          walk.item.hash,
          unknown.flatMap((each) => (each.height >= lo && each.height <= walk.item.height ? [each.height] : []))
        );
      }
    }

    if (!deeper) {
      covered = done.map((walk) => walk.item);
      break;
    }
  }

  return { covered, given, queue, states: new Map(walks.map((walk) => [walk.item.hash, walk.state])), unread };
}

/**
 * Of the deposits a sender's history lists, those equal to the group's
 * (`to`, `amount`), from their calls: each with the block the app gave it
 * its credit can't be before; and those whose call or time the archive
 * doesn't give, which could be any deposit of up to what they paid, but
 * for one the app gave: its own facts tell. `calls` keeps each call read.
 *
 * @param {Archive} archive
 * @param {Network} net
 * @param {ReadonlyArray<{ hash: string, height: number }>} found
 * @param {{ amount: bigint, to: string, bounds: ReadonlyMap<string, bigint | null>, calls: Map<string, any>, supplied: ReadonlyMap<string, DepositItem> }} group
 * @param {{ requests: number }} counter
 */
async function depositPeers(archive, net, found, { amount, bounds, calls, supplied, to }, counter) {
  const missing = found.flatMap((entry) => (calls.has(entry.hash) ? [] : [entry.hash]));
  const read = await detailsOf(archive, missing, { args: true, network: net }, counter);

  for (const hash of missing) calls.set(hash, read.get(hash) ?? null);

  /** @type {Queued[]} */
  const peers = [];
  /** @type {{ hash: string, height: number }[]} */
  const unread = [];

  for (const entry of found) {
    const call = calls.get(entry.hash);
    const bridged = call?.bridge;

    // Failed, or a call that isn't a deposit: no DUSK left for DuskEVM. A
    // deposit whose arguments can't be read could be any.
    if (call?.success === false || (bridged && bridged.kind !== "deposit") || (bridged === null && call?.fnName !== BRIDGE_FUNCTIONS.deposit)) continue;

    const own = supplied.get(entry.hash);
    let at = msOf(call?.timestamp);
    let paid = luxOf(bridged?.amount);
    let recipient = addressOf(bridged?.to);

    // One the app gave whose call can't be read: its own facts.
    if (own && (!call || at === null || paid === null || !recipient)) ({ amount: paid, at, to: recipient } = own);

    if (at === null || paid === null || !recipient) unread.push(entry);
    else if (recipient === to && paid === amount) peers.push({ at, given: false, hash: entry.hash, notBefore: bounds.get(entry.hash) ?? null, scan: null });
  }

  return { peers, unread };
}

/**
 * Where a scan's search stopped, with the width of its windows, without its
 * history.
 *
 * @param {Scan | null | undefined} scan
 * @returns {Scan}
 */
function searchOf(scan) {
  if (scan?.from === undefined) return {};

  /** @type {Scan} */
  const out = { basis: scan.basis, from: scan.from, search: scan.search, seen: scan.seen };

  if (scan.start !== undefined) out.start = scan.start;
  if (scan.recheck !== undefined) out.recheck = scan.recheck;
  if (scan.size !== undefined) out.size = scan.size;
  if (scan.refused !== undefined) out.refused = scan.refused;

  return out;
}

/**
 * The transfers whose history isn't all read yet wait, with where their
 * reading stopped beside where their last search did.
 *
 * @param {ReadonlyArray<{ hash: string, scan: Scan | null }>} items
 * @param {{ covered: ReadonlyArray<{ hash: string }>, states: ReadonlyMap<string, HistoryScan> }} history
 * @param {Map<string, Arrival>} results
 */
function waitForHistory(items, { covered, states }, results) {
  const read = new Set(covered.map((item) => item.hash));

  for (const item of items) {
    if (!read.has(item.hash)) results.set(item.hash, { scan: { ...searchOf(item.scan), history: /** @type {HistoryScan} */ (states.get(item.hash)) }, state: "waiting" });
  }
}

/**
 * A result, with how far its transfer's history is read, which every one
 * but an arrival keeps in its scan for the next call.
 *
 * @param {string} hash
 * @param {Arrival} arrival
 * @param {ReadonlyArray<Queued>} given
 * @param {ReadonlyMap<string, HistoryScan>} states
 * @returns {Arrival}
 */
function withHistory(hash, arrival, given, states) {
  const history = states.get(hash);

  if (!history || arrival.state === "arrived") return arrival;

  return { ...arrival, scan: { ...(arrival.scan ?? searchOf(given.find((each) => each.hash === hash)?.scan)), history } };
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
 * @returns {DepositItem}
 */
function depositIn(deposit) {
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
 * A transfer out as given, checked: its route, the fee the app gives where
 * it gives one, and where an earlier search stopped.
 *
 * @typedef {{ fee: bigint | null, hash: string, notBefore: bigint | null, route: (Route & { kind: "service" }) | undefined, scan: Scan | null }} TransferItem
 */

/**
 * A transfer out as the chain has it, which pays out: its block's time and
 * height, the bridge's fee, what it pays out, and the address it pays.
 *
 * @typedef {TransferItem & { at: number, fee: bigint, height: number, net: bigint, route: Route & { kind: "service" }, to: string }} SentItem
 */

/**
 * @param {ServiceTransfer} transfer
 * @param {ReadonlyArray<Route>} services the network's service routes
 * @returns {TransferItem}
 */
function transferIn(transfer, services) {
  const hash = duskHashOf(transfer?.hash);
  const route = /** @type {(Route & { kind: "service" }) | undefined} */ (services.find((each) => each.id === transfer?.route));
  const given = transfer?.fee !== undefined && transfer.fee !== null;
  const fee = given ? luxOf(transfer.fee) : null;

  if (!hash) throw new TypeError("A transfer's hash is its Dusk transaction's: 64 hex digits");
  if (given && fee === null) throw new TypeError("A transfer's fee is lux: at most a u64");

  return { fee, hash, notBefore: quantityOf(transfer.notBefore), route, scan: scanOf(transfer.scan) };
}

/**
 * How long apart equal transfers out on a route are still paid in their
 * order: 12 hours, or four times the route's usual time.
 *
 * @param {Route} route
 */
const horizonOf = (route) => Math.max(SERVICE_HORIZON_MS, 4 * (route.typicalSeconds ?? 0) * 1000);

/**
 * @param {{ hash: string, at: number | null, notBefore: bigint | null, scan: Scan | null }} item
 * @returns {Queued}
 */
const queued = (item) => ({ at: /** @type {number} */ (item.at), given: true, hash: item.hash, notBefore: item.notBefore, scan: item.scan });

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
function triage(list, results, { now, waitMs }) {
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
function uniqueByHash(list) {
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
const inOrder = (list, results) => new Map(list.map((item) => [item.hash, /** @type {Arrival} */ (results.get(item.hash))]));

/**
 * @param {Iterable<string> | undefined} taken
 * @param {(value: unknown) => string} hashOf
 */
const usedOf = (taken, hashOf) => new Set([...(taken ?? [])].map(hashOf).filter(Boolean));

// ---------------------------------------------------------------------------
// Deposits to DuskEVM
// ---------------------------------------------------------------------------

/**
 * @param {DepositArrivalOptions} options
 * @returns {Promise<{ arrivals: Map<string, Arrival>, requests: number }>}
 */
export async function depositArrivals({
  network,
  deposits,
  via = "explorer",
  fetch: fetchFn,
  explorerUrl,
  rpcUrl,
  archive,
  taken,
  blockTimes,
  now = Date.now(),
  waitMs = WAIT_MS,
  windowMs = CREDIT_WINDOW_MS,
  maxPages = EXPLORER_PAGES,
  maxWindows = LOG_WINDOWS,
  timeoutMs = TIMEOUT_MS,
}) {
  if (via !== "explorer" && via !== "rpc") throw new RangeError('A deposit is followed on the "explorer" or the "rpc"');

  const net = networkOf(network);
  const list = uniqueByHash(Array.from(deposits ?? [], depositIn));
  const read = reader(fetchFn, timeoutMs);
  /** @type {Map<string, Arrival>} */
  const results = new Map();
  const evm = net.duskEvm;

  if (!evm) {
    for (const item of list) results.set(item.hash, { reason: "no-route", state: "unknown" });

    return { arrivals: inOrder(list, results), requests: 0 };
  }

  const used = usedOf(taken, evmHashOf);
  const live = triage(list, results, { now, waitMs });
  // Waited for too long: not looked for, though still before the newer ones.
  const past = list.filter((item) => item.at !== null && now - item.at > waitMs);
  const bridge = evm.predeploys.l2StandardBridge.toLowerCase();
  const rules = { now, past, results, used, windowMs };

  if (via === "explorer") {
    await onExplorer(read, live, { ...rules, api: String(explorerUrl ?? evm.blockscoutApiUrl), bridge, maxPages });
  } else {
    await onRpc(read, live, { ...rules, archive, blockTimes, bridge, list, maxWindows, net, url: String(rpcUrl ?? evm.rpcUrl) });
  }

  return { arrivals: inOrder(list, results), requests: read.counter.requests };
}

/**
 * The L2 bridge's payments to an address, as DuskEVM's explorer lists its
 * incoming calls: newest first, a page at a time (the explorer's
 * `next_page_params`), back past `since`, at most `maxPages`. `complete`
 * once they reach it, or there are no more.
 *
 * @param {Reader} read
 * @param {{ api: string, bridge: string, maxPages: number, since: number, to: string }} ask
 * @returns {Promise<{ complete: boolean, payments: Credit[] }>}
 */
async function explorerPayments(read, { api, bridge, maxPages, since, to }) {
  const base = `${api.replace(/\/+$/, "")}/addresses/${to}/internal-transactions`;
  /** @type {any[]} */
  const items = [];
  /** @type {Record<string, unknown> | null} */
  let next = null;
  let complete = false;

  for (let page = 0; page < Math.max(1, Math.floor(maxPages)) && !complete; page += 1) {
    const query = new URLSearchParams({ filter: "to" });

    for (const [key, value] of Object.entries(next ?? {})) query.set(key, String(value));

    const body = await read.getJson(`${base}?${query}`);
    const calls = Array.isArray(body?.items) ? body.items : [];
    const oldest = Math.min(...calls.map((/** @type {any} */ call) => timeOf(call?.timestamp)).filter(Number.isFinite));

    items.push(...calls);
    next = body?.next_page_params && typeof body.next_page_params === "object" ? body.next_page_params : null;
    complete = !next || !calls.length || oldest < since;
  }

  /** @type {Map<string, Credit>} */
  const payments = new Map();

  for (const call of items) {
    const hash = evmHashOf(call?.transaction_hash);
    const at = timeOf(call?.timestamp);
    const value = String(call?.value ?? "");
    const payee = call?.to?.hash;

    if (!hash || payments.has(hash) || !Number.isFinite(at) || !/^\d+$/.test(value)) continue;
    if (String(call?.from?.hash ?? "").toLowerCase() !== bridge) continue;
    if (payee !== undefined && payee !== null && String(payee).toLowerCase() !== to) continue;

    payments.set(hash, { at, block: quantityOf(call?.block_number), from: null, hash, success: call?.success !== false, wei: BigInt(value) });
  }

  return { complete, payments: [...payments.values()] };
}

/**
 * Deposits followed on DuskEVM's explorer: each recipient's incoming calls
 * read once for all its deposits, and matched as where the credits can't be
 * told apart, as they don't say who deposited. Equal deposits past their
 * wait just before them take their payments first, their results kept.
 *
 * @param {Reader} read
 * @param {DepositItem[]} live
 * @param {{ api: string, bridge: string, maxPages: number, now: number, past: DepositItem[], results: Map<string, Arrival>, used: Set<string>, windowMs: number }} options
 */
async function onExplorer(read, live, { api, bridge, maxPages, now, past, results, used, windowMs }) {
  for (const [to, items] of groupBy(live, (item) => item.to)) {
    const polled = new Set(items.map((item) => item.hash));
    const groups = [...groupBy(items, (item) => item.amount.toString()).values()].map((group) => ({
      queue: withPast(
        group.map(queued),
        past.filter((item) => item.to === to && item.amount === group[0].amount).map(queued),
        windowMs
      ),
      wei: group[0].amount * WEI_PER_LUX,
    }));

    // Nothing can be told apart before a window is over: nothing is asked.
    if (groups.every(({ queue }) => allOpen(queue, windowMs, now))) {
      for (const item of items) results.set(item.hash, { state: "waiting" });
      continue;
    }

    /** @type {{ complete: boolean, payments: Credit[] }} */
    let page;

    try {
      page = await explorerPayments(read, { api, bridge, maxPages, since: Math.min(...groups.flatMap(({ queue }) => queue.map((item) => item.at))) - windowMs, to });
    } catch (error) {
      for (const item of items) results.set(item.hash, { error: messageOf(error), reason: "error", state: "unknown" });
      continue;
    }

    // Not back to the oldest: a payment of an older one may be a newer one's.
    if (!page.complete) {
      for (const item of items) results.set(item.hash, { reason: "beyond", state: "unknown" });
      continue;
    }

    for (const { queue, wei } of groups) {
      const { assigned, verdicts } = settle(
        queue,
        page.payments.filter((payment) => payment.wei === wei),
        { guarded: true, now, slackMs: windowMs, used, windowMs }
      );

      for (const item of queue.filter((each) => polled.has(each.hash))) {
        const credit = assigned.get(item.hash);
        const verdict = verdicts.get(item.hash);

        if (credit && verdict === "arrived") {
          used.add(credit.hash);
          results.set(item.hash, { amount: credit.wei / WEI_PER_LUX, at: credit.at, block: credit.block === null ? null : Number(credit.block), hash: credit.hash, state: "arrived" });
        } else {
          results.set(item.hash, verdict === "waiting" ? { state: "waiting" } : { reason: verdict === "unsure" ? "unsure" : "late", state: "unknown" });
        }
      }
    }
  }
}

/**
 * Deposits followed on DuskEVM's RPC, by the bridge's events from each
 * sender's DuskEVM address: a group of equal deposits from one sender at a
 * time, with the sender's equal deposits shortly before, from its history,
 * when there's an archive; without it, with the equal ones given that are
 * past their wait just before them.
 *
 * @param {Reader} read
 * @param {DepositItem[]} live
 * @param {{ archive: Archive | undefined, blockTimes: BlockTimes | undefined, bridge: string, list: DepositItem[], maxWindows: number, net: Network, now: number, past: DepositItem[], results: Map<string, Arrival>, url: string, used: Set<string>, windowMs: number }} options
 */
async function onRpc(read, live, { archive, blockTimes, bridge, list, maxWindows, net, now, past, results, url, used, windowMs }) {
  // Equal deposits (the same DuskEVM address and amount) from a known sender
  // first, a sender at a time, its events telling its credits apart; then
  // those whose sender isn't known, which take none from the senders of the
  // app's other equal deposits, looked for or not: those could be theirs.
  /** @param {DepositItem} item */
  const keyOf = (item) => `${item.to}:${item.amount}`;
  const aliases = new Map(
    [...groupBy(list.filter((item) => item.sender !== null), keyOf)].map(([key, items]) => [key, new Set(items.map((item) => evmAddressOf(/** @type {string} */ (item.sender)).toLowerCase()))])
  );
  /** @type {{ items: DepositItem[], rivals: Set<string> }[]} */
  const known = [];
  /** @type {{ items: DepositItem[], rivals: Set<string> }[]} */
  const unknown = [];

  for (const [key, items] of groupBy(
    live.filter((item) => !results.has(item.hash)),
    keyOf
  )) {
    const rest = items.filter((item) => item.sender === null);

    for (const group of groupBy(
      items.filter((item) => item.sender !== null),
      (item) => /** @type {string} */ (item.sender)
    ).values()) {
      known.push({ items: group, rivals: new Set() });
    }

    if (rest.length) unknown.push({ items: rest, rivals: aliases.get(key) ?? new Set() });
  }

  // The block each deposit given can't be credited before, the app's own,
  // the deposits given, and the deposits' calls, read once.
  const bounds = new Map(list.map((item) => [item.hash, item.notBefore]));
  const supplied = new Map(list.map((item) => [item.hash, item]));
  /** @type {Map<string, any>} */
  const calls = new Map();
  const contract = duskEvmContracts(net)?.bridge;

  for (const { items, rivals } of [...known, ...unknown]) {
    const { amount, sender, to } = items[0];
    const vouched = Boolean(archive) && sender !== null && items.every((item) => item.height !== null);
    let given = items.map(queued).sort(byTime);
    /** @type {Queued[]} */
    let queue;
    /** @type {Set<string>} */
    const unsure = new Set();
    /** @type {Map<string, HistoryScan>} */
    let states = new Map();

    if (vouched) {
      // Each deposit's own hours of its sender's history, with its sender's
      // equal deposits there, the app's no longer looked for among them.
      /** @type {Awaited<ReturnType<typeof readHistories>>} */
      let history;

      try {
        history = await readHistories(
          /** @type {Archive} */ (archive),
          /** @type {Reading[]} */ ([...items].sort((a, b) => /** @type {number} */ (a.height) - /** @type {number} */ (b.height))),
          {
            account: /** @type {string} */ (sender),
            direction: "out",
            horizonMs: DEPOSIT_HORIZON_MS,
            keep: (entry) => entry.counterparty === contract && entry.value >= amount,
            of: (item) => `${sender}:${item.height}:${amount}`,
            pages: HISTORY_PAGES,
            peersOf: (found) => depositPeers(/** @type {Archive} */ (archive), net, found, { amount, bounds, calls, supplied, to }, read.counter),
            reach: Math.ceil((3 * DEPOSIT_HORIZON_MS) / DUSK_BLOCK_MS),
          },
          read.counter
        );
      } catch (error) {
        for (const item of items) results.set(item.hash, { error: messageOf(error), reason: "error", state: "unknown" });
        continue;
      }

      states = history.states;
      waitForHistory(items, history, results);

      if (!history.covered.length) continue;

      given = history.given;
      queue = history.queue;

      // One before it whose call can't be read could be equal: the credits'
      // order can't be told.
      for (const item of given) if (/** @type {number[]} */ (history.unread.get(item.hash)).length) unsure.add(item.hash);
    } else {
      queue = withPast(
        given,
        past.filter((item) => item.to === to && item.amount === amount && item.sender === sender).map(queued),
        windowMs
      );
    }

    try {
      const found = await followLogs(
        read,
        {
          filter: {
            address: bridge,
            amountOf: bridgeFinalizedAmount,
            topics: [ETH_BRIDGE_FINALIZED_TOPIC, sender === null ? null : topicOf(evmAddressOf(sender)), topicOf(to)],
            wei: amount * WEI_PER_LUX,
          },
          given,
          guarded: !vouched,
          queue,
          rivals,
          unsure,
        },
        { blockTimes, maxWindows, now, slackMs: CLOCK_SLACK_MS, url, used, windowMs }
      );

      for (const [hash, arrival] of found) results.set(hash, withHistory(hash, arrival, given, states));
    } catch (error) {
      for (const item of given) results.set(item.hash, withHistory(item.hash, { error: messageOf(error), reason: "error", state: "unknown" }, given, states));
    }
  }
}

// ---------------------------------------------------------------------------
// Transfers out to another chain
// ---------------------------------------------------------------------------

/**
 * @param {unknown} error
 * @returns {Arrival}
 */
const failed = (error) => ({ error: messageOf(error), reason: "error", state: "unknown" });

/**
 * @param {ServiceArrivalOptions} options
 * @returns {Promise<{ arrivals: Map<string, Arrival>, requests: number }>}
 */
export async function serviceArrivals({
  network,
  transfers,
  archive,
  fetch: fetchFn,
  rpcUrl,
  taken,
  blockTimes,
  now = Date.now(),
  waitMs = WAIT_MS,
  maxWindows = LOG_WINDOWS,
  timeoutMs = TIMEOUT_MS,
}) {
  if (!archive || typeof archive.query !== "function") {
    throw new TypeError("An archive is required: it gives each transfer, and those that named the same address before it");
  }

  const net = networkOf(network);
  const services = routes(net).filter((route) => route.kind === "service");
  const list = uniqueByHash(Array.from(transfers ?? [], (transfer) => transferIn(transfer, services)));
  const read = reader(fetchFn, timeoutMs);
  /** @type {Map<string, Arrival>} */
  const results = new Map();
  const used = usedOf(taken, evmHashOf);
  const done = () => ({ arrivals: inOrder(list, results), requests: read.counter.requests });
  const routed = list.filter((item) => {
    const route = item.route;

    if (!route || !route.payoutAddress || !route.chain.token) results.set(item.hash, { reason: "no-route", state: "unknown" });

    return !results.has(item.hash);
  });
  /** @type {Map<string, TransferFacts>} */
  let sent;

  // Each transfer as the chain has it: whom it paid, what the route's
  // account received, and the address its memo gives, as the route's
  // bridge reads them, not as the app does.
  try {
    sent = await transfersOf(archive, routed.map((item) => item.hash), read.counter);
  } catch (error) {
    for (const item of routed) results.set(item.hash, failed(error));

    return done();
  }

  /** @type {SentItem[]} */
  const known = [];

  for (const item of routed) {
    const route = /** @type {Route & { kind: "service" }} */ (item.route);
    const facts = sent.get(item.hash);
    const fee = item.fee ?? route.feeLux;

    // Not in a final block yet, as far as the archive knows.
    if (!facts) {
      results.set(item.hash, { state: "waiting" });
      continue;
    }

    if (facts.kind === null || facts.at === null || facts.height === null || (facts.kind === "moonlight" && (facts.value === null || facts.receiver === null))) {
      results.set(item.hash, { reason: "unsure", state: "unknown" });
      continue;
    }

    const value = /** @type {bigint} */ (facts.value);
    /** @type {"failed" | "elsewhere" | "under-fee" | "no-address" | null} */
    const problem = facts.failed
      ? "failed"
      : facts.kind !== "moonlight" || facts.receiver !== route.account
        ? "elsewhere"
        : value <= fee
          ? "under-fee"
          : EVM_ADDRESS.test(facts.memo)
            ? null
            : "no-address";

    if (problem) results.set(item.hash, { problem, reason: "no-payout", state: "unknown" });
    else known.push({ ...item, at: facts.at, fee, height: facts.height, net: value - fee, route, to: facts.memo.toLowerCase() });
  }

  const live = triage(known, results, { now, waitMs });
  // The block times the app keeps for a route's chain: by its chain ID, or
  // the one cache given, where the network's service routes are all on one
  // chain.
  const oneChain = new Set(services.map((route) => route.chain?.chainId)).size === 1;
  /** @param {Route} route @returns {BlockTimes | undefined} */
  const timesOf = (route) => (typeof blockTimes === "function" ? (blockTimes(route.chain.chainId) ?? undefined) : oneChain ? blockTimes : undefined);
  // The fee of each transfer the app gave, those no longer looked for too,
  // and the block its payout can't be before.
  const feeOf = new Map(routed.map((item) => [item.hash, item.fee ?? /** @type {Route & { kind: "service" }} */ (item.route).feeLux]));
  const bounds = new Map(routed.map((item) => [item.hash, item.notBefore]));
  // What each transfer to a route's account paid whom, its memo and its
  // time, from its own transaction, read once.
  /** @type {Map<string, TransferFacts | null>} */
  const facts = new Map(sent);

  for (const items of groupBy(live, (item) => `${item.route.id}:${item.to}:${item.net}`).values()) {
    const { net: payout, route, to } = items[0];
    const horizonMs = horizonOf(route);
    const fees = new Set(items.map((item) => item.fee));
    const least = payout + [...fees].reduce((a, fee) => (fee < a ? fee : a));
    // Each transfer's own hours of the route's account's history: every
    // transfer that named the same address, in any case, and could be paid
    // before, the app's no longer looked for among them. Of those, the ones
    // that could pay out as much under the group's fees, or under their own.
    /** @type {Awaited<ReturnType<typeof readHistories>>} */
    let history;

    try {
      history = await readHistories(
        archive,
        [...items].sort((a, b) => a.height - b.height),
        {
          account: route.account,
          direction: "in",
          horizonMs,
          keep: (entry) => entry.kind === "transfer" && entry.direction === "in" && entry.memo.toLowerCase() === to && entry.value >= payout,
          of: (item) => `${route.account}:${item.height}:${to}:${payout}`,
          pages: HISTORY_PAGES,
          peersOf: (found) =>
            servicePeers(
              archive,
              found.filter((entry) => BigInt(entry.value) >= least || feeOf.has(entry.hash)),
              { bounds, facts, feeOf, fees, payout, route, to },
              read.counter
            ),
          reach: Math.ceil((3 * horizonMs) / DUSK_BLOCK_MS),
        },
        read.counter
      );
    } catch (error) {
      for (const item of items) results.set(item.hash, failed(error));
      continue;
    }

    waitForHistory(items, history, results);

    if (!history.covered.length) continue;

    const { given } = history;
    // One before it that can't be read could be equal: the payouts' order
    // can't be told.
    const unsure = new Set(given.flatMap((item) => (/** @type {number[]} */ (history.unread.get(item.hash)).length ? [item.hash] : [])));

    try {
      const found = await followLogs(
        read,
        {
          filter: {
            address: /** @type {string} */ (route.chain.token).toLowerCase(),
            amountOf: transferValue,
            topics: [TRANSFER_TOPIC, topicOf(/** @type {string} */ (route.payoutAddress)), topicOf(to)],
            wei: payout * WEI_PER_LUX,
          },
          given,
          guarded: false,
          queue: history.queue,
          unsure,
        },
        { blockTimes: timesOf(route), maxWindows, now, slackMs: CLOCK_SLACK_MS, url: String(rpcUrl ?? route.chain.rpcUrl), used, windowMs: CREDIT_WINDOW_MS }
      );

      for (const [hash, arrival] of found) results.set(hash, withHistory(hash, arrival, given, history.states));
    } catch (error) {
      for (const item of given) results.set(item.hash, withHistory(item.hash, failed(error), given, history.states));
    }
  }

  return done();
}

/**
 * Of the transfers a route's account received naming a group's address,
 * those equal to the group's, from their own transactions: one the app
 * gave pays out what its own fee leaves, one it didn't what the group's
 * fees do; each with the block the app gave it its payout can't be before.
 * And those whose transaction can't be read. `facts` keeps each
 * transaction read.
 *
 * @param {Archive} archive
 * @param {ReadonlyArray<{ hash: string, height: number }>} found
 * @param {{ bounds: ReadonlyMap<string, bigint | null>, facts: Map<string, TransferFacts | null>, feeOf: ReadonlyMap<string, bigint>, fees: ReadonlySet<bigint>, payout: bigint, route: Route & { kind: "service" }, to: string }} group
 * @param {{ requests: number }} counter
 */
async function servicePeers(archive, found, { bounds, facts, feeOf, fees, payout, route, to }, counter) {
  const missing = found.flatMap((entry) => (facts.has(entry.hash) ? [] : [entry.hash]));
  const read = await transfersOf(archive, missing, counter);

  for (const hash of missing) facts.set(hash, read.get(hash) ?? null);

  /** @type {Queued[]} */
  const peers = [];
  /** @type {{ hash: string, height: number }[]} */
  const unread = [];

  for (const entry of found) {
    const fact = facts.get(entry.hash);

    if (!fact || fact.kind === null || fact.at === null || (fact.kind === "moonlight" && (fact.value === null || fact.receiver === null))) {
      unread.push(entry);
    } else if (!fact.failed && fact.kind === "moonlight" && fact.receiver === route.account && fact.memo.toLowerCase() === to) {
      const value = /** @type {bigint} */ (fact.value);
      const own = feeOf.get(entry.hash);

      if (own === undefined ? [...fees].some((fee) => value - fee === payout) : value - own === payout) {
        peers.push({ at: fact.at, given: false, hash: entry.hash, notBefore: bounds.get(entry.hash) ?? null, scan: null });
      }
    }
  }

  return { peers, unread };
}

// ---------------------------------------------------------------------------
// Migrations into Dusk
// ---------------------------------------------------------------------------

/**
 * The migration routes an account pays out. More than one where a
 * deployment has one account pay out both chains' migrations: then a
 * payout of it doesn't say which route it is on.
 *
 * @param {Network} net
 * @param {string} account
 * @returns {Route[]}
 */
const paidOutBy = (net, account) => routes(net).filter((route) => route.kind === "migration" && Boolean(route.payoutAccount) && route.payoutAccount === account.trim());

/**
 * The payouts of migrations a transfer the archive lists holds for
 * `account`, read from its own events: from a migration route's payout
 * account, with a transaction hash as the memo, each of its own amount, a
 * gas refund aside.
 *
 * @param {any} raw
 * @param {string} account
 * @param {Network} net
 * @returns {MigrationPayout[]}
 */
function payoutsIn(raw, account, net) {
  const payout = duskHashOf(raw?.origin);
  const block = heightOf(Number(raw?.block_height));

  if (!payout || block === null) return [];

  return (Array.isArray(raw?.events) ? raw.events : []).flatMap((/** @type {any} */ event) => {
    const data = event?.data;
    const paying = data && event.reverted !== true && event.topic === "moonlight" && String(event.target ?? "").toLowerCase() === TRANSFER_CONTRACT && data.receiver === account && typeof data.sender === "string" ? paidOutBy(net, data.sender) : [];
    const memo = memoOf(data?.memo).trim().toLowerCase();
    const amount = luxOf(data?.value);

    return paying.length && EVM_HASH.test(memo) && amount !== null
      ? [{ amount, at: null, block, hash: /** @type {`0x${string}`} */ (memo), payer: data.sender.trim(), payout, route: paying.length === 1 ? paying[0].id : null }]
      : [];
  });
}

/**
 * @param {MigrationPayoutOptions} options
 * @returns {Promise<{ payouts: Map<string, Arrival>, unlisted: MigrationPayout[], requests: number }>}
 */
export async function migrationPayouts({ network, migrations, entries, archive, account, taken, now = Date.now(), waitMs = WAIT_MS }) {
  const net = networkOf(network);
  const kinds = routes(net).filter((route) => route.kind === "migration");
  const list = uniqueByHash(
    Array.from(migrations ?? [], (migration) => {
      const hash = evmHashOf(migration?.hash);
      const amount = luxOf(migration?.amount);

      if (!hash) throw new TypeError("A migration's hash is its transaction's on its chain: 0x and 64 hex digits");
      if (amount === null) throw new TypeError("A migration's amount is lux: at most a u64");

      return { amount, at: msOf(migration.at), hash, route: kinds.find((route) => route.id === migration?.route) };
    })
  );
  /** @type {Map<string, Arrival>} */
  const results = new Map();
  const counter = { requests: 0 };
  const used = usedOf(taken, duskHashOf);
  const payable = list.filter((item) => {
    if (!item.route || item.route.kind !== "migration" || !item.route.payoutAccount) results.set(item.hash, { reason: "no-route", state: "unknown" });

    return !results.has(item.hash);
  });
  /** @type {MigrationPayout[]} */
  let candidates;

  if (entries) {
    candidates = Array.from(entries, (entry) => migrationPayoutOf(entry, net)).filter((payout) => payout !== null);
  } else {
    if (!archive || typeof archive.query !== "function") throw new TypeError("Either the account's entries or an archive is required");
    if (!isAccount(account)) throw new TypeError("The archive is read for a Dusk account: the one the migrations pay");

    // Not looked for once waited for too long.
    const asked = payable.filter((item) => item.at === null || now - item.at <= waitMs);

    try {
      const listed = await byMemo(archive, asked.map((item) => item.hash), counter);
      const found = [...listed.values()].flat().flatMap((raw) => payoutsIn(raw, /** @type {string} */ (account), net));
      // Their times, and whether they went through.
      const details = await detailsOf(archive, found.map((payout) => payout.payout), {}, counter);

      candidates = found.flatMap((payout) => {
        const known = details.get(payout.payout);

        return known?.success === false ? [] : [{ ...payout, at: msOf(known?.timestamp) }];
      });
    } catch (error) {
      for (const item of asked) results.set(item.hash, { error: messageOf(error), reason: "error", state: "unknown" });
      candidates = [];
    }
  }

  // Each payout pays one migration: the migration its memo names, of the
  // amount it paid, from its route's payout account.
  const byBlock = [...candidates].sort((a, b) => a.block - b.block || (a.payout < b.payout ? -1 : 1));

  for (const item of [...payable].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))) {
    if (results.has(item.hash)) continue;

    const named = byBlock.filter((each) => !used.has(each.payout) && each.hash === item.hash && each.payer === item.route?.payoutAccount);
    const payout = named.find((each) => each.amount === item.amount);

    if (payout) {
      used.add(payout.payout);
      results.set(item.hash, { amount: payout.amount, at: payout.at, block: payout.block, hash: payout.payout, state: "arrived" });
    } else if (named.length) {
      // Its payout, of another amount: another amount was paid, or the value
      // of an entry an earlier version kept holds a gas refund paid to the
      // account. Not waiting: unsure.
      results.set(item.hash, { reason: "unsure", state: "unknown" });
    } else {
      results.set(item.hash, item.at !== null && now - item.at > waitMs ? { reason: "expired", state: "unknown" } : { state: "waiting" });
    }
  }

  // Payouts of migrations the app didn't list: sent from another device, or before.
  const named = new Set(list.map((item) => item.hash));
  const unlisted = entries ? byBlock.filter((payout) => !named.has(payout.hash) && !used.has(payout.payout)) : [];

  return { payouts: inOrder(list, results), requests: counter.requests, unlisted };
}

// ---------------------------------------------------------------------------
// History entries as the bridge's transfers
// ---------------------------------------------------------------------------

/**
 * @param {HistoryLike} entry
 * @returns {{ hash: string, value: bigint | null, at: number | null, height: number | null }}
 */
const factsOf = (entry) => ({ at: msOf(entry?.timestamp), hash: duskHashOf(entry?.hash), height: heightOf(entry?.blockHeight), value: luxOf(entry?.value) });

/**
 * @param {HistoryLike} entry
 * @param {string} [account]
 * @returns {Deposit | null}
 */
export function depositOf(entry, account) {
  const bridge = /** @type {any} */ (entry)?.bridge;
  const { at, hash, height } = factsOf(entry);
  const amount = luxOf(bridge?.amount);
  const to = typeof bridge?.to === "string" && EVM_ADDRESS.test(bridge.to) ? bridge.to : "";

  if (bridge?.kind !== "deposit" || !entry.payer || entry.success === false || !hash || amount === null || amount === 0n || !to) return null;

  return { amount, at, hash, height, sender: account && isAccount(account) ? account : null, to };
}

/**
 * @param {HistoryLike} entry
 * @param {NetworkRef} network
 * @returns {ServiceTransferFacts | null}
 */
export function serviceTransferOf(entry, network) {
  const net = networkOf(network);
  const route = entry?.kind === "transfer" && entry.direction === "out" && typeof entry.counterparty === "string" ? routeForAccount(net, entry.counterparty, "out") : null;
  const { at, hash, height, value } = factsOf(entry);

  if (!route || route.kind !== "service" || !hash || value === null) return null;

  // What left the account holds any gas refund it paid another account,
  // which the entry doesn't tell apart: what the route's account received
  // is known only where no gas was left to refund.
  const limit = luxOf(entry.gasLimit);
  const spent = luxOf(entry.gasSpent);
  const price = luxOf(entry.gasPrice);
  const amount = limit !== null && spent !== null && price !== null && (limit - spent) * price <= 0n ? value : null;
  // The address the memo gives, exactly as the bridge reads it.
  const memo = typeof entry.memo === "string" ? entry.memo : "";
  const to = EVM_ADDRESS.test(memo) ? memo : null;
  const problem = entry.success === false ? "failed" : value <= route.feeLux ? "under-fee" : to === null ? "no-address" : null;

  return { amount, at, fee: route.feeLux, hash, height, problem, route: route.id, sent: value, to };
}

/**
 * @param {HistoryLike} entry
 * @param {NetworkRef} network
 * @returns {MigrationPayout | null}
 */
export function migrationPayoutOf(entry, network) {
  const net = networkOf(network);
  const paying = entry?.kind === "transfer" && entry.direction === "in" && typeof entry.counterparty === "string" ? paidOutBy(net, entry.counterparty) : [];
  const { at, hash, height, value } = factsOf(entry);
  // What the transfer paid: a gas refund paid to the account with it aside.
  const refund = entry?.refund === undefined || entry.refund === null ? 0n : luxOf(entry.refund);
  const memo = String(entry?.memo ?? "")
    .trim()
    .toLowerCase();

  if (!paying.length || entry.success === false || !hash || height === null || value === null || refund === null || refund > value || !EVM_HASH.test(memo)) {
    return null;
  }

  return {
    amount: value - refund,
    at,
    block: height,
    hash: /** @type {`0x${string}`} */ (memo),
    payer: /** @type {string} */ (entry.counterparty).trim(),
    payout: hash,
    route: paying.length === 1 ? paying[0].id : null,
  };
}

/**
 * @param {ReadonlyMap<string, Arrival>} arrivals
 * @returns {Map<string, { hash: string, at: number | null }>}
 */
export function arrivalsOf(arrivals) {
  /** @type {Map<string, { hash: string, at: number | null }>} */
  const out = new Map();

  for (const [hash, arrival] of arrivals) if (arrival.state === "arrived") out.set(hash, { at: arrival.at, hash: arrival.hash });

  return out;
}
