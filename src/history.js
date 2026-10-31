/* @ts-self-types="./history.d.ts" */
/**
 * A public account's history from the Dusk archive, synced by block height.
 * The app passes its own fetch (or GraphQL caller), the archive's URL and a
 * store; nothing here keeps state outside the objects its factories make.
 *
 * @module
 */

import { networkFor, networks, routeForAccount } from "@dusk-network/networks";
import { isAccount } from "@dusk-network/networks/account";
import { decodeBridgeCall, isBridgeContract } from "@dusk-network/networks/duskevm";
import { isSozuCall } from "@dusk-network/networks/sozu";

/** @typedef {import("./history.js").Archive} Archive */
/** @typedef {import("./history.js").ArchiveOptions} ArchiveOptions */
/** @typedef {import("./history.js").BridgeFacts} BridgeFacts */
/** @typedef {import("./history.js").CallFacts} CallFacts */
/** @typedef {import("./history.js").DetailsOptions} DetailsOptions */
/** @typedef {import("./history.js").Direction} Direction */
/** @typedef {import("./history.js").EntryDetails} EntryDetails */
/** @typedef {import("./history.js").EntryKind} EntryKind */
/** @typedef {import("./history.js").History} History */
/** @typedef {import("./history.js").HistoryEntry} HistoryEntry */
/** @typedef {import("./history.js").HistoryOptions} HistoryOptions */
/** @typedef {import("./history.js").HistoryState} HistoryState */
/** @typedef {import("./history.js").KeptEntry} KeptEntry */
/** @typedef {import("./history.js").RangeOptions} RangeOptions */
/** @typedef {import("./history.js").ReadEntry} ReadEntry */
/** @typedef {import("./history.js").RefusalStore} RefusalStore */
/** @typedef {import("@dusk-network/networks").Network} Network */
/** @typedef {import("@dusk-network/networks").NetworkRef} NetworkRef */

export const PAGE = 50;
export const FIRST_WINDOW = 8_640;
export const FINALITY_MARGIN = 10;
export const DETAILS_BATCH = 50;
/** How many pages of kept entries a sync looks through for ones that need details. */
const PENDING_PAGES = 20;
export const RUN_REQUESTS = 8;
export const RUN_DETAIL_REQUESTS = 2;
export const NO_ARCHIVE_RETRY_MS = 60 * 60_000;

export const { stake: STAKE_CONTRACT, transfer: TRANSFER_CONTRACT } = networks.mainnet.contracts;

export const ENTRY_KIND = Object.freeze({
  TRANSFER: "transfer",
  SHIELD: "shield",
  UNSHIELD: "unshield",
  CONTRACT_CALL: "contract_call",
  STAKE: "stake",
  UNSTAKE: "unstake",
  WITHDRAW_REWARD: "withdraw_reward",
});

const TIMEOUT_MS = 8_000;
// Answers a request is sent again for, a quarter second, then half a second later.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const ATTEMPTS = 3;
const RETRY_MS = 250;
// What a node without the archive answers: its GraphQL has no history fields.
const NO_ARCHIVE = /Unknown field\W+(?:moonlightHistory|contractEvents)\b/i;
const MAX_WINDOW = 2 ** 40;
const MAX_U64 = (1n << 64n) - 1n;
const HASH = /^[0-9a-f]{64}$/;
const LUX_IN_WEI = 1_000_000_000n;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * A u64 from a number or its text: 0n for anything else.
 *
 * @param {unknown} value
 * @returns {bigint}
 */
function u64(value) {
  const text = String(value ?? "").trim();

  if (!/^\d+$/.test(text)) return 0n;

  const n = BigInt(text);

  return n <= MAX_U64 ? n : 0n;
}

// A JSON string, or a whole JSON number: outside strings, only numbers have digits.
const TOKEN = /("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/**
 * JSON.parse, with the integers past 2^53 kept exact, as their text: the
 * node writes u64 amounts as bare numbers.
 *
 * @param {string} text
 * @returns {any}
 */
function parseJsonExact(text) {
  return JSON.parse(
    String(text).replace(TOKEN, (match, string) =>
      string ?? (/^-?\d+$/.test(match) && !Number.isSafeInteger(Number(match)) ? `"${match}"` : match)
    )
  );
}

/**
 * The network a reference names, or null for none, or one there's no file for.
 *
 * @param {NetworkRef | null | undefined} network
 * @returns {Network | null}
 */
function networkOf(network) {
  if (network === null || network === undefined) return null;
  if (typeof network === "object") return network;

  return networkFor(network);
}

/**
 * @param {unknown} url
 * @returns {string}
 */
function originOf(url) {
  try {
    return new URL(String(url ?? "").trim()).origin;
  } catch {
    return "";
  }
}

/**
 * The chain ID of the network whose file lists `url` as its node or its
 * archive, by origin, or null.
 *
 * @param {string} url
 * @returns {number | null}
 */
function listedChainId(url) {
  const origin = originOf(url);
  const net = origin
    ? Object.values(networks).find((n) => [n.urls.node, n.urls.archive].some((u) => originOf(u) === origin))
    : undefined;

  return net ? net.chainId : null;
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

export class NoArchiveError extends Error {
  /**
   * @param {string} url
   * @param {string} [message]
   */
  constructor(url, message = `${url} has no archive`) {
    super(message);
    this.name = "NoArchiveError";
    /** @type {string} */
    this.url = url;
  }
}

export class StaleHistoryError extends Error {
  constructor() {
    super("Another run started this history over, or it was cleared, since this run began");
    this.name = "StaleHistoryError";
  }
}

/**
 * @param {{ nodeUrl?: string, archiveUrl?: string, chainIdOf?: (url: string) => number | null | undefined }} urls
 * @returns {string}
 */
export function historyArchiveUrl({ nodeUrl, archiveUrl, chainIdOf = listedChainId } = {}) {
  const node = String(nodeUrl ?? "").trim();
  const archive = String(archiveUrl ?? "").trim();

  if (!archive) return node;

  /** @param {string} url */
  const chain = (url) => {
    const id = chainIdOf(url);

    return Number.isInteger(id) ? id : null;
  };
  const nodeChain = chain(node);
  const archiveChain = chain(archive);

  return nodeChain !== null && archiveChain !== null && nodeChain !== archiveChain ? node : archive;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = (error) => String(/** @type {any} */ (error)?.message ?? error ?? "");

/**
 * @param {ArchiveOptions} options
 * @returns {Archive}
 */
export function createArchive({ url, fetch: fetchFn, query: caller, refusals, timeoutMs = TIMEOUT_MS, now = Date.now }) {
  const name = String(url ?? "").trim();
  const base = name.replace(/\/+$/, "");

  if (!caller && !/^https?:\/\/[^/]/i.test(base)) {
    throw new TypeError("The archive's URL must be an http(s) URL");
  }

  const endpoint = `${base}/on/graphql/query`;
  /** @type {Map<string, number>} */
  const remembered = new Map();
  /** @type {RefusalStore} */
  const kept = refusals ?? {
    get: (key) => remembered.get(key) ?? null,
    put: (key, at) => {
      remembered.set(key, at);
    },
  };

  /**
   * One exchange, within the time allowed for it, its body read too.
   *
   * @param {string} text
   * @param {number} ms
   */
  async function exchange(text, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    try {
      const send = fetchFn ?? globalThis.fetch;
      const response = await send(endpoint, {
        body: text,
        headers: { "Content-Type": "text/plain" },
        method: "POST",
        signal: controller.signal,
      });

      return { ok: response.ok, status: response.status, text: await response.text() };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`The archive didn't answer within ${Math.round(ms / 100) / 10} s`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {string} text
   * @param {number} ms
   * @returns {Promise<any>}
   */
  async function post(text, ms) {
    let answer = await exchange(text, ms);

    for (let attempt = 1; attempt < ATTEMPTS && !answer.ok && RETRY_STATUSES.has(answer.status); attempt += 1) {
      await sleep(RETRY_MS * 2 ** (attempt - 1));
      answer = await exchange(text, ms);
    }

    /** @type {any} */
    let body;

    try {
      body = parseJsonExact(answer.text);
    } catch {
      throw new Error(answer.ok ? "The archive's answer isn't JSON" : `The archive answers with HTTP ${answer.status}`);
    }

    // GraphQL errors first: a node without the archive may answer them with an error status.
    const errors = Array.isArray(body) ? body : body?.errors;

    if (Array.isArray(errors) && errors.length) {
      throw new Error(errors.map((e) => e?.message || String(e)).join("; "));
    }

    if (!answer.ok) throw new Error(`The archive answers with HTTP ${answer.status}`);

    return body?.data && typeof body.data === "object" ? body.data : (body ?? {});
  }

  return Object.freeze({
    url: name,

    /**
     * @param {string} text
     * @param {{ timeoutMs?: number }} [options]
     */
    async query(text, { timeoutMs: ms = timeoutMs } = {}) {
      try {
        return caller ? ((await caller(String(text))) ?? {}) : await post(String(text), ms);
      } catch (error) {
        const message = messageOf(error);

        if (!(error instanceof NoArchiveError) && !NO_ARCHIVE.test(message)) throw error;

        try {
          await kept.put(name, now());
        } catch {
          // Not kept: the next run asks again.
        }

        throw error instanceof NoArchiveError ? error : new NoArchiveError(name, message);
      }
    },

    async assertArchive() {
      /** @type {unknown} */
      let at = null;

      try {
        at = await kept.get(name);
      } catch {
        at = null;
      }

      const since = now() - Number(at);

      if (typeof at === "number" && Number.isFinite(at) && since >= 0 && since < NO_ARCHIVE_RETRY_MS) {
        throw new NoArchiveError(name);
      }
    },
  });
}

/**
 * @param {any} field
 * @returns {any[]}
 */
const listOf = (field) => (Array.isArray(field?.json) ? field.json : []);

const HEAD_FIELDS = "pair: lastBlockPair { json } genesis: block(height: 0) { header { hash } }";
const HEAD_QUERY = `query { ${HEAD_FIELDS} }`;

/** The query alias and the archive's argument for each direction. */
const DIRECTIONS = Object.freeze({ in: "receiver", out: "sender" });

/**
 * @param {"in" | "out"} alias
 * @param {string} account
 * @param {{ from: number, to?: number, page: number }} range
 */
function historyField(alias, account, { from, to, page }) {
  const args = [`${DIRECTIONS[alias]}: ${JSON.stringify(account)}`, `fromBlock: ${from}`];

  if (to !== undefined) args.push(`toBlock: ${to}`);
  args.push(`maxCount: ${PAGE}`);
  if (page > 1) args.push(`pageCount: ${page}`);

  return `${alias}: moonlightHistory(${args.join(", ")}) { json }`;
}

/**
 * The range `[from, to]` of the directions asked, `to` open when undefined,
 * in one request; with `head`, the last finalized block and the genesis hash.
 *
 * @param {string} account
 * @param {{ from: number, to?: number, page?: number, head?: boolean, aliases?: ReadonlyArray<"in" | "out"> }} range
 */
function rangeQuery(account, { from, to, page = 1, head = false, aliases = ["out", "in"] }) {
  const fields = aliases.map((alias) => historyField(alias, account, { from, page, to }));

  return `query { ${[head ? HEAD_FIELDS : "", ...fields].filter(Boolean).join(" ")} }`;
}

/**
 * @param {any} data
 * @returns {{ finalized: number, tip: number, genesis: string }}
 */
function readHead(data) {
  const finalized = Number(data?.pair?.json?.last_finalized_block?.[0]);
  const tip = Number(data?.pair?.json?.last_block?.[0]);
  const genesis = String(data?.genesis?.header?.hash ?? "");

  if (!Number.isSafeInteger(finalized) || finalized < 0) throw new Error("The archive gave no finalized height");

  return { finalized, genesis, tip: Number.isSafeInteger(tip) ? tip : finalized };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A memo as text when it is UTF-8 without control characters, else as 0x hex
 * (`binary`).
 *
 * @param {unknown} hex
 * @returns {{ memo: string, binary: boolean }}
 */
function memoOf(hex) {
  const h = String(hex ?? "");

  if (!h || h.length % 2 || !/^[0-9a-f]+$/i.test(h)) return { binary: false, memo: "" };

  const bytes = Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

  try {
    const text = utf8.decode(bytes);

    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { binary: false, memo: text };
  } catch {
    // not text
  }

  return { binary: true, memo: `0x${h.toLowerCase()}` };
}

/** @param {any} receiver */
const moonlightOf = (receiver) => (receiver && typeof receiver === "object" ? (receiver.Moonlight ?? null) : null);

/** @param {any} receiver */
const phoenixOf = (receiver) => (receiver && typeof receiver === "object" ? (receiver.Phoenix ?? null) : null);

/**
 * @param {string} account
 * @param {any} raw
 * @returns {HistoryEntry | null}
 */
export function parseHistoryEntry(account, raw) {
  const hash = String(raw?.origin ?? "").toLowerCase();
  const blockHeight = Number(raw?.block_height);

  if (!HASH.test(hash) || !Number.isSafeInteger(blockHeight) || blockHeight < 0) return null;

  let inValue = 0n;
  let outValue = 0n;
  // Of those, unspent gas paid to another account than its sender.
  let refunded = 0n;
  /** @type {bigint | null} */
  let selfValue = null;
  let payer = false;
  let memo = "";
  let memoBinary = false;
  /** @type {EntryKind | null} */
  let kind = null;
  /** @type {string | null} */
  let counterparty = null;
  // The first counterparty each way, for kinds that don't name their own.
  /** @type {string | null} */
  let sentTo = null;
  /** @type {string | null} */
  let receivedFrom = null;
  const stakeTopics = new Set();

  for (const event of Array.isArray(raw?.events) ? raw.events : []) {
    if (!event || typeof event !== "object" || event.reverted === true) continue;

    const target = String(event.target ?? "").toLowerCase();
    const topic = String(event.topic ?? "");

    if (target === STAKE_CONTRACT) {
      stakeTopics.add(topic);
      continue;
    }

    const d = event.data;

    if (target !== TRANSFER_CONTRACT || !d || typeof d !== "object") continue;

    if (topic === "moonlight") {
      const value = u64(d.value);
      // No receiver means the sender's own account, as for a contract call.
      const receiver = d.receiver ?? d.sender;
      const ours = d.sender === account || receiver === account;

      if (d.sender === account) payer = true;
      if (ours) ({ binary: memoBinary, memo } = memoOf(d.memo));

      if (d.sender === account && receiver === account) {
        selfValue = (selfValue ?? 0n) + value;
      } else if (d.sender === account) {
        outValue += value;
        sentTo ??= receiver;
      } else if (receiver === account) {
        inValue += value;
        receivedFrom ??= d.sender;
      }

      // Unspent gas paid to another account than the sender: what reached
      // that account, and what left the sender beside its fee.
      if (Array.isArray(d.refund_info) && d.refund_info[0] !== d.sender) {
        const refund = u64(d.refund_info[1]);

        if (d.refund_info[0] === account) {
          inValue += refund;
          refunded += refund;
          receivedFrom ??= d.sender;
        } else if (d.sender === account) {
          outValue += refund;
          refunded += refund;
        }
      }
    } else if (topic === "convert") {
      const value = u64(d.value);

      if (d.sender === account) {
        outValue += value;
        kind = ENTRY_KIND.SHIELD;
        counterparty = phoenixOf(d.receiver);
      } else if (moonlightOf(d.receiver) === account) {
        inValue += value;
        kind = ENTRY_KIND.UNSHIELD;
      }
    } else if (topic === "deposit") {
      if (d.sender !== account) continue;

      outValue += u64(d.value);

      const to = String(d.receiver ?? "").toLowerCase();

      kind ??= to === STAKE_CONTRACT ? ENTRY_KIND.STAKE : ENTRY_KIND.CONTRACT_CALL;
      counterparty ??= to || null;
    } else if (topic === "withdraw" || topic === "mint") {
      if (moonlightOf(d.receiver) !== account) continue;

      inValue += u64(d.value);

      const from = String(d.sender ?? "").toLowerCase();

      if (from === STAKE_CONTRACT) kind ??= topic === "mint" ? ENTRY_KIND.WITHDRAW_REWARD : ENTRY_KIND.UNSTAKE;
      receivedFrom ??= from || null;
    } else if (topic === "contract_to_account") {
      if (d.receiver !== account) continue;

      inValue += u64(d.value);
      receivedFrom ??= String(d.sender ?? "").toLowerCase() || null;
    }
  }

  // The stake contract's own events say which stake operation a withdraw was.
  if (kind === ENTRY_KIND.UNSTAKE && stakeTopics.has("withdraw") && !stakeTopics.has("unstake")) {
    kind = ENTRY_KIND.WITHDRAW_REWARD;
  }

  const net = inValue - outValue;
  /** @type {Direction} */
  let direction;
  let value;

  if (net > 0n) {
    direction = "in";
    value = net;
  } else if (net < 0n) {
    direction = "out";
    value = -net;
  } else if ((selfValue ?? 0n) > 0n && inValue === 0n) {
    direction = "self";
    value = /** @type {bigint} */ (selfValue);
  } else {
    // Nothing moved but the fee: a contract call without a deposit, or one that failed.
    direction = payer ? "out" : "in";
    value = 0n;
  }

  if (!kind) {
    kind =
      direction === "self" || sentTo || receivedFrom || !payer ? ENTRY_KIND.TRANSFER : ENTRY_KIND.CONTRACT_CALL;
  }

  if (!counterparty) {
    if (direction === "self") counterparty = account;
    else counterparty = direction === "out" ? sentTo : receivedFrom;
  }

  return {
    blockHeight,
    counterparty: counterparty || null,
    direction,
    hash,
    kind,
    memo,
    ...(memoBinary ? { memoBinary: true } : {}),
    payer,
    value,
    ...(refunded ? { refund: refunded } : {}),
  };
}

/**
 * @param {KeptEntry} row
 * @param {{ network?: NetworkRef | null, pools?: Iterable<string> }} [options]
 * @returns {ReadEntry}
 */
export function historyEntry(row, { network = null, pools } = {}) {
  const net = networkOf(network);
  const counterparty = typeof row.counterparty === "string" && row.counterparty ? row.counterparty : null;
  const { direction } = row;
  const route =
    net && counterparty && row.kind === ENTRY_KIND.TRANSFER && (direction === "in" || direction === "out")
      ? routeForAccount(net, counterparty, direction)
      : null;
  const sozu = Boolean(
    net && row.contractId && row.fnName && isSozuCall(net, { contractId: row.contractId, fnName: row.fnName }, { pools: pools ?? [] })
  );
  const { refund, ...fields } = row;

  return {
    ...fields,
    blockHash: row.blockHash,
    blockHeight: row.blockHeight,
    bridge: row.bridge,
    contractId: row.contractId,
    counterparty,
    detailsAt: row.detailsAt,
    direction,
    error: row.error,
    // The fee is the sender's: there's one only on what the account paid for.
    fee: row.payer && row.fee !== null && row.fee !== undefined ? u64(row.fee) : null,
    fnName: row.fnName,
    gasLimit: row.gasLimit,
    gasPrice: row.gasPrice,
    gasSpent: row.gasSpent,
    hash: row.hash,
    kind: row.kind,
    memo: row.memo ?? "",
    payer: Boolean(row.payer),
    route,
    sozu,
    success: row.success ?? null,
    timestamp: row.timestamp ?? null,
    value: u64(row.value),
    ...(refund === undefined ? {} : { refund: u64(refund) }),
  };
}

/**
 * An entry as the store keeps it, from one `historyEntry` read: amounts as
 * decimal strings, its fee from its gas whoever paid it, without what the
 * read adds. A kept entry is given as it is.
 *
 * @param {KeptEntry | ReadEntry} entry
 * @returns {KeptEntry}
 */
function keptOf(entry) {
  if (typeof entry?.value !== "bigint") return /** @type {KeptEntry} */ (entry);

  const { refund, route, sozu, ...rest } = /** @type {ReadEntry} */ (entry);
  const { gasPrice, gasSpent } = rest;

  return {
    ...rest,
    fee: gasSpent !== undefined && gasPrice !== undefined ? (u64(gasSpent) * u64(gasPrice)).toString() : undefined,
    success: rest.success ?? undefined,
    timestamp: rest.detailsAt ? rest.timestamp : undefined,
    value: rest.value.toString(),
    ...(refund === undefined ? {} : { refund: refund.toString() }),
  };
}

/**
 * Each entry once, by hash: the first one read.
 *
 * @param {HistoryEntry[]} entries
 * @returns {HistoryEntry[]}
 */
function uniqueByHash(entries) {
  /** @type {Map<string, HistoryEntry>} */
  const out = new Map();

  for (const entry of entries) if (!out.has(entry.hash)) out.set(entry.hash, entry);

  return [...out.values()];
}

/**
 * @param {string} account
 * @param {any[][]} lists
 * @returns {HistoryEntry[]}
 */
function entriesOf(account, lists) {
  /** @type {HistoryEntry[]} */
  const entries = [];

  for (const raw of lists.flat()) {
    const entry = parseHistoryEntry(account, raw);

    if (entry) entries.push(entry);
  }

  return uniqueByHash(entries);
}

// ---------------------------------------------------------------------------
// Coverage: disjoint [lo, hi] ranges of heights whose entries are all kept,
// highest first.
// ---------------------------------------------------------------------------

/**
 * @param {number[][]} covered
 * @param {number} lo
 * @param {number} hi
 * @returns {number[][]}
 */
export function addCoverage(covered, lo, hi) {
  if (!(hi >= lo)) return covered.map((r) => [...r]);

  const ranges = [...covered.map((r) => [...r]), [lo, hi]].sort((a, b) => a[0] - b[0]);
  /** @type {number[][]} */
  const out = [];

  for (const [a, b] of ranges) {
    const last = out[out.length - 1];

    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }

  return out.reverse();
}

/**
 * @param {number[][]} covered
 * @param {number} target
 * @returns {[number, number] | null}
 */
export function topGap(covered, target) {
  let hi = target;

  for (const [a, b] of covered) {
    if (b < hi) return [b + 1, hi];

    hi = Math.min(hi, a - 1);

    if (hi < 0) return null;
  }

  return hi >= 0 ? [0, hi] : null;
}

/**
 * @param {number[][]} covered
 * @param {number} target
 * @returns {number | null}
 */
export function shownDownTo(covered, target) {
  const top = covered.find(([a, b]) => a <= target && b >= target) ?? covered[0];

  return top ? top[0] : null;
}

// ---------------------------------------------------------------------------
// Reading ranges
// ---------------------------------------------------------------------------

/**
 * One range of both directions, `to` open when undefined; with `head`, the
 * head in the same request. The range holds `entries`, and is complete
 * from `from` up to `completeTo` (inclusive): `to`, unless a direction
 * filled its page, and then the height under that page's last entry, which
 * may have more.
 *
 * @param {Archive} archive
 * @param {string} account
 * @param {{ from: number, to?: number, head?: boolean }} range
 */
async function readRange(archive, account, { from, to, head = false }) {
  const data = await archive.query(rangeQuery(account, { from, head, to }));
  const out = listOf(data?.out);
  const inn = listOf(data?.in);
  let completeTo = to;
  let fullPages = 0;

  for (const list of [out, inn]) {
    if (list.length < PAGE) continue;

    const last = Number(list[list.length - 1]?.block_height);
    const below = Number.isSafeInteger(last) ? last - 1 : from - 1;

    fullPages += 1;
    completeTo = completeTo === undefined ? below : Math.min(completeTo, below);
  }

  return {
    completeTo,
    count: Math.max(out.length, inn.length),
    entries: entriesOf(account, [out, inn]),
    fullPages,
    head: head ? readHead(data) : null,
  };
}

/**
 * One page of a block holding more than a page: its entries, and whether
 * there are more after it, as a direction filled the page.
 *
 * @param {Archive} archive
 * @param {string} account
 * @param {number} height
 * @param {number} page
 */
async function readBlockPage(archive, account, height, page) {
  const data = await archive.query(rangeQuery(account, { from: height, page, to: height }));
  const out = listOf(data?.out);
  const inn = listOf(data?.in);

  return { entries: entriesOf(account, [out, inn]), more: out.length >= PAGE || inn.length >= PAGE };
}

/**
 * The next window after one that held `count` entries in its fuller
 * direction: eight times wider under a quarter page, twice under half.
 *
 * @param {number} window
 * @param {number} count
 */
function nextWindow(window, count) {
  if (count < PAGE / 4) return Math.min(window * 8, MAX_WINDOW);
  if (count < PAGE / 2) return Math.min(window * 2, MAX_WINDOW);

  return window;
}

/**
 * @param {Archive} archive
 * @param {RangeOptions} options
 * @returns {Promise<{ entries: HistoryEntry[], complete: boolean, requests: number }>}
 */
export async function historyRange(archive, { account, from = 0, to, direction = "both", pages = 1, page: first = 1 }) {
  /** @type {Record<string, ReadonlyArray<"in" | "out">>} */
  const ASKED = { both: ["out", "in"], in: ["in"], out: ["out"] };
  const aliases = Object.hasOwn(ASKED, direction) ? ASKED[direction] : null;

  if (!aliases) throw new RangeError('The direction is "in", "out" or "both"');

  /** @type {HistoryEntry[]} */
  const entries = [];
  let complete = false;
  let requests = 0;
  const start = Math.max(1, Math.floor(Number(first)) || 1);

  for (let page = start; page < start + Math.max(1, Math.floor(pages)) && !complete; page += 1) {
    requests += 1;

    const data = await archive.query(rangeQuery(account, { aliases, from, page, to }));
    const lists = aliases.map((alias) => listOf(data?.[alias]));

    entries.push(...entriesOf(account, lists));
    complete = lists.every((list) => list.length < PAGE);
  }

  // Oldest first, as the archive lists them.
  return { complete, entries: uniqueByHash(entries).sort((a, b) => a.blockHeight - b.blockHeight), requests };
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/**
 * A transaction's error as text: "" for none.
 *
 * @param {unknown} err
 */
const errorText = (err) => (err === null || err === undefined ? "" : typeof err === "string" ? err : JSON.stringify(err));

/**
 * What a call to the bridge's contracts did, as an entry keeps it; null for
 * a call that doesn't decode as one of the bridge's.
 *
 * @param {Network} net
 * @param {{ contractId?: string, fnName?: string, data: string | null }} call
 * @returns {BridgeFacts | null}
 */
function bridgeFactsOf(net, { contractId, fnName, data }) {
  const call = decodeBridgeCall(net, { args: data, contractId, fnName });

  if (!call) return null;

  if (call.kind === "deposit") return { amount: String(call.amountLux), kind: "deposit", to: call.recipient };

  return {
    amount: String(call.amountWei / LUX_IN_WEI),
    hash: call.hash,
    kind: call.kind,
    recipient: call.recipient.kind === "account" ? call.recipient.account : call.recipient.contractId,
    withdrawal: call.nonce.toString(16).padStart(64, "0"),
  };
}

/**
 * @param {ReadonlyArray<string>} hashes
 * @param {ReadonlySet<string>} args
 */
const detailsQuery = (hashes, args) =>
  `query { ${hashes
    .map(
      (hash, i) =>
        `t${i}: tx(hash: "${hash}") { err gasSpent blockHash blockTimestamp tx { gasPrice gasLimit callData { contractId fnName${args.has(hash) ? " data" : ""} } } }`
    )
    .join(" ")} }`;

/**
 * @param {Archive} archive
 * @param {ReadonlyArray<string>} hashes
 * @param {DetailsOptions} [options]
 * @returns {Promise<Map<string, EntryDetails & Record<string, unknown>>>}
 */
export async function fetchTxDetails(archive, hashes, { network = null, account = "", args = new Set(), callFacts, now = Date.now } = {}) {
  const net = networkOf(network);
  const list = [...new Set(hashes.filter((h) => typeof h === "string" && HASH.test(h)))].slice(0, DETAILS_BATCH);
  /** @type {Map<string, EntryDetails & Record<string, unknown>>} */
  const out = new Map();

  if (!list.length) return out;

  const data = await archive.query(detailsQuery(list, args));

  list.forEach((hash, i) => {
    const tx = data?.[`t${i}`];

    if (!tx || typeof tx !== "object") return;

    const gasSpent = u64(tx.gasSpent);
    const gasPrice = u64(tx.tx?.gasPrice);
    const seconds = Number(tx.blockTimestamp);
    const err = errorText(tx.err);
    const call = tx.tx?.callData;
    const contractId = call?.contractId ? String(call.contractId) : undefined;
    const fnName = call?.fnName ? String(call.fnName) : undefined;
    const blockHash = String(tx.blockHash ?? "");
    /** @type {Record<string, unknown>} */
    let read = {};
    /** @type {{ bridge?: BridgeFacts | null }} */
    const bridge = {};

    if (args.has(hash)) {
      const callArgs = typeof call?.data === "string" ? call.data : null;

      if (net && isBridgeContract(net, contractId)) bridge.bridge = bridgeFactsOf(net, { contractId, data: callArgs, fnName });

      if (callFacts) {
        try {
          read = callFacts.read({ args: callArgs, contractId: contractId ?? "", fnName: fnName ?? "" }, account) ?? {};
        } catch {
          read = {};
        }
      }
    }

    out.set(hash, {
      ...read,
      ...bridge,
      blockHash: HASH.test(blockHash) ? blockHash : undefined,
      contractId,
      detailsAt: now(),
      error: err || undefined,
      fee: (gasSpent * gasPrice).toString(),
      fnName,
      gasLimit: u64(tx.tx?.gasLimit).toString(),
      gasPrice: gasPrice.toString(),
      gasSpent: gasSpent.toString(),
      success: !err,
      timestamp: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    });
  });

  return out;
}

/**
 * @param {Archive} archive
 * @param {string} hash
 * @returns {Promise<string | null>}
 */
export async function fetchTxNonce(archive, hash) {
  if (typeof hash !== "string" || !HASH.test(hash)) return null;

  const data = await archive.query(`query { tx(hash: "${hash}") { tx { json } } }`);

  try {
    const { nonce } = parseJsonExact(String(data?.tx?.tx?.json ?? ""));

    return typeof nonce === "number" || typeof nonce === "string" ? String(nonce) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * @param {HistoryEntry} entry
 * @returns {KeptEntry}
 */
const toKept = ({ refund, ...entry }) => ({ ...entry, value: entry.value.toString(), ...(refund === undefined ? {} : { refund: refund.toString() }) });

/**
 * @param {HistoryOptions} options
 * @returns {History}
 */
export function createHistory({ archive, account, store, network = null, callFacts, now = Date.now }) {
  if (!archive || typeof archive.query !== "function") throw new TypeError("An archive is required");
  if (!isAccount(account)) throw new TypeError("Not a Dusk public account");
  if (!store) throw new TypeError("A store is required");

  const net = networkOf(network);

  /**
   * Whether an entry's call goes to DuskEVM's bridge or Portal, by its
   * contract, or before its details by the contract it paid a deposit.
   *
   * @param {KeptEntry | ReadEntry} entry
   */
  const callsBridge = (entry) =>
    Boolean(net) && [entry?.contractId, entry?.counterparty].some((id) => isBridgeContract(/** @type {Network} */ (net), id));

  /**
   * A bridge call not read yet, or a proof or a claim read without its
   * hash, which its claim date is read by, or whom it pays.
   *
   * @param {KeptEntry | ReadEntry} entry
   */
  function needsBridge(entry) {
    if (!callsBridge(entry)) return false;

    const bridge = /** @type {any} */ (entry.bridge);

    return bridge === undefined || ((bridge?.kind === "prove" || bridge?.kind === "claim") && (!bridge.hash || bridge.recipient === undefined));
  }

  /** @param {KeptEntry | ReadEntry} entry */
  function wanted(entry) {
    try {
      return Boolean(callFacts?.wants(keptOf(entry)));
    } catch {
      return false;
    }
  }

  /**
   * Whether the kept history is no longer the one a run writes: another run
   * started it over on another chain since, or it was cleared under it.
   *
   * @param {HistoryState | null | undefined} kept
   * @param {{ genesis: string, kept: boolean }} chain - the run's chain, and whether it has seen the history kept
   */
  const staleFor = (kept, chain) =>
    kept === null || kept === undefined ? chain.kept : Boolean(chain.genesis && kept.genesis && kept.genesis !== chain.genesis);

  /** @param {KeptEntry | ReadEntry} entry */
  const needsDetails = (entry) => !entry?.detailsAt || needsBridge(entry) || wanted(entry);

  /**
   * Up to `want` kept entries that need details, newest first, read a page
   * at a time past those that have them. It looks through at most
   * PENDING_PAGES pages; older entries get theirs when the app shows them.
   *
   * @param {number} want
   * @returns {Promise<KeptEntry[]>}
   */
  async function pendingRows(want) {
    /** @type {KeptEntry[]} */
    const due = [];
    /** @type {number | undefined} */
    let before;

    for (let page = 0; page < PENDING_PAGES; page += 1) {
      const rows = await listWhole(before, want);

      due.push(...rows.filter(needsDetails));
      if (due.length >= want || rows.length < want) break;
      before = rows[rows.length - 1].blockHeight;
    }

    return due.slice(0, want);
  }

  /**
   * Details for the newest kept entries that need them, or for `entries`,
   * a batch per request, each kept only while the history is still the one
   * `chain` reads. A request that fails rejects, or with `lenient`, as in a
   * sync run, ends the details there and gives its error.
   *
   * @param {{ chain: { genesis: string, kept: boolean }, entries?: ReadonlyArray<KeptEntry | ReadEntry>, maxRequests: number, onStep?: () => void, lenient?: boolean }} options
   * @returns {Promise<Error | null>}
   */
  async function fillDetails({ chain, entries, maxRequests, onStep, lenient = false }) {
    let requests = Math.max(0, Math.floor(maxRequests));

    if (!requests) return null;

    const due = entries ? entries.filter(needsDetails) : await pendingRows(DETAILS_BATCH * requests);
    // Arguments are asked only of the calls they're read for.
    const forBridge = new Set(due.filter(callsBridge).map((e) => e.hash));
    const args = new Set([...forBridge, ...due.filter(wanted).map((e) => e.hash)]);

    for (let i = 0; i < due.length && requests > 0; i += DETAILS_BATCH, requests -= 1) {
      const batch = due.slice(i, i + DETAILS_BATCH).map((e) => e.hash);
      /** @type {Map<string, EntryDetails & Record<string, unknown>>} */
      let details;

      try {
        details = await fetchTxDetails(archive, batch, { account, args, callFacts, network: net, now });
      } catch (error) {
        if (!lenient) throw error;

        return error instanceof Error ? error : new Error(messageOf(error));
      }

      // Asked for the bridge, and its call isn't the bridge's: read, and kept so.
      for (const [hash, found] of details) if (forBridge.has(hash) && found.bridge === undefined) found.bridge = null;

      // A transaction the archive doesn't have yet is looked up again next time.
      if (details.size) {
        if (staleFor(await store.getState(), chain)) throw new StaleHistoryError();

        /** @type {StaleHistoryError | null} */
        let refused = null;

        try {
          // Checked again in the write's own transaction, by a store that can.
          await store.patch(details, (kept) => {
            if (staleFor(kept, chain)) throw (refused = new StaleHistoryError());
          });
        } catch (error) {
          throw refused ?? error;
        }

        if (refused) throw refused;
      }

      onStep?.();
    }

    return null;
  }

  /**
   * Kept entries, newest first: `limit` of them below the height `before`,
   * and the rest of the last one's block when `limit` cuts through it, so
   * reading on below that block's height skips none. The store's own order
   * within a block doesn't matter.
   *
   * @param {number | undefined} before
   * @param {number} limit
   * @returns {Promise<KeptEntry[]>}
   */
  async function listWhole(before, limit) {
    const n = Math.floor(limit);

    if (!(n > 0)) return [];

    const rows = await store.list({ before, limit: n + 1 });

    if (rows.length <= n) return rows;

    const edge = rows[n - 1].blockHeight;

    if (rows[n].blockHeight !== edge) return rows.slice(0, n);

    const above = rows.slice(0, n).filter((row) => row.blockHeight > edge);

    for (let want = 2 * n; ; want *= 2) {
      const block = await store.list({ before: edge + 1, limit: want });

      if (block.length < want || block[block.length - 1].blockHeight < edge) {
        return [...above, ...block.filter((row) => row.blockHeight === edge)];
      }
    }
  }

  /**
   * One run, or, once its head named another chain than the history kept,
   * the same run started over on that chain (`restart`): on what is left of
   * its budget, from the head it read.
   *
   * @param {number} maxRequests - 2 or more, the head's included
   * @param {number} maxDetailRequests - 0 or more
   * @param {((state: HistoryState) => void) | undefined} onStep
   * @param {{ budget: { left: number }, head: { finalized: number, genesis: string } } | null} [restart]
   * @returns {Promise<{ state: HistoryState, requests: number, added: number, detailsError?: Error }>}
   */
  async function run(maxRequests, maxDetailRequests, onStep, restart = null) {
    /** @type {HistoryState | null} */
    let state = (await store.getState()) ?? null;
    const budget = restart?.budget ?? { left: maxRequests };
    let detailsLeft = maxDetailRequests;
    let added = 0;
    // A details request that failed: the run reads no more details, and goes on.
    /** @type {Error | null} */
    let detailsError = null;
    // The chain this run reads, once its head names it, and whether it has
    // seen the history kept: one cleared since isn't this run's to write.
    const chain = { genesis: "", kept: state !== null };
    const report = () => {
      if (state) onStep?.(state);
    };

    /**
     * Keeps a step: its entries, each once, and the state made from the one
     * kept now. The first entries a run finds are the newest: their details
     * come at once, before the run reads further down.
     *
     * @param {HistoryEntry[]} found
     * @param {{ cover?: number[][], set?: Record<string, unknown> }} patch
     */
    const commit = async (found, patch) => {
      const entries = uniqueByHash(found);
      /** @type {HistoryState | undefined} */
      let made;
      /** @type {StaleHistoryError | null} */
      let refused = null;
      /** @type {HistoryState | void} */
      let kept;

      try {
        kept = await store.commit(entries.map(toKept), (before) => {
          // Another run started this history over, or it was cleared, since
          // this one began: nothing more of this run is kept.
          if (staleFor(before, chain)) throw (refused = new StaleHistoryError());

          // Two pages syncing at once: what the other one covered stays covered.
          let covered = Array.isArray(before?.covered) ? before.covered : [];

          for (const [lo, hi] of patch.cover ?? []) covered = addCoverage(covered, lo, hi);

          made = /** @type {HistoryState} */ ({ ...(before ?? {}), ...patch.set, account, covered, updatedAt: now() });

          return made;
        });
      } catch (error) {
        // The store's own error for the step it refused, as IndexedDB's abort.
        throw refused ?? error;
      }

      if (refused) throw refused;

      chain.kept = true;
      state = kept ?? made ?? state;
      added += entries.length;
      report();

      if (entries.length && added === entries.length && detailsLeft > 0) {
        detailsLeft -= 1;
        detailsError = await fillDetails({ chain, lenient: true, maxRequests: 1, onStep: report });
        if (detailsError) detailsLeft = 0;
      }
    };

    // The head: the last finalized block, and with it, when a range is kept,
    // everything above that range.
    const keptTop = state?.covered?.[0]?.[1];
    /** @type {{ completeTo: number | undefined, entries: HistoryEntry[], head: { finalized: number, genesis: string } | null }} */
    let first;

    if (restart) {
      // The head this run read, which named the chain it starts over on.
      first = { completeTo: undefined, entries: [], head: restart.head };
    } else {
      budget.left -= 1;
      first =
        keptTop === undefined
          ? { completeTo: undefined, entries: [], head: readHead(await archive.query(HEAD_QUERY)) }
          : await readRange(archive, account, { from: keptTop + 1, head: true });
    }

    const { finalized, genesis } = /** @type {{ finalized: number, genesis: string }} */ (first.head);
    const target = finalized - FINALITY_MARGIN;

    // Another chain under the same node (a reset devnet or local node): what
    // is kept of the old one goes, and the history starts over, on what is
    // left of this run's budget.
    if (state?.genesis && genesis && state.genesis !== genesis) {
      if (restart) throw new Error("The store still keeps another chain's history");

      let started = false;

      try {
        // Only while it is still another chain's, checked in the clear's own
        // transaction by a store that can: another run may have started it
        // over on this chain since this one read it, and kept what it read.
        await store.clear((kept) => {
          if (kept === null || kept === undefined || kept.genesis === genesis) {
            started = true;
            throw new StaleHistoryError();
          }
        });
      } catch (error) {
        if (!started) throw error;
      }

      return run(maxRequests, maxDetailRequests, onStep, { budget, head: /** @type {{ finalized: number, genesis: string }} */ (first.head) });
    }

    chain.genesis = genesis;

    const head = { finalized, genesis: genesis || state?.genesis || "", headAt: now(), target };

    if (keptTop === undefined) {
      await commit([], { set: { ...head, window: FIRST_WINDOW } });
    } else {
      const top = Math.min(first.completeTo ?? target, target);

      // A head read before a restart read nothing above what another run
      // kept of the new chain meanwhile: nothing is covered by it.
      await commit(first.entries, { cover: !restart && top > keptTop ? [[keptTop + 1, top]] : [], set: head });
    }

    // What is missing, from the top down.
    let window = Number(state?.window) || FIRST_WINDOW;

    while (budget.left > 0) {
      const gap = topGap(state?.covered ?? [], target);

      if (!gap) break;

      const [a, b] = gap;

      // A block with more than a page at the top of what is missing: one
      // page a step, from where an earlier one left it, each kept with
      // where the next starts, so a page that fails loses none before it.
      if (state?.crowded?.height === b) {
        const { page } = state.crowded;

        budget.left -= 1;

        const block = await readBlockPage(archive, account, b, page);

        await commit(block.entries, block.more ? { set: { crowded: { height: b, page: page + 1 } } } : { cover: [[b, b]], set: { crowded: null } });
        continue;
      }

      const lo = Math.max(a, b - window + 1);

      budget.left -= 1;

      const range = await readRange(archive, account, { from: lo, to: b });

      if (!range.fullPages) {
        window = nextWindow(window, range.count);
        await commit(range.entries, { cover: [[lo, b]], set: { window } });
        continue;
      }

      // A page filled: what is under its last entry is complete; the rest
      // of the window gets a narrower one, sized to fit in a page.
      const completeTo = /** @type {number} */ (range.completeTo);

      if (completeTo >= lo) {
        window = Math.max(1, Math.floor((completeTo - lo + 2) / 2));
        await commit(range.entries, { cover: [[lo, completeTo]], set: { window } });
        continue;
      }

      // A page filled within the window's lowest block, which holds more
      // than a page: the heights above it come first, then its pages, from
      // the second, each kept as it lands.
      window = Math.max(1, b - lo);
      await commit(range.entries, { set: { crowded: { height: lo, page: 2 }, window } });
    }

    detailsError ??= await fillDetails({ chain, lenient: true, maxRequests: detailsLeft, onStep: report });

    return {
      added,
      requests: maxRequests - budget.left,
      state: /** @type {HistoryState} */ (state),
      ...(detailsError ? { detailsError } : {}),
    };
  }

  return Object.freeze({
    account,
    needsDetails,

    /** @param {import("./history.js").SyncOptions} [options] */
    async sync({ maxRequests = RUN_REQUESTS, maxDetailRequests = RUN_DETAIL_REQUESTS, onStep } = {}) {
      const total = Math.floor(maxRequests);

      // The head takes one: a run with no other could never read under it.
      if (!(total >= 2)) throw new RangeError("A sync run needs 2 history requests or more: the head, and a window under it");

      await archive.assertArchive();

      return run(total, Math.max(0, Math.floor(maxDetailRequests) || 0), onStep);
    },

    /**
     * @param {ReadonlyArray<KeptEntry | ReadEntry>} entries
     * @param {{ onStep?: () => void }} [options]
     */
    async fillDetails(entries, { onStep } = {}) {
      const due = entries.filter(needsDetails);

      if (!due.length) return;

      // The history as it is now: its details are kept while it stays so.
      const kept = (await store.getState()) ?? null;
      const chain = { genesis: String(kept?.genesis ?? ""), kept: kept !== null };

      await fillDetails({ chain, entries: due, maxRequests: Math.ceil(due.length / DETAILS_BATCH), onStep });
    },

    /** @param {{ limit?: number, before?: number, pools?: Iterable<string> }} [options] */
    async read({ limit = 200, before, pools } = {}) {
      const [state, rows] = await Promise.all([store.getState(), listWhole(before, limit)]);
      // Read once: a one-shot iterable would be used up by the first row.
      const poolList = pools === undefined ? undefined : Array.from(pools);
      const kept = state ?? null;
      const downTo = kept ? shownDownTo(kept.covered ?? [], kept.target) : null;
      // Only entries above the first gap: below it, newer ones may be missing.
      const entries =
        downTo === null
          ? []
          : rows.filter((row) => row.blockHeight >= downTo).map((row) => historyEntry(row, { network: net, pools: poolList }));

      // Complete once every height from the target down is covered: a gap at
      // the top, as a run that stopped under a crowded block leaves, is one.
      const complete = kept !== null && Number.isFinite(kept.target) && topGap(kept.covered ?? [], kept.target) === null;

      return { complete, coveredTo: downTo, entries, state: kept };
    },
  });
}
