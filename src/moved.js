/**
 * What a row of `/activity` moved for its transfer, the one rule `/requests`
 * and `/bridge` read it by: its value, less the gas refund its transaction
 * paid to another account than its sender, which isn't the transfer's. Only
 * a value the chain gives holds such a refund: one from the wallet's record,
 * as a send's on chain before its details are read, holds none. Not an entry
 * point.
 *
 * @module
 */

/** @typedef {import("./activity.js").ActivityRow} ActivityRow */

/**
 * @param {ActivityRow} row
 * @returns {bigint}
 */
export function movedBy(row) {
  const sentAmount = /** @type {any} */ (row.sent)?.amount;
  // The chain's value: no record of the wallet's, the chain says it went through, or the record has no amount.
  const chains = !row.sent || row.entry?.success === true || sentAmount === undefined || sentAmount === null;
  const raw = /** @type {unknown} */ (chains ? row.entry?.refund : undefined);
  const refund = typeof raw === "bigint" ? raw : /^\d+$/.test(String(raw ?? "")) ? BigInt(String(raw)) : 0n;

  return row.value > refund ? row.value - refund : 0n;
}
