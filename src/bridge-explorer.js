/* @ts-self-types="./bridge-explorer.d.ts" */
/**
 * Where a deposit to DuskEVM arrived, followed on DuskEVM's explorer alone:
 * what `/bridge`'s `depositArrivals` does with `via: "explorer"`, for an
 * app that reads only the explorer, without the RPC path and `/history`.
 *
 * @module
 */

import {
  CREDIT_WINDOW_MS,
  EXPLORER_PAGES,
  TIMEOUT_MS,
  WAIT_MS,
  WEI_PER_LUX,
  allOpen,
  depositsIn,
  evmHashOf,
  groupBy,
  inOrder,
  messageOf,
  quantityOf,
  queued,
  reader,
  settle,
  urlOf,
  withPast,
} from "./bridge-common.js";

/** @typedef {import("./bridge.js").Arrival} Arrival */
/** @typedef {import("./bridge-common.js").Credit} Credit */
/** @typedef {import("./bridge-common.js").DepositItem} DepositItem */
/** @typedef {import("./bridge-common.js").Reader} Reader */
/** @typedef {import("./bridge-explorer.js").ExplorerDepositOptions} ExplorerDepositOptions */

/**
 * A Blockscout time ("2026-10-27T05:52:13.000000Z") in milliseconds.
 *
 * @param {unknown} text
 */
const timeOf = (text) => Date.parse(String(text ?? "").replace(/(\.\d{3})\d+/, "$1"));

/**
 * @param {ExplorerDepositOptions} options
 * @returns {Promise<{ arrivals: Map<string, Arrival>, requests: number }>}
 */
export async function depositArrivalsFromExplorer({
  network,
  deposits,
  fetch: fetchFn,
  explorerUrl,
  taken,
  now = Date.now(),
  waitMs = WAIT_MS,
  windowMs = CREDIT_WINDOW_MS,
  maxPages = EXPLORER_PAGES,
  timeoutMs = TIMEOUT_MS,
}) {
  const { evm, list, live, past, results, used } = depositsIn({ deposits, network, now, taken, waitMs });
  const read = reader(fetchFn, timeoutMs);

  if (evm) {
    const api = urlOf(explorerUrl, evm.blockscoutApiUrl, "DuskEVM explorer");

    await onExplorer(read, live, { api, bridge: evm.predeploys.l2StandardBridge.toLowerCase(), maxPages, now, past, results, used, windowMs });
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
