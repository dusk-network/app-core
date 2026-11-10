/**
 * A migration's side on its own chain, for `/bridge`: its transaction on BNB
 * Smart Chain or Ethereum, the approval it spent, whenever and wherever that
 * was signed, and what each paid in that chain's coin. Not an entry point.
 *
 * @module
 */

import { routes } from "@dusk-network/networks";

import { memoTextOf } from "./moved.js";
import { EVM_HASH, RANGE_REFUSED, TIMEOUT_MS, TRANSFER_TOPIC, WEI_PER_LUX, addressOf, messageOf, networkOf, reader, urlOf } from "./bridge-common.js";

/** @typedef {import("./activity.js").ActivityRow} ActivityRow */
/** @typedef {import("./bridge.js").BridgeNetwork} BridgeNetwork */
/** @typedef {import("./bridge.js").FactCache} FactCache */
/** @typedef {import("./bridge.js").FetchLike} FetchLike */
/** @typedef {import("./bridge.js").MigrationEvm} MigrationEvm */
/** @typedef {import("./bridge.js").MigrationApproval} MigrationApproval */
/** @typedef {import("./bridge.js").ApprovalsRead} ApprovalsRead */
/** @typedef {import("./bridge-common.js").Reader} Reader */
/** @typedef {import("@dusk-network/networks").Route} Route */

/** An ERC-20 token's `Approval(owner, spender, value)`. */
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

/** The first window an approval is looked for in, back from its migration's block. */
const APPROVAL_WINDOW = 5_000;
/** Windows read at most, each twice the last the RPC answers whole. */
const APPROVAL_WINDOWS = 4;
/** The widest window: the public RPCs refuse wider. */
const MAX_WINDOW = 50_000;
/** The narrowest window a refusal halves one to. */
const MIN_WINDOW = 100;
/** Blocks under the head after which what a migration did is kept in a cache: it won't change. */
const FINAL_BLOCKS = 1_000;
/** An RPC's refusal of logs it no longer keeps: Ethereum's and Sepolia's publicnode a day on. */
const LOGS_GONE = /pruned|archive requests/i;
/** Windows an owner's approvals are read in, back from the head, each twice the last the RPC answers whole. */
const OWNER_WINDOWS = 8;

/** @param {string} address */
const topicOf = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** @param {unknown} value */
const bigOf = (value) => {
  try {
    return typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null;
  } catch {
    return null;
  }
};

/**
 * What a transaction paid in gas, from its receipt: null where it doesn't say.
 *
 * @param {any} receipt
 */
function paidOf(receipt) {
  const used = bigOf(receipt?.gasUsed);
  const price = bigOf(receipt?.effectiveGasPrice);

  return used === null || price === null ? null : used * price;
}

/**
 * A log's place in its chain, to order logs by.
 *
 * @param {any} log
 */
const placeOf = (log) => [Number(bigOf(log?.blockNumber) ?? -1n), Number(bigOf(log?.logIndex) ?? -1n)];

/**
 * @param {number[]} a
 * @param {number[]} b
 */
const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/**
 * The migrations `/activity`'s rows were paid for: each payout on Dusk that a
 * migration's route paid, with the migration's hash, its memo.
 *
 * @param {Iterable<ActivityRow>} rows
 * @returns {{ hash: string, route: string, payout: string }[]}
 */
export function migrationsOf(rows) {
  /** @type {{ hash: string, route: string, payout: string }[]} */
  const found = [];

  for (const row of rows ?? []) {
    // The migration's hash, as text: a memo of bytes that aren't text names none.
    const memo = (memoTextOf(row) ?? "").toLowerCase();

    if (row?.route?.kind === "migration" && row.direction === "in" && row.status !== "failed" && EVM_HASH.test(memo)) found.push({ hash: memo, payout: row.hash, route: row.route.id });
  }

  return found;
}

/**
 * @param {MigrationEvm} fact
 */
const keptOf = (fact) => JSON.stringify(fact, (_, value) => (typeof value === "bigint" ? `${value}n` : value));

/**
 * @param {string | null | undefined} text
 * @returns {MigrationEvm | null}
 */
function readKept(text) {
  try {
    return JSON.parse(String(text), (_, value) => (typeof value === "string" && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value));
  } catch {
    return null;
  }
}

/**
 * The approval a migration spent, among its owner's approvals of its route's
 * contract on its token, read back from the migration's block a window at a
 * time: the latest before it, that isn't itself a migration's (the token
 * writes an `Approval` as a migration spends from one). Where another of the
 * owner's migrations came between, that one spent it first, and its fee is
 * that one's: a transfer to the contract between them spent from it only where
 * the token wrote an `Approval` in its transaction too, as it does as the
 * contract draws on one; the owner's own transfer to the contract writes none
 * and draws on none. Where the token writes none as it's spent (`announces`,
 * as the migration's own receipt says), a transfer between can't be told
 * apart: "uncertain".
 *
 * @param {Reader} read
 * @param {string} rpcUrl
 * @param {{ token: string, contract: string, owner: string, hash: string, block: number, migrationLogs: any[], announces: boolean }} sought
 * @returns {Promise<{ state: MigrationEvm["approvalState"], hash?: string }>}
 */
async function approvalSpent(read, rpcUrl, { announces, block, contract, hash, migrationLogs, owner, token }) {
  const own = migrationLogs.filter((log) => String(log?.transactionHash ?? "").toLowerCase() === hash);
  const at = own.map(placeOf).reduce((first, place) => (before(place, first) ? place : first), [block, Number.MAX_SAFE_INTEGER]);
  /** @type {any[]} */
  const logs = [];
  let to = block;
  let width = APPROVAL_WINDOW;

  for (let windows = 0; windows < APPROVAL_WINDOWS && to >= 0; ) {
    const from = Math.max(0, to - width + 1);
    /** @type {any[]} */
    let answer;

    try {
      answer = await read.rpc(rpcUrl, "eth_getLogs", [{ address: token, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [[APPROVAL_TOPIC, TRANSFER_TOPIC], topicOf(owner), topicOf(contract)] }]);
    } catch (error) {
      // As BSC's gives none: the logs that far back can't be read.
      if (LOGS_GONE.test(messageOf(error))) return { state: "unread" };
      if (!RANGE_REFUSED.test(messageOf(error)) || width <= MIN_WINDOW) throw error;

      width = Math.max(MIN_WINDOW, Math.floor(width / 2));
      continue;
    }

    // An RPC that no longer gives these blocks' logs gives none: the migration's own say so.
    if (windows === 0 && own.length && !(Array.isArray(answer) ? answer : []).some((log) => String(log?.transactionHash ?? "").toLowerCase() === hash)) return { state: "unread" };

    logs.push(...(Array.isArray(answer) ? answer : []));
    windows += 1;

    const spends = new Set(logs.filter((log) => log?.topics?.[0] === TRANSFER_TOPIC).map((log) => String(log.transactionHash).toLowerCase()));
    const approvals = logs.filter((log) => log?.topics?.[0] === APPROVAL_TOPIC && !spends.has(String(log.transactionHash).toLowerCase()) && before(placeOf(log), at));
    const approval = approvals.reduce((last, log) => (!last || before(placeOf(last), placeOf(log)) ? log : last), /** @type {any} */ (null));

    if (approval) {
      const since = placeOf(approval);
      /** @param {any} log */
      const txOf = (log) => String(log.transactionHash).toLowerCase();
      const between = logs.filter((log) => log?.topics?.[0] === TRANSFER_TOPIC && txOf(log) !== hash && before(since, placeOf(log)) && before(placeOf(log), at));
      const approving = new Set(logs.filter((log) => log?.topics?.[0] === APPROVAL_TOPIC).map(txOf));
      const state = between.some((log) => approving.has(txOf(log))) ? "earlier" : between.length && !announces ? "uncertain" : "found";

      return { hash: txOf(approval), state };
    }

    to = from - 1;
    width = Math.min(MAX_WINDOW, width * 2);
  }

  return { state: "beyond" };
}

/**
 * When a block was made, in milliseconds: from a log of it, else from the
 * block. Null where neither says.
 *
 * @param {Reader} read
 * @param {string} rpcUrl
 * @param {any} receipt
 */
async function timeOf(read, rpcUrl, receipt) {
  /** @type {any[]} */
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
  const stamped = logs.map((log) => bigOf(log?.blockTimestamp)).find((stamp) => stamp !== null);
  const stamp = stamped ?? bigOf((await read.rpc(rpcUrl, "eth_getBlockByNumber", [receipt.blockNumber, false]))?.timestamp);

  return stamp === null || stamp === undefined ? null : Number(stamp) * 1000;
}

/**
 * One migration's side on its chain, and whether it's final: in a block
 * under the head by `FINAL_BLOCKS`, with all of it read.
 *
 * @param {Reader} read
 * @param {{ hash: string, route: Route & { kind: "migration" }, approval: string, rpcUrl: string, head: () => Promise<number> }} asked
 * @returns {Promise<{ fact: MigrationEvm, final: boolean }>}
 */
async function readMigration(read, { approval: given, hash, head, route, rpcUrl }) {
  const chain = /** @type {any} */ (route.chain);
  const token = addressOf(chain?.token);
  const contract = addressOf(route.contract);
  const base = { approval: null, approvalState: /** @type {const} */ ("none"), at: null, block: null, coin: String(chain?.currency?.symbol ?? "ETH"), from: null, gasWei: null, hash, lux: null, route: route.id, totalWei: null };
  const receipt = await read.rpc(rpcUrl, "eth_getTransactionReceipt", [hash]);

  if (!receipt) return { fact: { ...base, state: "pending" }, final: false };
  if (addressOf(receipt.to) !== contract || !token) return { fact: { ...base, state: "not-migration" }, final: false };

  const owner = addressOf(receipt.from);
  const block = Number(bigOf(receipt.blockNumber) ?? -1n);
  const gasWei = paidOf(receipt);
  const went = receipt.status === "0x1";
  /** @type {any[]} */
  const all = Array.isArray(receipt.logs) ? receipt.logs : [];
  const logs = all.filter((log) => addressOf(log?.address) === token && log?.topics?.[0] === TRANSFER_TOPIC && log.topics[1] === topicOf(owner) && log.topics[2] === topicOf(contract));
  const moved = logs.reduce((/** @type {bigint} */ sum, log) => sum + (bigOf(log.data) ?? 0n), 0n);
  // The token says what a migration draws on an approval: an Approval in its receipt, of what's left.
  const announces = all.some((log) => addressOf(log?.address) === token && log?.topics?.[0] === APPROVAL_TOPIC && log.topics[1] === topicOf(owner) && log.topics[2] === topicOf(contract));
  const at = await timeOf(read, rpcUrl, receipt);
  /** @type {MigrationEvm} */
  const fact = { ...base, at, block, from: owner, gasWei, lux: went ? moved / WEI_PER_LUX : null, state: went ? "mined" : "failed", totalWei: gasWei };

  // A migration that failed spent no approval: the one that spends it counts it.
  if (!went || !owner) return { fact, final: at !== null && gasWei !== null && (await head()) - block >= FINAL_BLOCKS };

  /** @type {{ state: MigrationEvm["approvalState"], hash?: string }} */
  let spent = await approvalSpent(read, rpcUrl, { announces, block, contract, hash, migrationLogs: logs, owner, token });

  // An approval the app names, where the logs can't say which this migration
  // spent: it's this one's only where the owner sent nothing between them, by
  // its nonce right before the migration's, so no other approval or spend came between.
  if (given && (spent.state === "unread" || spent.state === "beyond")) {
    const [kept, approvalTx, migrationTx] = await Promise.all([
      read.rpc(rpcUrl, "eth_getTransactionReceipt", [given]),
      read.rpc(rpcUrl, "eth_getTransactionByHash", [given]),
      read.rpc(rpcUrl, "eth_getTransactionByHash", [hash]),
    ]);
    /** @type {any[]} */
    const keptLogs = Array.isArray(kept?.logs) ? kept.logs : [];
    const approves = keptLogs.some((log) => addressOf(log?.address) === token && log?.topics?.[0] === APPROVAL_TOPIC && log.topics[1] === topicOf(owner) && log.topics[2] === topicOf(contract));
    const [before, after] = [bigOf(approvalTx?.nonce), bigOf(migrationTx?.nonce)];
    const next = before !== null && after !== null && before + 1n === after;

    if (approves && next && addressOf(kept.from) === owner && addressOf(approvalTx?.from) === owner && Number(bigOf(kept.blockNumber) ?? Infinity) <= block) spent = { hash: given, state: "found" };
  }

  if (spent.hash && (spent.state === "found" || spent.state === "earlier" || spent.state === "uncertain")) {
    const approvalReceipt = await read.rpc(rpcUrl, "eth_getTransactionReceipt", [spent.hash]);
    const approvalWei = paidOf(approvalReceipt);

    fact.approval = { at: approvalReceipt ? await timeOf(read, rpcUrl, approvalReceipt) : null, block: Number(bigOf(approvalReceipt?.blockNumber) ?? -1n), gasWei: approvalWei, hash: spent.hash };
    if (spent.state === "found" && approvalWei !== null && gasWei !== null) fact.totalWei = gasWei + approvalWei;
  }

  fact.approvalState = spent.state;

  // Kept for good once it's final and all of it was read: its own time and gas, and the approval's receipt.
  const whole = at !== null && gasWei !== null && spent.state !== "unread" && (!fact.approval || (fact.approval.gasWei !== null && fact.approval.at !== null));

  return { fact, final: whole && (await head()) - block >= FINAL_BLOCKS };
}

/**
 * @param {{ network: BridgeNetwork, migrations: Iterable<{ hash: string, route?: string | null, approval?: string | null }>, fetch?: FetchLike, rpcUrl?: string, cache?: FactCache, timeoutMs?: number }} options
 * @returns {Promise<Map<string, MigrationEvm>>}
 */
export async function migrationFacts({ cache, fetch: fetchFn, migrations, network, rpcUrl, timeoutMs = TIMEOUT_MS }) {
  const net = networkOf(network);
  const own = routes(net).filter((route) => route.kind === "migration");
  const read = reader(fetchFn, timeoutMs);
  /** @type {Map<string, Promise<number>>} */
  const heads = new Map();
  /** @type {Map<string, MigrationEvm>} */
  const out = new Map();

  await Promise.all(
    [...(migrations ?? [])].map(async ({ approval, hash: given, route: routeId }) => {
      const hash = String(given ?? "").trim().toLowerCase();
      const route = /** @type {(Route & { kind: "migration" }) | undefined} */ (routeId ? own.find((each) => each.id === routeId) : own.length === 1 ? own[0] : undefined);
      const approvalHash = EVM_HASH.test(String(approval ?? "").trim().toLowerCase()) ? String(approval).trim().toLowerCase() : "";

      if (!EVM_HASH.test(hash) || !route || out.has(hash)) return;

      const key = `migration-evm:${net.chainId}:${route.id}:${hash}:${approvalHash}`;
      const kept = readKept(cache?.get(key));

      if (kept) {
        out.set(hash, kept);
        return;
      }

      const url = urlOf(rpcUrl, /** @type {any} */ (route.chain)?.rpcUrl, `${route.id}'s RPC`);
      const head = () => {
        let known = heads.get(url);

        if (!known) {
          known = read.rpc(url, "eth_blockNumber", []).then((value) => Number(bigOf(value) ?? 0n));
          heads.set(url, known);
        }

        return known;
      };

      try {
        const { fact, final } = await readMigration(read, { approval: approvalHash, hash, head, route, rpcUrl: url });

        out.set(hash, fact);
        if (final) cache?.set(key, keptOf(fact));
      } catch (error) {
        out.set(hash, { approval: null, approvalState: "none", at: null, block: null, coin: String(/** @type {any} */ (route.chain)?.currency?.symbol ?? "ETH"), error: messageOf(error), from: null, gasWei: null, hash, lux: null, route: route.id, state: "error", totalWei: null });
      }
    })
  );

  return out;
}

/**
 * An owner's Approval and Transfer logs between it and a migration contract
 * on its token, read back from the head a window at a time: what was read,
 * from which block, and why not further.
 *
 * @param {Reader} read
 * @param {string} rpcUrl
 * @param {{ token: string, contract: string, owner: string, head: number }} sought
 * @returns {Promise<{ logs: any[], from: number, state: ApprovalsRead["state"] }>}
 */
async function ownerLogs(read, rpcUrl, { contract, head, owner, token }) {
  /** @type {any[]} */
  const logs = [];
  let to = head;
  let width = APPROVAL_WINDOW;

  for (let windows = 0; windows < OWNER_WINDOWS; ) {
    if (to < 0) return { from: 0, logs, state: "read" };

    const from = Math.max(0, to - width + 1);
    /** @type {any[]} */
    let answer;

    try {
      answer = await read.rpc(rpcUrl, "eth_getLogs", [{ address: token, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [[APPROVAL_TOPIC, TRANSFER_TOPIC], topicOf(owner), topicOf(contract)] }]);
    } catch (error) {
      if (LOGS_GONE.test(messageOf(error))) return { from: to + 1, logs, state: "unread" };
      if (!RANGE_REFUSED.test(messageOf(error)) || width <= MIN_WINDOW) throw error;

      width = Math.max(MIN_WINDOW, Math.floor(width / 2));
      continue;
    }

    logs.push(...(Array.isArray(answer) ? answer : []));
    windows += 1;
    to = from - 1;
    width = Math.min(MAX_WINDOW, width * 2);
  }

  return to < 0 ? { from: 0, logs, state: "read" } : { from: to + 1, logs, state: "beyond" };
}

/**
 * @param {{ network: BridgeNetwork, owners: Iterable<string>, fetch?: FetchLike, rpcUrl?: string, cache?: FactCache, timeoutMs?: number }} options
 * @returns {Promise<{ approvals: MigrationApproval[], reads: ApprovalsRead[] }>}
 */
export async function migrationApprovals({ cache, fetch: fetchFn, network, owners, rpcUrl, timeoutMs = TIMEOUT_MS }) {
  const net = networkOf(network);
  const read = reader(fetchFn, timeoutMs);
  const addresses = [...new Set([...(owners ?? [])].map(addressOf).filter(Boolean))];
  /** @type {MigrationApproval[]} */
  const approvals = [];
  /** @type {ApprovalsRead[]} */
  const reads = [];

  for (const route of routes(net).filter((each) => each.kind === "migration")) {
    const chain = /** @type {any} */ (route.chain);
    const token = addressOf(chain?.token);
    const contract = addressOf(/** @type {any} */ (route).contract);

    if (!token || !contract || !addresses.length) continue;

    const url = urlOf(rpcUrl, chain?.rpcUrl, `${route.id}'s RPC`);
    const coin = String(chain?.currency?.symbol ?? "ETH");

    await Promise.all(
      addresses.map(async (owner) => {
        try {
          const head = Number(bigOf(await read.rpc(url, "eth_blockNumber", [])) ?? -1n);
          const { from, logs, state } = await ownerLogs(read, url, { contract, head, owner, token });
          /** @param {any} log */
          const txOf = (log) => String(log?.transactionHash ?? "").toLowerCase();
          const ordered = logs.sort((a, b) => (before(placeOf(a), placeOf(b)) ? -1 : 1));
          // What a migration drew on: a Transfer to the contract. An Approval in a transaction of its own is the owner's approve.
          const spends = new Set(ordered.filter((log) => log?.topics?.[0] === TRANSFER_TOPIC).map(txOf));
          const own = ordered.filter((log) => log?.topics?.[0] === APPROVAL_TOPIC && !spends.has(txOf(log)));

          reads.push({ from, owner, route: route.id, state, to: head });

          for (const [i, log] of own.entries()) {
            const hash = txOf(log);
            const key = `approval-evm:${net.chainId}:${route.id}:${hash}`;
            const kept = readKept(cache?.get(key));
            /** @type {{ at: number | null, block: number, gasWei: bigint | null, from: string } | null} */
            let paid = kept ? /** @type {any} */ (kept) : null;

            if (!paid) {
              const receipt = await read.rpc(url, "eth_getTransactionReceipt", [hash]);

              paid = receipt ? { at: await timeOf(read, url, receipt), block: Number(bigOf(receipt.blockNumber) ?? -1n), from: addressOf(receipt.from), gasWei: paidOf(receipt) } : null;
              // Kept once final, and all of it read.
              if (paid && paid.at !== null && paid.gasWei !== null && head - paid.block >= FINAL_BLOCKS) cache?.set(key, keptOf(/** @type {any} */ (paid)));
            }

            // Another's transaction that set it, as a permit sent for the owner: its gas is that one's.
            if (!paid || paid.from !== owner) continue;

            const allowance = bigOf(log.data) ?? 0n;
            const next = own[i + 1];
            const spent = ordered.some((each) => each?.topics?.[0] === TRANSFER_TOPIC && before(placeOf(log), placeOf(each)) && (!next || before(placeOf(each), placeOf(next))));

            approvals.push({
              allowance,
              at: paid.at,
              block: paid.block,
              chain: String(chain?.name ?? route.id),
              coin,
              contract,
              decimals: Number(chain?.currency?.decimals ?? 18),
              gasWei: paid.gasWei,
              hash,
              owner,
              route: route.id,
              state: allowance === 0n ? "revoke" : spent ? "spent" : next ? "unused" : "open",
            });
          }
        } catch (error) {
          reads.push({ error: messageOf(error), from: null, owner, route: route.id, state: "error", to: null });
        }
      })
    );
  }

  return { approvals: approvals.sort((a, b) => a.block - b.block || (a.hash < b.hash ? -1 : 1)), reads: reads.sort((a, b) => (a.route + a.owner < b.route + b.owner ? -1 : 1)) };
}
