/**
 * How a bridge route is doing before someone sends: whether it's paying out,
 * its last payout, and what it can pay, as far as the chains say, read once and
 * kept. Not an entry point.
 *
 * @module
 */

import { routes } from "@dusk-network/networks";

import { ETH_BRIDGE_FINALIZED_TOPIC, EVM_ADDRESS, EVM_HASH, RANGE_REFUSED, TIMEOUT_MS, TRANSFER_TOPIC, WEI_PER_LUX, messageOf, networkOf, quantityOf, reader, urlOf } from "./bridge-common.js";
import { createArchive, fetchTxDetails, parseHistoryEntry } from "./history.js";

/** @typedef {import("./bridge.js").BridgeNetwork} BridgeNetwork */
/** @typedef {import("./bridge.js").BridgeStatus} BridgeStatus */
/** @typedef {import("./bridge.js").BridgeStatusOptions} BridgeStatusOptions */
/** @typedef {import("./bridge.js").FactCache} FactCache */
/** @typedef {import("./history.js").Archive} Archive */
/** @typedef {import("./history.js").HistoryEntry} HistoryEntry */
/** @typedef {import("./bridge-common.js").Reader} Reader */
/** @typedef {import("@dusk-network/networks").Network} Network */
/** @typedef {import("@dusk-network/networks").Route} Route */

/** How long a status is kept before it's read again: 10 minutes. */
export const STATUS_MAX_AGE_MS = 10 * 60_000;

/** A Dusk block every 10 seconds: a day, a week and 30 days of them, newest first. */
const DUSK_WINDOWS = Object.freeze([8_640, 60_480, 259_200]);
/** Each of an account's lists is read so far at most, before its newest is taken as near enough. */
const PAGE = 50;
const MAX_PAGES = 3;
/** Log searches one read makes, and the blocks each covers, as public RPCs take. */
const LOG_WINDOWS = 8;
const LOG_SIZE = 50_000n;
/** A payout older than this isn't looked for. */
const LOOK_BACK_MS = 30 * 86_400_000;
const MIN_LOG_SIZE = 50n;
/** How long after its usual time a transfer in is overdue, without one: a day. */
const NO_USUAL_MS = 86_400_000;
const WEEK_MS = 7 * 86_400_000;

/** @param {bigint} n */
const hex = (n) => `0x${n.toString(16)}`;

/** @param {string} address */
const topicOf = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/**
 * @typedef {{ at: number | null, hash: string, amount: bigint, block: number | null }} Payout
 * @typedef {{ from: bigint, to: bigint, size: bigint, last: Payout | null }} LogScan
 */

// ---------------------------------------------------------------------------
// On Dusk
// ---------------------------------------------------------------------------

/**
 * The newest entries of an account's history that `isOne` says are the ones
 * asked for, as far back as 30 days, newest first: one request for its three
 * windows, and further pages of the first that has any, where it's fuller.
 *
 * @param {Archive} archive
 * @param {{ account: string, side: "sender" | "receiver", finalized: number, isOne: (entry: HistoryEntry) => boolean }} ask
 * @returns {Promise<HistoryEntry[]>}
 */
async function newestOn(archive, { account, finalized, isOne, side }) {
  /** @param {number} blocks @param {number} page */
  const field = (blocks, page) => `${side}: ${JSON.stringify(account)}, fromBlock: ${Math.max(0, finalized - blocks)}, maxCount: ${PAGE}${page > 1 ? `, pageCount: ${page}` : ""}`;
  const data = await archive.query(`query { ${DUSK_WINDOWS.map((blocks, i) => `w${i}: moonlightHistory(${field(blocks, 1)}) { json }`).join(" ")} }`);
  /** @param {any} list */
  const entriesOf = (list) => (Array.isArray(list) ? list : []).flatMap((raw) => parseHistoryEntry(account, raw) ?? []).filter(isOne);

  for (const [i, blocks] of DUSK_WINDOWS.entries()) {
    const first = data?.[`w${i}`]?.json;
    let found = entriesOf(first);

    if (!found.length && !(Array.isArray(first) && first.length >= PAGE)) continue;

    let last = first;

    for (let page = 2; page <= MAX_PAGES && Array.isArray(last) && last.length >= PAGE; page += 1) {
      last = (await archive.query(`query { w: moonlightHistory(${field(blocks, page)}) { json } }`))?.w?.json;
      found = [...found, ...entriesOf(last)];
    }

    if (found.length) return found.reverse();
  }

  return [];
}

/**
 * The newest of the entries that went through, with its time.
 *
 * @param {Archive} archive
 * @param {HistoryEntry[]} entries
 * @returns {Promise<Payout | null>}
 */
async function newestThatWent(archive, entries) {
  const asked = entries.slice(0, 5);

  if (!asked.length) return null;

  const details = await fetchTxDetails(archive, asked.map((entry) => entry.hash));

  for (const entry of asked) {
    const known = details.get(entry.hash);

    if (known?.success !== false) return { amount: entry.value, at: known?.timestamp ?? null, block: entry.blockHeight, hash: entry.hash };
  }

  return null;
}

/**
 * The block the archive says is final.
 *
 * @param {Archive} archive
 * @returns {Promise<number>}
 */
async function finalizedOf(archive) {
  const height = Number((await archive.query("query { pair: lastBlockPair { json } }"))?.pair?.json?.last_finalized_block?.[0]);

  if (!Number.isSafeInteger(height) || height < 0) throw new Error("The node gave no final block");

  return height;
}

/**
 * A public account's balance, in lux, as the node writes it: it can be past
 * 2^53, so it's read from the text.
 *
 * @param {Reader} read
 * @param {string} nodeUrl
 * @param {string} account
 * @returns {Promise<bigint>}
 */
async function accountBalance(read, nodeUrl, account) {
  const match = /"balance"\s*:\s*"?(\d+)/.exec(await read.postText(`${nodeUrl}/on/account:${account}/status`));

  if (!match) throw new Error("The node gave no balance");

  return BigInt(match[1]);
}

/**
 * What a contract holds on Dusk, in lux: the transfer contract's
 * `contract_balance`, a u64.
 *
 * @param {Reader} read
 * @param {string} nodeUrl
 * @param {string} transfer
 * @param {string} contractId
 * @returns {Promise<bigint>}
 */
async function contractBalance(read, nodeUrl, transfer, contractId) {
  const reply = await read.postBytes(`${nodeUrl}/on/contracts:${transfer}/contract_balance`, Uint8Array.from(contractId.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16)).buffer);

  if (reply.length !== 8) throw new Error("A contract's balance is 8 bytes");

  return new DataView(reply.buffer, reply.byteOffset, 8).getBigUint64(0, true);
}

// ---------------------------------------------------------------------------
// On the other chain
// ---------------------------------------------------------------------------

/**
 * A log's payment: the first word of its data. Nothing paid is no payment, as
 * anyone's transaction can write a Transfer of nothing from any address.
 *
 * @param {any} log
 * @param {{ address: string, topics: ReadonlyArray<string> }} ask
 * @returns {Payout | null}
 */
function paymentOf(log, { address, topics }) {
  const got = Array.isArray(log?.topics) ? log.topics.map(String).map((/** @type {string} */ topic) => topic.toLowerCase()) : [];
  const data = String(log?.data ?? "");

  if (!log || log.removed === true || String(log.address ?? "").toLowerCase() !== address || topics.some((topic, i) => got[i] !== topic) || !/^0x[0-9a-fA-F]{64,}$/.test(data)) return null;

  const wei = BigInt(data.slice(0, 66));
  const hash = String(log.transactionHash ?? "").toLowerCase();
  const block = quantityOf(log.blockNumber);

  if (wei === 0n || !EVM_HASH.test(hash) || block === null) return null;

  const seconds = quantityOf(log.blockTimestamp);

  return { amount: wei / WEI_PER_LUX, at: seconds === null ? null : Number(seconds) * 1000, block: Number(block), hash };
}

/**
 * The newest payment asked for, from the newest blocks down: those above what
 * was read before first, then, while none is known, below it (`further`),
 * `LOG_WINDOWS` searches at most. A read long after the last one starts afresh,
 * so as not to leave a stretch unread.
 *
 * @param {Reader} read
 * @param {{ url: string, address: string, topics: ReadonlyArray<string>, kept: LogScan | null, further: boolean }} ask
 * @returns {Promise<LogScan & { head: bigint }>}
 */
async function newestPayment(read, { address, further, kept, topics, url }) {
  const head = quantityOf(await read.rpc(url, "eth_blockNumber", []));

  if (head === null) throw new Error("The chain gave no head");

  const known = kept && kept.to <= head && head - kept.to <= BigInt(LOG_WINDOWS) * kept.size ? kept : null;
  let size = known?.size ?? LOG_SIZE;
  let left = LOG_WINDOWS;
  let last = known?.last ?? null;
  // The lowest block read, and the search's place: above what was read, if
  // anything was, then below.
  let low = known ? known.from : head + 1n;
  let to = head;
  let floor = known ? known.to + 1n : 0n;
  let above = Boolean(known);

  while (left > 0) {
    if (to < floor) {
      if (!above || last || !further || !known || known.from === 0n) break;

      above = false;
      to = known.from - 1n;
      floor = 0n;
      continue;
    }

    const from = to - size + 1n > floor ? to - size + 1n : floor;
    /** @type {any} */
    let logs;

    left -= 1;

    try {
      logs = await read.rpc(url, "eth_getLogs", [{ address, fromBlock: hex(from), toBlock: hex(to), topics }]);
    } catch (error) {
      if (size > MIN_LOG_SIZE && RANGE_REFUSED.test(messageOf(error))) {
        size = size / 4n > MIN_LOG_SIZE ? size / 4n : MIN_LOG_SIZE;
        continue;
      }

      throw error;
    }

    if (above && from > floor && left === 0) low = from;
    else if (from < low) low = from;

    const found = (Array.isArray(logs) ? logs : []).flatMap((log) => paymentOf(log, { address, topics }) ?? []);

    if (found.length) {
      last = found.reduce((newest, each) => (/** @type {number} */ (each.block) >= /** @type {number} */ (newest.block) ? each : newest));
      break;
    }

    if (from === 0n) break;

    to = from - 1n;
  }

  return { from: low, head, last, size, to: head };
}

/**
 * A block's time, in milliseconds.
 *
 * @param {Reader} read
 * @param {string} url
 * @param {bigint} block
 * @returns {Promise<number | null>}
 */
async function timeOfBlock(read, url, block) {
  const seconds = quantityOf((await read.rpc(url, "eth_getBlockByNumber", [hex(block), false]))?.timestamp);

  return seconds === null ? null : Number(seconds) * 1000;
}

/**
 * The newest payout on the other chain, with its time and how far back it's
 * been looked for, where none was found.
 *
 * @param {Reader} read
 * @param {{ url: string, address: string, topics: ReadonlyArray<string>, kept: LogScan | null, further: boolean }} ask
 */
async function payoutOnChain(read, ask) {
  const scan = await newestPayment(read, ask);
  const { last } = scan;

  if (last && last.at === null && last.block !== null) last.at = await timeOfBlock(read, ask.url, BigInt(last.block));

  return { last, scan, since: last ? null : await timeOfBlock(read, ask.url, scan.from > scan.head ? scan.head : scan.from) };
}

// ---------------------------------------------------------------------------
// Kept
// ---------------------------------------------------------------------------

/** @param {any} value */
const written = (value) => JSON.stringify(value, (_, each) => (typeof each === "bigint" ? `${each}n` : each));

/** @param {string} text */
const readBack = (text) => JSON.parse(text, (_, each) => (typeof each === "string" && /^\d+n$/.test(each) ? BigInt(each.slice(0, -1)) : each));

/** Reads under way, by cache, so two at once make one. @type {WeakMap<object, Map<string, Promise<any>>>} */
const underWay = new WeakMap();

// ---------------------------------------------------------------------------
// The status
// ---------------------------------------------------------------------------

/**
 * @param {Route} route
 * @param {Network} net
 * @param {{ archive: () => Archive, read: Reader, nodeUrl: () => string, rpcUrl: string | undefined, kept: { scan?: LogScan | null, status?: { readSince?: number | null } | null } | null, now: number }} context
 * @returns {Promise<{ status: Partial<BridgeStatus>, scan: LogScan | null }>}
 */
async function readRoute(route, net, { archive, kept, nodeUrl, now, read, rpcUrl }) {
  /** @type {string[]} */
  const errors = [];
  /**
   * @template T
   * @param {() => Promise<T>} part
   * @returns {Promise<T | null>}
   */
  const tryTo = async (part) => {
    try {
      return await part();
    } catch (error) {
      errors.push(messageOf(error));

      return null;
    }
  };
  /** @type {Payout | null} */
  let lastPayout = null;
  /** @type {number | null} */
  let since = null;
  /** @type {bigint | null} */
  let canPay = null;
  /** @type {BridgeStatus["gas"]} */
  let gas = null;
  /** @type {number | null} */
  let waitingSince = null;
  /** @type {LogScan | null} */
  let scan = kept?.scan ?? null;
  /** @type {"balance" | "mints"} */
  let limit = "mints";
  const typicalMs = (route.typicalSeconds ?? 0) * 1000;
  const further = !(kept?.status?.readSince && now - kept.status.readSince > LOOK_BACK_MS);

  if (route.kind === "migration") {
    limit = "balance";

    if (route.payoutAccount) {
      const account = route.payoutAccount;
      const finalized = await tryTo(() => finalizedOf(archive()));

      if (finalized !== null) {
        const found = await tryTo(async () =>
          newestThatWent(archive(), await newestOn(archive(), { account, finalized, isOne: (entry) => entry.direction === "out" && entry.value > 0n && entry.memoBinary !== true && EVM_HASH.test(entry.memo.trim().toLowerCase()), side: "sender" }))
        );

        if (found !== null || !errors.length) since = found ? null : now - DUSK_WINDOWS[DUSK_WINDOWS.length - 1] * 10_000;
        lastPayout = found;
      }

      canPay = await tryTo(() => accountBalance(read, nodeUrl(), account));
    }
  } else if (route.kind === "service") {
    const url = urlOf(rpcUrl, route.chain.rpcUrl, "RPC");

    if (route.payoutAddress && route.chain.token) {
      const payoutAddress = route.payoutAddress;
      const token = route.chain.token;
      const onChain = await tryTo(() => payoutOnChain(read, { address: token.toLowerCase(), further, kept: scan, topics: [TRANSFER_TOPIC, topicOf(payoutAddress)], url }));

      if (onChain) {
        lastPayout = onChain.last;
        scan = onChain.scan;
        since = onChain.since;
      }

      const wei = await tryTo(async () => quantityOf(await read.rpc(url, "eth_getBalance", [payoutAddress, "latest"])));

      gas = wei === null ? null : { coin: route.chain.currency.symbol, wei };

      const finalized = await tryTo(() => finalizedOf(archive()));
      const newest =
        finalized === null
          ? null
          : await tryTo(async () =>
              newestThatWent(archive(), await newestOn(archive(), { account: route.account, finalized, isOne: (entry) => entry.direction === "in" && entry.value > route.feeLux && entry.memoBinary !== true && EVM_ADDRESS.test(entry.memo), side: "receiver" }))
            );

      if (newest?.at && (!lastPayout?.at || lastPayout.at < newest.at)) waitingSince = newest.at;
    }
  } else if (route.kind === "duskevm-deposit") {
    const url = urlOf(rpcUrl, route.chain.rpcUrl, "RPC");
    const bridge = net.duskEvm?.predeploys.l2StandardBridge;

    if (bridge) {
      const onChain = await tryTo(() => payoutOnChain(read, { address: bridge.toLowerCase(), further, kept: scan, topics: [ETH_BRIDGE_FINALIZED_TOPIC], url }));

      if (onChain) {
        lastPayout = onChain.last;
        scan = onChain.scan;
        since = onChain.since;
      }
    }
  } else {
    limit = "balance";

    const bridge = net.duskEvm?.contracts?.l1_standard_bridge?.contractId;
    const transfer = net.contracts?.transfer;

    if (bridge && transfer) canPay = await tryTo(() => contractBalance(read, nodeUrl(), transfer, bridge));
  }

  const overdueAfter = typicalMs > 0 ? 2 * typicalMs : NO_USUAL_MS;
  const overdue = waitingSince !== null && now - waitingSince > overdueAfter && (lastPayout !== null || (since !== null && since <= waitingSince));
  const recent = lastPayout?.at && now - lastPayout.at <= Math.max(WEEK_MS, 4 * typicalMs);
  const paying = route.kind === "duskevm-withdrawal" ? "on-claim" : overdue ? "late" : recent ? "yes" : lastPayout || since !== null ? "quiet" : "unknown";

  return {
    scan,
    status: {
      canPay,
      error: errors[0] ?? "",
      gas,
      lastPayout: lastPayout && { amount: lastPayout.amount, at: lastPayout.at, block: lastPayout.block, hash: lastPayout.hash },
      limit,
      paying,
      readSince: since,
      waitingSince,
    },
  };
}

/**
 * @param {BridgeStatusOptions} options
 * @returns {Promise<BridgeStatus>}
 */
export async function bridgeStatus({ archive, cache, fetch: fetchFn, maxAgeMs = STATUS_MAX_AGE_MS, network, nodeUrl, now = Date.now(), route, rpcUrl, timeoutMs = TIMEOUT_MS }) {
  const net = networkOf(network);
  const chosen = routes(net).find((each) => each.id === route);

  if (!chosen) throw new TypeError("That route isn't one of the network's");

  const key = `bridge-status:${net.chainId}:${chosen.id}`;
  /** @type {{ at: number, status: BridgeStatus | null, scan?: LogScan | null } | null} */
  let kept = null;

  try {
    kept = cache?.get(key) ? readBack(String(cache.get(key))) : null;
  } catch {
    kept = null;
  }

  if (kept?.status && now - kept.at >= 0 && now - kept.at < maxAgeMs) return { ...kept.status, requests: 0 };

  const under = cache ? underWay.get(cache)?.get(key) : undefined;

  if (under) return under;

  const read = reader(fetchFn, timeoutMs);
  const answer = (async () => {
    const base = { readAt: now, route: chosen.id, running: chosen.running };

    if (!chosen.running) {
      return /** @type {BridgeStatus} */ ({ ...base, canPay: null, error: "", gas: null, lastPayout: null, limit: chosen.kind === "migration" || chosen.kind === "duskevm-withdrawal" ? "balance" : "mints", paying: "stopped", readSince: null, requests: 0, waitingSince: null });
    }

    const node = () => urlOf(nodeUrl, /** @type {any} */ (net).urls?.node, "node");
    /** @type {Archive | undefined} */
    let own;
    // Each of its requests counted with the others.
    const counted = () => {
      if (!own) {
        const asked = archive ?? createArchive({ fetch: fetchFn, timeoutMs, url: node() });

        own = { ...asked, query: (...args) => ((read.counter.requests += 1), asked.query(...args)) };
      }

      return own;
    };
    const { scan, status } = await readRoute(chosen, net, { archive: counted, kept, nodeUrl: node, now, read, rpcUrl });
    const whole = /** @type {BridgeStatus} */ ({ ...base, ...status, requests: read.counter.requests });

    // A read that failed is made again next time; where a search got to stays.
    if (cache) cache.set(key, written(whole.error ? { at: 0, scan, status: kept?.status ?? null } : { at: now, scan, status: whole }));

    return whole;
  })();

  if (cache) {
    const reads = underWay.get(cache) ?? new Map();

    underWay.set(cache, reads);
    reads.set(key, answer);

    try {
      return await answer;
    } finally {
      reads.delete(key);
    }
  }

  return answer;
}
