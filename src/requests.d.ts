/**
 * Payment requests, for both wallets: what came in for each request a wallet
 * made, and the payment a send would make again. The app keeps its requests,
 * its storage and its words; this says what matched.
 *
 * What came in only ever says what matched. "paid" takes the amount and the
 * memo asked, both, in one payment, or the memo of a request that asked no
 * amount; anything less is a payment to check, never a request paid.
 *
 * @example
 * ```js
 * import { matchRequests, sentAlready } from "@dusk/app-core/requests";
 *
 * const matches = matchRequests(kept, rows); // the wallet's requests, `/activity`'s rows
 * matches.get(id); // { state: "paid", matched: "amount-memo", hash, at, lux, memo, more: [{ … }] }
 *
 * // Before a send: the same payment, made already.
 * sentAlready(rows, { to, lux, memo }); // the row of the payment it would make again, or null
 * ```
 *
 * @module
 */

import type { ActivityRow } from "./activity.js";

/** How far a device's clock can be out from a block's: a payment this long before a request can be for it, 5 minutes, in milliseconds. */
export declare const CLOCK_SKEW_MS: 300000;

/** How long after it went out a payment just like another, memo aside, is the same one again: 10 minutes, in milliseconds. */
export declare const AGAIN_MS: 600000;

/**
 * A request as a wallet keeps it: `lux` as a decimal string, null for any
 * amount; `at` when it was first asked, in milliseconds; `paid` the payment
 * that paid it, kept once it did, for it to stay paid once that payment is
 * too far back to be read again.
 */
export type KeptRequest = {
  id: string;
  /** The account or shielded address it asks on. */
  to: string;
  lux: string | null;
  memo: string;
  /** The network it's for, as the wallet names it. */
  network?: string;
  at: number;
  paid?: { at: number; hash: string };
};

/**
 * What of a request a payment has: "amount-memo", the amount and the memo
 * asked, or the memo of a request that asked no amount; "amount" or "memo",
 * only that.
 */
export type RequestMatched = "amount" | "amount-memo" | "memo";

/** A payment that came in for a request, with what of it matched. */
export type RequestPayment = {
  at?: number;
  hash: string;
  lux: bigint;
  matched: RequestMatched;
  memo: string;
};

/**
 * What came in for a request:
 * - "paid": a payment with all it asked (`matched` "amount-memo");
 * - "check": a payment with what `matched` says: not the whole of it, or a
 *   request asking too little to tell, as an amount alone;
 * - "waiting": none yet.
 *
 * `more` holds the other payments that match it, oldest first, which no other
 * request took: one with all of it again (`matched` "amount-memo") is the
 * request paid twice.
 */
export type RequestMatch = {
  state: "check" | "paid" | "waiting";
  at?: number;
  hash?: string;
  lux?: bigint;
  matched?: RequestMatched;
  memo?: string;
  more?: RequestPayment[];
};

/**
 * What came in for each request, by its ID, from `/activity`'s rows: a
 * payment received that went through (`executed`: what's on its way or whose
 * outcome isn't read may yet fail), by what its transfer paid, without a gas
 * refund its transaction paid with it, to the address a request asked on (a
 * public payment for a request on the account, a shielded one for a request
 * on the shielded address), from 5 minutes before it was asked on. Each
 * payment answers one request: one with all of a request goes to the oldest
 * request it pays in full, before any matches less, and a request already
 * paid keeps its payment.
 */
export declare function matchRequests(requests: ReadonlyArray<KeptRequest>, rows: ReadonlyArray<ActivityRow>): Map<string, RequestMatch>;

/**
 * The latest payment a send would make again: out from this profile, not
 * failed or dropped (on its way counts), to the same recipient, of the same
 * amount (its transfer's, without a gas refund to another account) and with the same memo,
 * in the last 10 minutes, or at any time with a memo, as a request paid
 * already. Null for none, and for no recipient or no amount.
 */
export declare function sentAlready(
  rows: ReadonlyArray<ActivityRow>,
  payment: { to: string; lux: bigint; memo: string; now?: number }
): ActivityRow | null;
