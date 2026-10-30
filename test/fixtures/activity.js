// Test helpers for `/activity`: the recorded Testnet history read as
// `/history` reads it, entries made from the fields a test is about, and the
// hook the wallets pass for the name service's calls, here from a table.

import { networks } from "@dusk-network/networks";

import { historyEntry, parseHistoryEntry } from "../../src/history.js";
import { NAME_CONTRACT, fixture } from "./helpers.js";

/** @typedef {import("../../src/history.js").ReadEntry} ReadEntry */
/** @typedef {import("../../src/activity.js").NameFacts} NameFacts */

// Recorded on Testnet: A called a name contract twice and received two
// transfers; B has years of transfers, contract calls, a shield, stake
// rewards and an unstake; C received an unshield.
export const [A, B, C] = Object.keys(fixture.accounts);
export const DUSK = 1_000_000_000n;
export const STORE = NAME_CONTRACT;
// DuskEVM's bridge and Portal, and Sozu's pool, on Testnet.
export const BRIDGE = "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d";
export const PORTAL = "14eeb3d4021aff09af2c515603a01f8d956a7f6411d11a1b1c0b0561a93fb1b9";
export const POOL = /** @type {string} */ (networks.testnet.sozu?.fallbacks.pool);
export const EVM = "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F";

/** @param {number} n */
export const hash = (n) => n.toString(16).padStart(2, "0").repeat(32);

/**
 * An account's recorded entry at a height, as `/history` reads it once its
 * details came, with `extra` kept beside it.
 *
 * @param {string} account
 * @param {number} height
 * @param {Record<string, unknown>} [extra]
 * @param {{ network?: any }} [options]
 * @returns {ReadEntry}
 */
export function recorded(account, height, extra = {}, { network = 2 } = {}) {
  const raw = [...fixture.accounts[account].sender, ...fixture.accounts[account].receiver].find((e) => e.block_height === height);
  const parsed = /** @type {import("../../src/history.js").HistoryEntry} */ (parseHistoryEntry(account, raw));
  const tx = fixture.details[parsed.hash];

  return historyEntry(
    {
      ...parsed,
      contractId: tx.tx.callData?.contractId,
      detailsAt: 1,
      error: tx.err ?? undefined,
      fee: String(tx.gasSpent * tx.tx.gasPrice),
      fnName: tx.tx.callData?.fnName,
      gasLimit: String(tx.tx.gasLimit),
      gasPrice: String(tx.tx.gasPrice),
      gasSpent: String(tx.gasSpent),
      success: !tx.err,
      timestamp: tx.blockTimestamp * 1000,
      value: parsed.value.toString(),
      ...extra,
    },
    { network }
  );
}

/**
 * A public entry as `/history` reads it, from the fields a test is about:
 * by default a transfer of nothing sent at height 4,687,000, its details read.
 *
 * @param {Record<string, unknown>} fields
 * @param {{ network?: any, pools?: string[] }} [options]
 * @returns {ReadEntry}
 */
export const entryOf = (fields, { network = 2, pools } = {}) =>
  historyEntry(
    /** @type {any} */ ({
      blockHeight: 4_687_000,
      counterparty: null,
      detailsAt: 1,
      direction: "out",
      hash: hash(0xaa),
      kind: "transfer",
      memo: "",
      payer: true,
      success: true,
      timestamp: Date.UTC(2026, 9, 26, 13, 32),
      value: "0",
      ...fields,
    }),
    { network, pools }
  );

/** The name contract's functions these tests read, by what they do. */
const NAME_KINDS = Object.freeze({ commit: "reservation", register: "registration", renew: "renewal" });

/**
 * The hook a wallet passes for the name service's calls: what a call to the
 * name contract does, by its function, and the name and the reservation the
 * wallet keeps of it, as either wallet keeps them (`registeredName` and
 * `reservation`, or a `nameCommit` with both).
 *
 * @param {{ log?: any[] }} [options]
 * @returns {(call: { contractId: string, fnName: string }, kept: Record<string, any>) => NameFacts | null}
 */
export const nameHook =
  ({ log } = {}) =>
  (call, kept) => {
    log?.push({ call, kept });

    if (call.contractId !== STORE) return null;

    return {
      kind: /** @type {Record<string, string>} */ (NAME_KINDS)[call.fnName] ?? "other",
      name: kept.registeredName ?? kept.nameCommit?.name,
      reservation: kept.reservation ?? kept.nameCommit?.reservation,
    };
  };
