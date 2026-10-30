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
import { duskEvmContracts, evmAddressOf } from "@dusk-network/networks/duskevm";
import { DETAILS_BATCH, TRANSFER_CONTRACT, fetchTxDetails, historyRange } from "./history.js";

/** @typedef {import("./bridge.js").Arrival} Arrival */
/** @typedef {import("./bridge.js").BlockTimes} BlockTimes */
/** @typedef {import("./bridge.js").Deposit} Deposit */
/** @typedef {import("./bridge.js").DepositArrivalOptions} DepositArrivalOptions */
/** @typedef {import("./bridge.js").FetchLike} FetchLike */
/** @typedef {import("./bridge.js").HistoryLike} HistoryLike */
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
 * its log names it (lower case; null where it isn't named).
 *
 * @typedef {{ hash: string, block: bigint | null, at: number, wei: bigint, success: boolean, from: string | null }} Credit
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
// The blocks the chain's pace is read over, how much further back than the
// pace says a search starts, and how often it steps back again from a block
// that is still later than the transfer.
const PACE_SAMPLE = 100_000n;
const PACE_MARGIN = 1.2;
const START_MARGIN = 50n;
const START_CHECKS = 4;
const MIN_WINDOW = 50n;
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
 * Where a search stopped, what it searched for, and the credits it found
 * before, as a result gave them; null for anything else.
 *
 * @param {unknown} value
 * @returns {Scan | null}
 */
function scanOf(value) {
  const scan = /** @type {any} */ (value);
  const from = quantityOf(scan?.from);

  if (from === null || typeof scan?.basis !== "number" || !Number.isFinite(scan.basis) || typeof scan.search !== "string") return null;

  const seen = (Array.isArray(scan.seen) ? scan.seen : []).flatMap((/** @type {any} */ credit) => {
    const hash = evmHashOf(credit?.hash);
    const block = quantityOf(credit?.block);
    const at = msOf(credit?.at);
    const sender = credit?.sender === null ? null : addressOf(credit?.sender);

    return hash && block !== null && at !== null && sender !== "" ? [{ at, block: block.toString(), hash, sender }] : [];
  });

  return { basis: scan.basis, from: from.toString(), search: scan.search, seen };
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
 * @param {{ guarded: boolean, now: number, slackMs: number, used: ReadonlySet<string>, windowMs: number, rivals?: ReadonlySet<string> }} rules
 * @returns {{ assigned: Map<string, Credit>, verdicts: Map<string, Verdict> }}
 */
function settle(queue, credits, { guarded, now, rivals = new Set(), slackMs, used, windowMs }) {
  const sorted = [...credits].sort(byTime);
  /** @type {Map<string, Credit>} */
  const assigned = new Map();
  const taken = new Set();
  /** @type {Map<string, Verdict>} */
  const verdicts = new Map();

  for (const item of queue) {
    const lo = item.at - (guarded ? windowMs : slackMs);
    const hi = guarded ? item.at + windowMs : Infinity;
    const credit = sorted.find(
      (c) =>
        c.success &&
        !taken.has(c.hash) &&
        (!item.given || !used.has(c.hash)) &&
        (c.from === null || !rivals.has(c.from)) &&
        c.at >= lo &&
        c.at <= hi &&
        (item.notBefore === null || c.block === null || c.block >= item.notBefore)
    );

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

  const seconds = quantityOf((await read.rpc(url, "eth_getBlockByNumber", [hex(block), false]))?.timestamp);

  if (seconds === null) throw new Error(`The chain gave no time for block ${block}`);

  const at = Number(seconds) * 1000;

  cache?.set(Number(block), at);

  return at;
}

/**
 * @param {Reader} read
 * @param {string} url
 * @returns {Promise<bigint>}
 */
async function headOf(read, url) {
  const head = quantityOf(await read.rpc(url, "eth_blockNumber", []));

  if (head === null) throw new Error("The chain gave no head");

  return head;
}

/**
 * The chain's head, and a block from before `atMs`: estimated from the
 * chain's pace over its last 100,000 blocks, a fifth further back, then
 * stepped back while its own time is still later, twice as far each time,
 * as the chain's pace may have changed.
 *
 * @param {Reader} read
 * @param {string} url
 * @param {number} atMs
 * @param {BlockTimes | undefined} cache
 * @returns {Promise<{ head: bigint, start: bigint }>}
 */
async function startBefore(read, url, atMs, cache) {
  const latest = await read.rpc(url, "eth_getBlockByNumber", ["latest", false]);
  const head = quantityOf(latest?.number);
  const headSeconds = quantityOf(latest?.timestamp);

  if (head === null || headSeconds === null) throw new Error("The chain gave no head");

  cache?.set(Number(head), Number(headSeconds) * 1000);

  const back = head < PACE_SAMPLE ? head : PACE_SAMPLE;
  // Blocks a second.
  let pace = 1;

  if (back > 0n) {
    const sample = await blockTime(read, url, head - back, cache);
    const span = Number(headSeconds) - sample / 1000;

    if (span > 0) pace = Number(back) / span;
  }

  /**
   * @param {bigint} block
   * @param {number} seconds
   * @param {number} [times]
   */
  const stepBack = (block, seconds, times = 1) => {
    const step = BigInt(Math.ceil(Math.max(0, seconds) * pace * PACE_MARGIN * times)) + START_MARGIN;

    return block > step ? block - step : 0n;
  };
  let start = stepBack(head, Number(headSeconds) - atMs / 1000);

  for (let check = 0; check < START_CHECKS && start > 0n; check += 1) {
    const at = await blockTime(read, url, start, cache);

    if (at <= atMs) break;

    start = stepBack(start, (at - atMs) / 1000, 2 ** (check + 1));
  }

  return { head, start };
}

/**
 * The credits asked for from block `start`, a window of blocks at a time, at
 * most `maxWindows`, until the head, `enough`, or a window ending after
 * `until` (`covered`): each checked against what was asked, with its block's
 * time. A window the RPC won't search at once is asked again a quarter as
 * wide.
 *
 * @param {Reader} read
 * @param {{ url: string, address: string, topics: ReadonlyArray<string | null>, wei: bigint, amountOf: (data: string) => bigint | null, start: bigint, head: bigint, maxWindows: number, blockTimes: BlockTimes | undefined, enough: (credits: Credit[]) => boolean, until: number | null, known: Credit[] }} search
 * @returns {Promise<{ complete: boolean, covered: boolean, credits: Credit[], next: bigint }>}
 */
async function searchLogs(read, { address, amountOf, blockTimes, enough, head, known, maxWindows, start, topics, until, url, wei }) {
  // What an earlier search found before `start`.
  /** @type {Credit[]} */
  const credits = [...known];
  let from = start;
  let size = BigInt(LOG_WINDOW);
  let covered = false;

  for (let round = 0; round < maxWindows && from <= head; round += 1) {
    const to = from + size - 1n < head ? from + size - 1n : head;
    /** @type {any} */
    let logs;

    try {
      logs = await read.rpc(url, "eth_getLogs", [{ address, fromBlock: hex(from), toBlock: hex(to), topics }]);
    } catch (error) {
      if (size > MIN_WINDOW && RANGE_REFUSED.test(messageOf(error))) {
        size = size / 4n > MIN_WINDOW ? size / 4n : MIN_WINDOW;
        continue;
      }

      throw error;
    }

    for (const log of Array.isArray(logs) ? logs : []) {
      const found = creditLog(log, { address, amountOf, from, to, topics, wei });

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

  return { complete: from > head, covered, credits, next: from };
}

/**
 * One group of equal transfers followed to their credits in a chain's logs:
 * from where the last search for the same logs stopped when it began no
 * later than the group's first transfer, else from the block the first was
 * sent at (as the app saw the chain's head then), else from about when it
 * was sent.
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
  const resumed = live.flatMap((item) => (item.scan && item.scan.search === search && item.scan.basis <= first.at ? [item.scan] : []));
  /** @type {Map<string, Credit>} */
  const carried = new Map();

  // The credits found before where an earlier search stopped: every one
  // counts again, as the transfer it paid may be among the queue's.
  for (const scan of resumed) {
    for (const credit of scan.seen ?? []) {
      if (credit.at >= reach) carried.set(credit.hash, { at: credit.at, block: BigInt(credit.block), from: credit.sender, hash: credit.hash, success: true, wei: filter.wei });
    }
  }

  /** @type {bigint} */
  let head;
  /** @type {bigint} */
  let start;

  if (resumed.length) {
    start = minOf(resumed.map((scan) => BigInt(scan.from)));
    head = await headOf(read, url);
  } else if (first.notBefore !== null) {
    start = first.notBefore;
    head = await headOf(read, url);
  } else {
    ({ head, start } = await startBefore(read, url, reach, blockTimes));
  }

  // Where the credits can't be told apart, only those in the transfers'
  // windows count: once they're all over, read no further than the last.
  const last = queue[queue.length - 1].at + windowMs;
  const { complete, covered, credits, next } = await searchLogs(read, {
    ...filter,
    blockTimes,
    // Once every transfer of the queue has its credit: read no further.
    enough: (found) => !guarded && settle(queue, found, rules).assigned.size === queue.length,
    head,
    known: [...carried.values()],
    maxWindows,
    start,
    until: guarded && now >= last ? last : null,
    url,
  });
  const seen = complete || covered;
  const { assigned, verdicts } = settle(queue, credits, rules);
  /** @type {Set<string>} */
  const arrived = new Set();

  for (const item of live) {
    const credit = assigned.get(item.hash);

    if (credit && verdicts.get(item.hash) === "arrived" && (seen || !guarded)) arrived.add(credit.hash);
  }

  // The next search carries on from where this one stopped, with the
  // credits found so far: a transfer that arrived may come back from the
  // chain among those before the next one, and takes its own again.
  /** @type {Scan} */
  const scan = {
    basis: first.at,
    from: next.toString(),
    search,
    seen: credits.flatMap((credit) => (credit.at >= reach && credit.block !== null ? [{ at: credit.at, block: credit.block.toString(), hash: credit.hash, sender: credit.from }] : [])),
  };

  for (const item of live) {
    const credit = assigned.get(item.hash);
    const verdict = verdicts.get(item.hash);

    if (credit && arrived.has(credit.hash)) {
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
 * A sender's deposits to DuskEVM between two heights, from its history and
 * their calls: amount, DuskEVM address and time, but those `skip` names,
 * which are looked for. Only those of at least `least` lux are read: what
 * an account paid the bridge is its deposit and any gas refund it paid
 * another account. Those whose call or time the archive doesn't give are
 * `unresolved`: they could be any deposit of up to what they paid.
 *
 * @param {Archive} archive
 * @param {Network} net
 * @param {{ sender: string, from: number, to: number, least: bigint, skip: ReadonlySet<string> }} range
 * @param {{ requests: number }} counter
 */
async function senderDeposits(archive, net, { from, least, sender, skip, to }, counter) {
  const bridge = duskEvmContracts(net)?.bridge;
  const read = await historyRange(archive, { account: sender, direction: "out", from, pages: HISTORY_PAGES, to });

  counter.requests += read.requests;

  // A history cut short leaves its deposits' order unclear: nothing more is read.
  if (!read.complete) return { complete: false, deposits: [], unresolved: [] };

  const candidates = read.entries.filter((entry) => entry.counterparty === bridge && !skip.has(entry.hash) && entry.value >= least);
  const details = await detailsOf(archive, candidates.map((entry) => entry.hash), { args: true, network: net }, counter);
  /** @type {{ amount: bigint, at: number, hash: string, height: number, to: string }[]} */
  const deposits = [];
  /** @type {{ hash: string, height: number, value: bigint }[]} */
  const unresolved = [];

  for (const entry of candidates) {
    const found = details.get(entry.hash);
    const bridged = found?.bridge;

    // Failed, or a call that isn't a deposit: no DUSK left for DuskEVM.
    if (found?.success === false || bridged === null || (bridged && bridged.kind !== "deposit")) continue;

    const at = msOf(found?.timestamp);
    const amount = luxOf(bridged?.amount);
    const recipient = addressOf(bridged?.to);

    if (found && at !== null && amount !== null && recipient) deposits.push({ amount, at, hash: entry.hash, height: entry.blockHeight, to: recipient });
    else unresolved.push({ hash: entry.hash, height: entry.blockHeight, value: entry.value });
  }

  return { complete: true, deposits, unresolved };
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
  /** @type {Map<string, Awaited<ReturnType<typeof senderDeposits>> & { bottom: number, top: number, topAt: number }>} */
  const histories = new Map();

  // The senders' deposits shortly before theirs, one history read a sender:
  // the app's deposits no longer looked for among them.
  if (archive) {
    const reach = Math.ceil((3 * DEPOSIT_HORIZON_MS) / DUSK_BLOCK_MS);

    for (const [sender, items] of groupBy(
      live.filter((item) => item.sender !== null && item.height !== null),
      (item) => /** @type {string} */ (item.sender)
    )) {
      const heights = items.map((item) => /** @type {number} */ (item.height));
      const top = Math.max(...heights);
      const bottom = Math.max(0, Math.min(...heights) - reach);
      const least = items.reduce((a, item) => (item.amount < a ? item.amount : a), MAX_U64);

      try {
        const found = await senderDeposits(archive, net, { from: bottom, least, sender, skip: new Set(items.map((item) => item.hash)), to: top }, read.counter);
        const topAt = /** @type {number} */ (items.find((item) => item.height === top)?.at);

        histories.set(sender, { ...found, bottom, top, topAt });
      } catch (error) {
        for (const item of items) results.set(item.hash, { error: messageOf(error), reason: "error", state: "unknown" });
      }
    }
  }

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

  // The block each deposit given can't be credited before, the app's own.
  const bounds = new Map(list.map((item) => [item.hash, item.notBefore]));

  for (const { items, rivals } of [...known, ...unknown]) {
    const { amount, sender, to } = items[0];
    const history = sender === null ? undefined : histories.get(sender);
    const vouched = Boolean(history) && items.every((item) => item.height !== null);
    const given = items.map(queued).sort(byTime);
    const alike = vouched
      ? /** @type {NonNullable<typeof history>} */ (history).deposits
          .filter((deposit) => deposit.to === to && deposit.amount === amount)
          .map((deposit) => ({ at: deposit.at, given: false, hash: deposit.hash, notBefore: bounds.get(deposit.hash) ?? null, scan: null }))
      : [];
    const queue = vouched
      ? queueOf(given, alike, DEPOSIT_HORIZON_MS)
      : withPast(
          given,
          past.filter((item) => item.to === to && item.amount === amount && item.sender === sender).map(queued),
          windowMs
        );
    /** @type {Set<string>} */
    const unsure = new Set();

    // An equal deposit just under the history read could come first, and so
    // could one before it whose call can't be read: the credits' order
    // can't be told.
    if (history && vouched) {
      const bottomAt = history.bottom === 0 ? -Infinity : history.topAt - (history.top - history.bottom) * DUSK_BLOCK_MS;

      for (const item of given) {
        const height = /** @type {number} */ (items.find((each) => each.hash === item.hash)?.height);

        if (
          !history.complete ||
          runStart(queue, item, DEPOSIT_HORIZON_MS).at - bottomAt < DEPOSIT_HORIZON_MS ||
          history.unresolved.some((peer) => peer.value >= amount && peer.height <= height)
        ) {
          unsure.add(item.hash);
        }
      }
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

      for (const [hash, arrival] of found) results.set(hash, arrival);
    } catch (error) {
      for (const item of items) results.set(item.hash, { error: messageOf(error), reason: "error", state: "unknown" });
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
  /** @type {Map<string, { complete: boolean, entries: HistoryEntry[], bottom: number, top: number, topAt: number, horizonMs: number }>} */
  const histories = new Map();

  // Each route's account's history, back from its transfers: every transfer
  // that named the same address, in any case, and could be paid before.
  for (const [id, items] of groupBy(live, (item) => item.route.id)) {
    const { route } = items[0];
    const horizonMs = horizonOf(route);
    const heights = items.map((item) => item.height);
    const top = Math.max(...heights);
    const bottom = Math.max(0, Math.min(...heights) - Math.ceil((3 * horizonMs) / DUSK_BLOCK_MS));

    try {
      const range = await historyRange(archive, { account: route.account, direction: "in", from: bottom, pages: HISTORY_PAGES, to: top });

      read.counter.requests += range.requests;
      histories.set(id, { bottom, complete: range.complete, entries: range.entries, horizonMs, top, topAt: /** @type {SentItem} */ (items.find((item) => item.height === top)).at });
    } catch (error) {
      for (const item of items) results.set(item.hash, failed(error));
    }
  }

  const groups = [...groupBy(live.filter((item) => histories.has(item.route.id)), (item) => `${item.route.id}:${item.to}:${item.net}`).values()];
  const polled = new Set(groups.flat().map((item) => item.hash));
  // The fee of each transfer the app gave, those no longer looked for too,
  // and the block its payout can't be before.
  const feeOf = new Map(routed.map((item) => [item.hash, item.fee ?? /** @type {Route & { kind: "service" }} */ (item.route).feeLux]));
  const bounds = new Map(routed.map((item) => [item.hash, item.notBefore]));
  // Each group's others: what the account received, at least as much as the
  // group's transfers, naming the same address, and the app's transfers no
  // longer looked for. What each paid whom, its memo and its time come from
  // its own transaction.
  const others = groups.map((items) => {
    const { route, to } = items[0];
    const least = items.reduce((a, item) => (item.net + item.fee < a ? item.net + item.fee : a), MAX_U64);

    return (/** @type {NonNullable<ReturnType<typeof histories.get>>} */ (histories.get(route.id)).entries).filter(
      (entry) => !polled.has(entry.hash) && entry.kind === "transfer" && entry.direction === "in" && entry.memo.toLowerCase() === to && (entry.value >= least || feeOf.has(entry.hash))
    );
  });
  /** @type {Map<string, TransferFacts>} */
  let peers;

  try {
    peers = new Map([...sent, ...(await transfersOf(archive, others.flat().flatMap((entry) => (sent.has(entry.hash) ? [] : [entry.hash])), read.counter))]);
  } catch (error) {
    for (const items of groups) for (const item of items) results.set(item.hash, failed(error));

    return done();
  }

  for (const [i, items] of groups.entries()) {
    const { net: payout, route, to } = items[0];
    const history = /** @type {NonNullable<ReturnType<typeof histories.get>>} */ (histories.get(route.id));
    const fees = new Set(items.map((item) => item.fee));
    /** @type {Queued[]} */
    const alike = [];
    // The heights of transfers to the same address that can't be read.
    /** @type {number[]} */
    const unread = [];

    for (const entry of others[i]) {
      const facts = peers.get(entry.hash);

      if (!facts || facts.kind === null || facts.at === null || (facts.kind === "moonlight" && (facts.value === null || facts.receiver === null))) {
        unread.push(entry.blockHeight);
      } else if (!facts.failed && facts.kind === "moonlight" && facts.receiver === route.account && facts.memo.toLowerCase() === to) {
        const value = /** @type {bigint} */ (facts.value);
        // One the app gave pays out what its own fee leaves; one it didn't,
        // what the group's do.
        const own = feeOf.get(entry.hash);

        if (own === undefined ? [...fees].some((fee) => value - fee === payout) : value - own === payout) {
          alike.push({ at: facts.at, given: false, hash: entry.hash, notBefore: bounds.get(entry.hash) ?? null, scan: null });
        }
      }
    }

    const given = items.map(queued).sort(byTime);
    const queue = queueOf(given, alike, history.horizonMs);
    const bottomAt = history.bottom === 0 ? -Infinity : history.topAt - (history.top - history.bottom) * DUSK_BLOCK_MS;
    /** @type {Set<string>} */
    const unsure = new Set();

    // A history cut short, an equal transfer just under it, or one before
    // that can't be read: the payouts' order can't be told.
    for (const item of given) {
      const height = /** @type {SentItem} */ (items.find((each) => each.hash === item.hash)).height;

      if (!history.complete || runStart(queue, item, history.horizonMs).at - bottomAt < history.horizonMs || unread.some((each) => each <= height)) unsure.add(item.hash);
    }

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
          queue,
          unsure,
        },
        { blockTimes, maxWindows, now, slackMs: CLOCK_SLACK_MS, url: String(rpcUrl ?? route.chain.rpcUrl), used, windowMs: CREDIT_WINDOW_MS }
      );

      for (const [hash, arrival] of found) results.set(hash, arrival);
    } catch (error) {
      for (const item of items) results.set(item.hash, failed(error));
    }
  }

  return done();
}

// ---------------------------------------------------------------------------
// Migrations into Dusk
// ---------------------------------------------------------------------------

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
    const route = data && event.reverted !== true && event.topic === "moonlight" && String(event.target ?? "").toLowerCase() === TRANSFER_CONTRACT && data.receiver === account && typeof data.sender === "string" ? routeForAccount(net, data.sender, "in") : null;
    const memo = memoOf(data?.memo).trim().toLowerCase();
    const amount = luxOf(data?.value);

    return route?.kind === "migration" && route.payoutAccount && EVM_HASH.test(memo) && amount !== null
      ? [{ amount, at: null, block, hash: /** @type {`0x${string}`} */ (memo), payout, route: route.id }]
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
  // amount it paid, on the route whose payout account paid it.
  const byBlock = [...candidates].sort((a, b) => a.block - b.block || (a.payout < b.payout ? -1 : 1));

  for (const item of [...payable].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))) {
    if (results.has(item.hash)) continue;

    const named = byBlock.filter((each) => !used.has(each.payout) && each.hash === item.hash && each.route === item.route?.id);
    const payout = named.find((each) => each.amount === item.amount);

    if (payout) {
      used.add(payout.payout);
      results.set(item.hash, { amount: payout.amount, at: payout.at, block: payout.block, hash: payout.payout, state: "arrived" });
    } else if (named.length) {
      // Its payout, of another amount: an entry's value holds a gas refund
      // paid to the account, which it doesn't tell apart, or another amount
      // was paid. Not waiting: unsure.
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
  const route = entry?.kind === "transfer" && entry.direction === "in" && typeof entry.counterparty === "string" ? routeForAccount(net, entry.counterparty, "in") : null;
  const { at, hash, height, value } = factsOf(entry);
  const memo = String(entry?.memo ?? "")
    .trim()
    .toLowerCase();

  if (!route || route.kind !== "migration" || !route.payoutAccount || entry.success === false || !hash || height === null || value === null || !EVM_HASH.test(memo)) {
    return null;
  }

  return { amount: value, at, block: height, hash: /** @type {`0x${string}`} */ (memo), payout: hash, route: route.id };
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
