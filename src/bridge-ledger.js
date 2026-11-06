/**
 * One transfer's ledger, for `/bridge`: what was sent, the bridge's fee, the
 * network's fee, what was received and the gas paid on the other chain, each
 * exact and in the short form a row shows. Not an entry point.
 *
 * @module
 */

import { routes } from "@dusk-network/networks";

import { amountLocale, formatAmount } from "./amounts.js";
import { luxOf, networkOf } from "./bridge-common.js";

/** @typedef {import("./activity.js").ActivityRow} ActivityRow */
/** @typedef {import("./bridge.js").LedgerInput} LedgerInput */
/** @typedef {import("./bridge.js").LedgerLine} LedgerLine */
/** @typedef {import("./bridge.js").MigrationEvm} MigrationEvm */
/** @typedef {import("./bridge.js").TransferLedger} TransferLedger */
/** @typedef {import("@dusk-network/networks").Route} Route */

const LUX_DECIMALS = 9;
const WEI_DECIMALS = 18;

/**
 * Lux from what an app keeps of an amount, or null.
 *
 * @param {unknown} value
 */
const known = (value) => (value === undefined || value === null || value === "" ? null : luxOf(value));

/**
 * What a row of `/activity` says of the transfer it's part of. What left the
 * account holds a gas refund it paid another account, and what reached it one
 * paid to it: neither is the transfer's.
 *
 * @param {ActivityRow} row
 * @returns {{ kind: Route["kind"] | null, route: Route | null, sent: bigint | null, received: bigint | null }}
 */
function factsOfRow(row) {
  const refund = luxOf(row.entry?.refund) ?? 0n;
  const moved = row.value > refund ? row.value - refund : 0n;
  const step = row.bridge?.step;

  if (step === "deposit") return { kind: "duskevm-deposit", received: null, route: null, sent: known(row.bridge?.amount) ?? row.value };
  if (step === "withdrawal") return { kind: "duskevm-withdrawal", received: row.value, route: null, sent: null };
  if (step === "proof" || step === "claim") return { kind: "duskevm-withdrawal", received: null, route: null, sent: null };
  if (row.route?.kind === "service") return { kind: "service", received: null, route: row.route, sent: moved };
  if (row.route?.kind === "migration") return { kind: "migration", received: moved, route: row.route, sent: null };

  return { kind: null, received: null, route: null, sent: null };
}

/**
 * The route named, as the network's file has it where it's asked by its ID.
 *
 * @param {unknown} route
 * @param {unknown} network
 * @param {Route["kind"] | null} kind
 * @returns {Route | null}
 */
function routeOf(route, network, kind) {
  const id = typeof route === "string" ? route : /** @type {any} */ (route)?.id;
  const given = route && typeof route === "object" && /** @type {any} */ (route).kind ? /** @type {Route} */ (route) : null;

  if (given || network === undefined || network === null) return given;

  return routes(networkOf(/** @type {any} */ (network))).find((each) => (id ? each.id === id : each.kind === kind)) ?? null;
}

/**
 * @param {LedgerInput} [input]
 * @returns {TransferLedger | null}
 */
export function transferLedger({ arrival, bridgeFee, evm, failed, gasWei, locale = amountLocale(), network, networkFee, received, route, row, sent } = {}) {
  const fromRow = row ? factsOfRow(row) : null;
  const chosen = routeOf(route ?? fromRow?.route ?? evm?.route, network, fromRow?.kind ?? (evm ? "migration" : null));
  const kind = chosen?.kind ?? fromRow?.kind ?? null;

  if (!kind) return null;

  const coin = "DUSK";
  const token = chosen?.chain && "tokenLabel" in chosen.chain ? chosen.chain.tokenLabel : undefined;
  const fees = (networkFee === undefined ? [row?.fee] : Array.isArray(networkFee) ? networkFee : [networkFee]).map(known).filter((fee) => fee !== null);
  // A migration's side on its own chain, as `migrationFacts` read it.
  const ownChain = kind === "migration" && evm && (evm.state === "mined" || evm.state === "failed") ? evm : null;
  const wentThrough = !(failed ?? (row?.status === "failed" || ownChain?.state === "failed"));
  const bridgeCut = kind === "service" ? (known(bridgeFee) ?? (chosen?.kind === "service" ? chosen.feeLux : null)) : null;
  const toSend = known(sent) ?? ownChain?.lux ?? fromRow?.sent ?? null;
  const arrived = arrival?.state === "arrived" ? arrival.amount : null;
  const paidNothing = arrival?.state === "unknown" && arrival.reason === "no-payout";
  const paid = known(received) ?? arrived ?? (paidNothing ? 0n : null) ?? fromRow?.received ?? null;
  const worked = toSend === null ? null : bridgeCut === null ? toSend : toSend > bridgeCut ? toSend - bridgeCut : 0n;

  /**
   * @param {LedgerLine["key"]} key
   * @param {bigint | null} amount
   * @param {{ decimals?: number, unit?: string, round?: "down" | "nearest", expected?: boolean }} [how]
   * @returns {LedgerLine | null}
   */
  const line = (key, amount, { decimals = LUX_DECIMALS, unit = coin, round = "down", expected = false } = {}) =>
    amount === null ? null : { amount, coin: unit, decimals, expected, key, ...formatAmount(amount, { decimals, locale, round }) };
  // The gas of a migration's own chain: the approval it spent with it, where that's its own.
  const chainGas = known(gasWei) === null && ownChain?.totalWei !== undefined && ownChain.totalWei !== null ? ownChain.totalWei : null;
  const gasLine = line("gas", known(gasWei) ?? chainGas, { decimals: WEI_DECIMALS, round: "nearest", unit: chosen?.chain?.currency?.symbol ?? ownChain?.coin ?? coin });

  const parts = {
    bridgeFee: wentThrough ? line("bridgeFee", bridgeCut, { round: "nearest" }) : null,
    gas: gasLine && chainGas !== null && ownChain ? { ...gasLine, parts: ownChain.approvalState === "found" ? /** @type {const} */ (["approval", "migration"]) : /** @type {const} */ (["migration"]) } : gasLine,
    networkFee: line("networkFee", fees.length ? fees.reduce((sum, fee) => sum + fee, 0n) : null, { round: "nearest" }),
    received: wentThrough ? line("received", paid ?? worked, { expected: paid === null, unit: kind === "service" ? (token ?? coin) : coin }) : null,
    sent: wentThrough ? line("sent", toSend ?? (kind === "migration" ? paid : null), { unit: kind === "migration" ? (token ?? coin) : coin }) : null,
  };

  return {
    arrived: wentThrough && paid !== null,
    failed: !wentThrough,
    kind,
    lines: [parts.sent, parts.bridgeFee, parts.networkFee, parts.received, parts.gas].filter((each) => each !== null),
    route: chosen?.id ?? null,
    ...parts,
  };
}
