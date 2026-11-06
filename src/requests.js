/* @ts-self-types="./requests.d.ts" */
/**
 * Payment requests, for both wallets: what came in for each request a wallet
 * made, and the payment a send would make again. The app keeps its requests
 * and its words; this says what matched.
 *
 * @module
 */

import { recipientKind } from "./payment-links.js";

/** @typedef {import("./activity.js").ActivityRow} ActivityRow */
/** @typedef {import("./requests.js").KeptRequest} KeptRequest */
/** @typedef {import("./requests.js").RequestMatch} RequestMatch */
/** @typedef {import("./requests.js").RequestPayment} RequestPayment */
/** @typedef {"amount" | "amount-memo" | "memo"} Matched */

/** How far a device's clock can be out from a block's: a payment this long before a request can be for it. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** How long after it went out a payment just like another is the same one again. */
export const AGAIN_MS = 10 * 60_000;

/** @param {string | null | undefined} memo */
const memoOf = (memo) => (memo ?? "").trim();

/**
 * What a row's transfer moved: its value, less the gas refund its transaction
 * paid to another account than its sender, which isn't the transfer's.
 *
 * @param {ActivityRow} row
 */
function movedBy(row) {
  const raw = /** @type {unknown} */ (row.entry?.refund);
  const refund = typeof raw === "bigint" ? raw : /^\d+$/.test(String(raw ?? "")) ? BigInt(String(raw)) : 0n;

  return row.value > refund ? row.value - refund : 0n;
}

/**
 * What a payment has of what a request asked: null for nothing, for a payment
 * that came before it, or for one to the profile's other address: a request
 * asks on its public account or on its shielded address, not on both. A
 * request of no amount asks for its memo with any amount: its memo is all of it.
 *
 * @param {KeptRequest} request
 * @param {ActivityRow} row
 * @returns {Matched | null}
 */
function matchOf(request, row) {
  const askedOn = recipientKind(request.to) === "shielded" ? "shielded" : "public";

  if (row.privacy !== askedOn || row.time === null || row.time === undefined || row.time < request.at - CLOCK_SKEW_MS) return null;

  const anyAmount = request.lux === null;
  const sameAmount = request.lux !== null && movedBy(row) === BigInt(request.lux);
  const sameMemo = request.memo !== "" && memoOf(row.memo) === request.memo;

  return (sameAmount || anyAmount) && sameMemo ? "amount-memo" : sameAmount ? "amount" : sameMemo ? "memo" : null;
}

/**
 * @param {ReadonlyArray<KeptRequest>} list
 * @param {ReadonlyArray<ActivityRow>} rows
 * @returns {Map<string, RequestMatch>}
 */
export function matchRequests(list, rows) {
  /** @type {Map<string, RequestMatch>} */
  const matches = new Map();
  const taken = new Set(list.flatMap(({ paid }) => (paid ? [paid.hash] : [])));
  // Only what went through: a row whose outcome isn't read, or a record that timed out unconfirmed, may have failed.
  const incoming = rows.filter(({ category, status }) => category === "received" && status === "executed").sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  const oldestFirst = [...list].sort((a, b) => a.at - b.at);

  /**
   * @param {KeptRequest} request
   * @param {"amount-memo" | "guess"} wanted
   */
  const answer = (request, wanted) => {
    for (const row of incoming) {
      const matched = taken.has(row.hash) ? null : matchOf(request, row);

      if (matched && (wanted === "guess") === (matched !== "amount-memo")) {
        taken.add(row.hash);
        matches.set(request.id, {
          at: row.time ?? undefined,
          hash: row.hash,
          lux: movedBy(row),
          matched,
          memo: memoOf(row.memo),
          state: matched === "amount-memo" ? "paid" : "check",
        });

        return;
      }
    }
  };

  for (const request of oldestFirst) {
    if (request.paid) {
      matches.set(request.id, { at: request.paid.at, hash: request.paid.hash, matched: "amount-memo", state: "paid" });
    } else {
      answer(request, "amount-memo");
    }
  }

  // What else came in for a request answered: it paid twice, or may have.
  /** @type {Map<string, RequestPayment[]>} */
  const extra = new Map();

  /**
   * Gives each request answered what else matches it: in full, or (`exact`
   * false) in part.
   *
   * @param {boolean} exact
   */
  const addMore = (exact) => {
    for (const request of oldestFirst) {
      const match = matches.get(request.id);

      for (const row of !match || match.state === "waiting" ? [] : incoming) {
        const matched = taken.has(row.hash) ? null : matchOf(request, row);

        if (matched && (matched === "amount-memo") === exact) {
          taken.add(row.hash);
          extra.set(request.id, [...(extra.get(request.id) ?? []), { at: row.time ?? undefined, hash: row.hash, lux: movedBy(row), matched, memo: memoOf(row.memo) }]);
        }
      }
    }
  };

  // A payment with all of a request paid it again: no other request takes it
  // as a guess.
  addMore(true);

  for (const request of oldestFirst) {
    if (!matches.has(request.id)) answer(request, "guess");
    if (!matches.has(request.id)) matches.set(request.id, { state: "waiting" });
  }

  addMore(false);

  for (const request of oldestFirst) {
    const match = /** @type {RequestMatch} */ (matches.get(request.id));
    const more = (extra.get(request.id) ?? []).sort((x, y) => (x.at ?? 0) - (y.at ?? 0));

    if (more.length) matches.set(request.id, { ...match, more });
  }

  return matches;
}

/**
 * @param {ReadonlyArray<ActivityRow>} rows
 * @param {{ lux: bigint, memo: string, now?: number, to: string }} payment
 * @returns {ActivityRow | null}
 */
export function sentAlready(rows, { lux, memo, now = Date.now(), to }) {
  const said = memoOf(memo);

  if (!to || lux <= 0n) return null;

  return (
    rows
      .filter(
        (row) =>
          row.direction === "out" &&
          row.status !== "failed" &&
          !row.dropped &&
          row.counterparty === to &&
          movedBy(row) === lux &&
          memoOf(row.memo) === said &&
          row.time !== null &&
          (said !== "" || now - row.time < AGAIN_MS)
      )
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))[0] ?? null
  );
}
