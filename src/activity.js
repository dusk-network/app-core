/* @ts-self-types="./activity.d.ts" */
/**
 * An account's activity: its public history, its shielded history and the
 * wallet's own records of what it sent, merged into rows of facts, one per
 * transaction, newest first. Nothing here keeps state or does any I/O.
 *
 * @module
 */

import { networkFor, routeForAccount } from "@dusk-network/networks";
import { isAccount } from "@dusk-network/networks/account";
import { BRIDGE_FUNCTIONS, isBridgeContract } from "@dusk-network/networks/duskevm";
import { SOZU_FN, isSozuCall } from "@dusk-network/networks/sozu";

import { ENTRY_KIND, TRANSFER_CONTRACT } from "./history.js";

/** @typedef {import("./activity.js").ActivityBridge} ActivityBridge */
/** @typedef {import("./activity.js").ActivityCategory} ActivityCategory */
/** @typedef {import("./activity.js").ActivityInput} ActivityInput */
/** @typedef {import("./activity.js").ActivityRow} ActivityRow */
/** @typedef {import("./activity.js").ActivityStatus} ActivityStatus */
/** @typedef {import("./activity.js").NameFacts} NameFacts */
/** @typedef {import("./activity.js").SentTransaction} SentTransaction */
/** @typedef {import("./activity.js").SettleInput} SettleInput */
/** @typedef {import("./shielded.js").ShieldedEntry} ShieldedEntry */
/** @typedef {import("./history.js").BridgeFacts} BridgeFacts */
/** @typedef {import("./history.js").Direction} Direction */
/** @typedef {import("./history.js").EntryKind} EntryKind */
/** @typedef {import("./history.js").ReadEntry} ReadEntry */
/** @typedef {import("@dusk-network/networks").Network} Network */
/** @typedef {import("@dusk-network/networks").NetworkRef} NetworkRef */
/** @typedef {import("@dusk-network/networks").Route} Route */

export const PENDING_MS = 15 * 60_000;

/** Blocks come about every 10 seconds. */
const BLOCK_MS = 10_000;
const MAX_U64 = (1n << 64n) - 1n;
/** @type {ReadonlySet<string>} */
const KINDS = new Set(Object.values(ENTRY_KIND));
/** @type {ReadonlySet<string>} */
const DIRECTIONS = new Set(["in", "out", "self"]);
/** @type {ReadonlySet<string>} */
const STAKING = new Set([ENTRY_KIND.STAKE, ENTRY_KIND.UNSTAKE, ENTRY_KIND.WITHDRAW_REWARD]);
/** @type {ReadonlySet<string>} */
const SHIELDING = new Set([ENTRY_KIND.SHIELD, ENTRY_KIND.UNSHIELD]);
/** Kinds that say no more than that DUSK moved or a contract was called. @type {ReadonlySet<string>} */
const GENERIC = new Set([ENTRY_KIND.TRANSFER, ENTRY_KIND.CONTRACT_CALL]);
/** Kinds whose value comes back to the account. @type {ReadonlySet<string>} */
const COMING_BACK = new Set([ENTRY_KIND.UNSHIELD, ENTRY_KIND.UNSTAKE, ENTRY_KIND.WITHDRAW_REWARD]);
/** @type {ReadonlySet<string>} */
const CLAIMS = new Set([BRIDGE_FUNCTIONS.claim, BRIDGE_FUNCTIONS.claimWithProofOf]);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * Lux from a bigint or its decimal text: 0n for anything else.
 *
 * @param {unknown} value
 * @returns {bigint}
 */
function lux(value) {
  if (typeof value === "bigint") return value >= 0n && value <= MAX_U64 ? value : 0n;

  const text = String(value ?? "").trim();

  if (!/^\d+$/.test(text)) return 0n;

  const n = BigInt(text);

  return n <= MAX_U64 ? n : 0n;
}

/**
 * @param {unknown} value
 * @returns {bigint | null}
 */
const luxOrNull = (value) => (value === undefined || value === null || value === "" ? null : lux(value));

/**
 * @param {unknown} value
 * @returns {string | null}
 */
const textOf = (value) => (typeof value === "string" && value.trim() ? value : null);

/** @param {unknown} hash */
const lower = (hash) => String(hash ?? "").trim().toLowerCase();

/**
 * A time in milliseconds, or null.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
const timeOf = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/**
 * A block height from a number or its text, or null.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function heightOf(value) {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;

  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * A contract ID as the histories keep them, lower case without 0x; any
 * other text as it is.
 *
 * @param {unknown} id
 * @returns {string | null}
 */
function contractIdOf(id) {
  const text = textOf(id)?.trim() ?? null;
  const hex = text?.toLowerCase().replace(/^0x/, "") ?? "";

  return /^[0-9a-f]{64}$/.test(hex) ? hex : text;
}

/**
 * @param {unknown} kind
 * @returns {EntryKind | null}
 */
const kindOf = (kind) => (typeof kind === "string" && KINDS.has(kind) ? /** @type {EntryKind} */ (kind) : null);

/**
 * @param {unknown} direction
 * @returns {Direction}
 */
const directionOf = (direction) => (typeof direction === "string" && DIRECTIONS.has(direction) ? /** @type {Direction} */ (direction) : "out");

/**
 * The network a reference names, or null.
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
 * Decoded facts of a bridge call, or null for anything else.
 *
 * @param {unknown} facts
 * @returns {BridgeFacts | null}
 */
const bridgeFactsOf = (facts) =>
  facts && typeof facts === "object" && ["deposit", "prove", "claim"].includes(/** @type {any} */ (facts).kind)
    ? /** @type {BridgeFacts} */ (facts)
    : null;

// ---------------------------------------------------------------------------
// What each source says
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   kind: EntryKind | null,
 *   direction: Direction,
 *   value: bigint,
 *   counterparty: string | null,
 *   contractId: string | null,
 *   fnName: string | null,
 *   fee: bigint | null,
 *   success: boolean | null,
 *   error: string | null,
 *   memo: string | null,
 *   time: number | null,
 *   blockHeight: number | null,
 *   blockHash: string | null,
 *   detailsAt: number | null,
 *   gasLimit: bigint | null,
 *   gasPrice: bigint | null,
 *   gasSpent: bigint | null,
 *   bridge: BridgeFacts | null,
 *   route: Route | null | undefined,
 *   sozu: boolean,
 *   privacy: "public" | "shielded",
 * }} ChainFacts
 */

/**
 * What the public history says of a transaction, and the fee its shielded
 * side paid where the public side paid none. A call this account made reads
 * as a transfer until its details come, and then as the call: its value sent
 * to its own account moved nothing.
 *
 * @param {ReadEntry} entry
 * @param {ShieldedEntry | undefined} shielded
 * @returns {ChainFacts}
 */
function publicFacts(entry, shielded) {
  const read = kindOf(entry.kind);
  const contractId = contractIdOf(entry.contractId);
  const fnName = textOf(entry.fnName);
  const call = read === ENTRY_KIND.TRANSFER && entry.direction !== "in" && Boolean(contractId && fnName);
  const self = call && entry.direction === "self";
  const kind = call ? ENTRY_KIND.CONTRACT_CALL : read;
  const counterparty = textOf(entry.counterparty);
  // Before its details, a call is known by the contract it paid a deposit.
  const paid = kind === ENTRY_KIND.CONTRACT_CALL ? contractIdOf(counterparty) : null;

  return {
    blockHash: textOf(entry.blockHash),
    blockHeight: heightOf(entry.blockHeight),
    bridge: bridgeFactsOf(entry.bridge),
    contractId: contractId ?? (paid && /^[0-9a-f]{64}$/.test(paid) ? paid : null),
    counterparty,
    detailsAt: timeOf(entry.detailsAt),
    direction: self ? "out" : directionOf(entry.direction),
    error: entry.success === false ? textOf(entry.error) : shielded?.success === false && typeof entry.success !== "boolean" ? textOf(shielded.error) : null,
    fee: luxOrNull(entry.fee) ?? (shielded ? luxOrNull(shielded.fee) : null),
    fnName,
    gasLimit: luxOrNull(entry.gasLimit),
    gasPrice: luxOrNull(entry.gasPrice),
    gasSpent: luxOrNull(entry.gasSpent),
    kind,
    memo: textOf(entry.memo),
    privacy: "public",
    route: entry.route,
    sozu: entry.sozu === true,
    // Until the public side's details are read, the shielded side's outcome and time.
    success: typeof entry.success === "boolean" ? entry.success : typeof shielded?.success === "boolean" ? shielded.success : null,
    time: timeOf(entry.timestamp) ?? (shielded ? timeOf(shielded.timestamp) : null),
    value: self ? 0n : lux(entry.value),
  };
}

/**
 * What the shielded history says of a transaction.
 *
 * @param {ShieldedEntry} entry
 * @returns {ChainFacts}
 */
function shieldedFacts(entry) {
  return {
    blockHash: null,
    blockHeight: heightOf(entry.blockHeight),
    bridge: null,
    contractId: null,
    counterparty: null,
    detailsAt: null,
    direction: directionOf(entry.direction),
    error: entry.success === false ? textOf(entry.error) : null,
    fee: luxOrNull(entry.fee),
    fnName: null,
    gasLimit: null,
    gasPrice: null,
    gasSpent: null,
    kind: kindOf(entry.kind),
    memo: null,
    privacy: "shielded",
    route: undefined,
    sozu: false,
    success: typeof entry.success === "boolean" ? entry.success : null,
    time: timeOf(entry.timestamp),
    value: lux(entry.value),
  };
}

/**
 * The status a send shows by itself: on its way until the wallet stops
 * waiting for the chain, after PENDING_MS; dropped when the node took it
 * out of its queue.
 *
 * @param {SentTransaction} sent
 * @param {number} now
 * @returns {{ status: ActivityStatus, dropped: boolean }}
 */
function sentStatus(sent, now) {
  const status = String(sent.status ?? "submitted").toLowerCase();

  if (status === "executed" || status === "failed") return { dropped: false, status };
  if (status === "removed") return { dropped: true, status: "unknown" };
  if (status === "unknown") return { dropped: false, status: "unknown" };

  const at = timeOf(sent.submittedAt);
  // Any status still waiting stops after PENDING_MS, but one seen in the node's queue.
  const waited = status !== "mempool" && !sent.settled && at !== null && now - at >= PENDING_MS;

  return { dropped: false, status: waited ? "unknown" : "pending" };
}

/**
 * What the wallet's record of a send says: its direction, by its kind and
 * its receiver when the record doesn't say; what it moved, a call's deposit
 * and what it transfers to another account; and, for the row's direction,
 * whom it pays or who paid it, as the chain will name them.
 *
 * @param {SentTransaction} sent
 * @param {ReadonlySet<string>} own
 * @param {number} now
 */
function sentFacts(sent, own, now) {
  const kind = kindOf(sent.kind);
  const contractId = contractIdOf(sent.contractId);
  const fnName = textOf(sent.fnName);
  const to = textOf(sent.to);
  const from = textOf(sent.from);
  /** @type {Direction} */
  const direction = typeof sent.direction === "string" && DIRECTIONS.has(sent.direction)
    ? /** @type {Direction} */ (sent.direction)
    : (kind !== null && COMING_BACK.has(kind)) || fnName === SOZU_FN.UNSTAKE
      ? "in"
      : kind === ENTRY_KIND.TRANSFER && to !== null && own.has(to)
        ? "self"
        : "out";
  const amount = lux(sent.amount);
  const named = sent.deposit !== undefined && sent.deposit !== null;
  let deposit = lux(sent.deposit);
  let value;

  if (kind === ENTRY_KIND.CONTRACT_CALL) {
    // What a call moves: its deposit, and what it transfers to another
    // account. A record that names neither pays its contract its amount.
    if (!named && to === null) deposit = amount;
    value = deposit + (to !== null && !own.has(to) ? amount : 0n);
  } else {
    value = deposit > 0n ? deposit : amount;
  }

  /**
   * @param {Direction} way
   * @returns {string | null}
   */
  const counterparty = (way) => {
    if (way === "in") return from;
    if (kind === ENTRY_KIND.CONTRACT_CALL) return deposit > 0n && contractId ? contractId : to !== null && !own.has(to) ? to : null;

    return to;
  };

  return {
    blockHash: textOf(sent.blockHash),
    blockHeight: heightOf(sent.blockHeight),
    bridge: bridgeFactsOf(sent.bridge),
    contractId,
    counterparty,
    direction,
    error: textOf(sent.error),
    fee: luxOrNull(sent.feePaid),
    fnName,
    gasLimit: luxOrNull(sent.gasLimit),
    gasPrice: luxOrNull(sent.gasPrice),
    gasSpent: luxOrNull(sent.gasSpent),
    // Whether it says what it moves: else the chain's value stands.
    hasValue: (sent.amount !== undefined && sent.amount !== null) || named,
    kind,
    memo: textOf(sent.memo),
    privacy: sent.privacy === "public" || sent.privacy === "shielded" ? sent.privacy : null,
    profileIndex: typeof sent.profileIndex === "number" && Number.isFinite(sent.profileIndex) ? sent.profileIndex : null,
    submittedAt: timeOf(sent.submittedAt),
    time: timeOf(sent.timestamp) ?? timeOf(sent.finalizedAt) ?? timeOf(sent.executedAt) ?? timeOf(sent.submittedAt),
    toName: textOf(sent.toName),
    value,
    ...sentStatus(sent, now),
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * The filter a row is under.
 *
 * @param {{ kind: EntryKind | null, direction: Direction, sozu: unknown, bridge: unknown, route: unknown }} row
 * @returns {ActivityCategory}
 */
function categoryOf({ bridge, direction, kind, route, sozu }) {
  if (kind !== null && STAKING.has(kind)) return "staking";
  if (kind !== null && SHIELDING.has(kind)) return "other";
  if (sozu) return "staking";
  if (bridge || route) return "bridge";
  if (kind === null || direction === "self") return "other";

  return direction === "in" ? "received" : "sent";
}

/**
 * What a call to DuskEVM's bridge or Portal did for the account: DUSK it
 * received is a withdrawal's, DUSK it sent a deposit, as is a call that
 * reads as one; else the proof or the claim its call, or its function,
 * names.
 *
 * @param {{ direction: Direction, value: bigint, fnName: string | null, call: BridgeFacts | null }} row
 * @returns {ActivityBridge}
 */
function bridgeOf({ call, direction, fnName, value }) {
  const step =
    direction === "in"
      ? "withdrawal"
      : value > 0n || call?.kind === "deposit"
        ? "deposit"
        : call?.kind === "prove" || fnName === BRIDGE_FUNCTIONS.prove
          ? "proof"
          : call?.kind === "claim" || (fnName !== null && CLAIMS.has(fnName))
            ? "claim"
            : "call";
  const withdrawal = call && call.kind !== "deposit" ? call : null;
  const hash = withdrawal && EVM_HASH.test(String(withdrawal.hash ?? "")) ? /** @type {`0x${string}`} */ (withdrawal.hash.toLowerCase()) : null;

  return {
    amount: call ? luxOrNull(call.amount) : null,
    arrival: null,
    claim: null,
    claimed: false,
    hash,
    nonce: withdrawal ? textOf(withdrawal.withdrawal) : null,
    recipient: withdrawal ? textOf(withdrawal.recipient) : null,
    step,
    to: call?.kind === "deposit" && EVM_ADDRESS.test(String(call.to ?? "")) ? call.to : null,
  };
}

/**
 * What the app's hook says of a call, its own error a call it doesn't read.
 *
 * @param {ActivityInput["nameCall"]} hook
 * @param {{ contractId: string, fnName: string }} call
 * @param {ReadEntry | SentTransaction} kept
 * @returns {NameFacts | null}
 */
function nameFactsOf(hook, call, kept) {
  try {
    const facts = hook?.(call, kept);

    return facts && typeof facts === "object" && typeof facts.kind === "string" ? facts : null;
  } catch {
    return null;
  }
}

/**
 * Whether `later` comes after `row` in the account's activity: by their
 * blocks, else by their times, else a row not in a block yet comes after
 * one that is.
 *
 * @param {ActivityRow} later
 * @param {ActivityRow} row
 */
function comesAfter(later, row) {
  if (later.blockHeight !== null && row.blockHeight !== null) return later.blockHeight > row.blockHeight;
  if (later.time !== null && row.time !== null) return later.time > row.time;

  return later.blockHeight === null && row.blockHeight !== null;
}

/**
 * The rows, newest first, as `activity.d.ts` says.
 *
 * @param {ActivityInput} [input]
 * @returns {ActivityRow[]}
 */
export function activityRows({
  public: entries,
  shielded,
  pending,
  account = null,
  address = null,
  profileIndex = null,
  network = null,
  pools,
  names,
  nameCall,
  claims,
  arrivals,
  state = null,
  now = Date.now(),
} = {}) {
  const net = networkOf(network);
  const poolList = pools === undefined || pools === null ? [] : Array.from(pools);
  /** @type {ReadonlySet<string>} */
  const own = new Set([account, address].flatMap((id) => (typeof id === "string" && id !== "" ? [id] : [])));

  /** @type {Map<string, { entry?: ReadEntry, shielded?: ShieldedEntry }>} */
  const chain = new Map();

  for (const entry of entries ?? []) {
    const hash = lower(entry?.hash);

    if (hash && !chain.has(hash)) chain.set(hash, { entry });
  }

  for (const entry of shielded ?? []) {
    const hash = lower(entry?.hash);
    const known = hash ? chain.get(hash) : undefined;

    if (!hash) continue;
    if (!known) chain.set(hash, { shielded: entry });
    else known.shielded ??= entry;
  }

  /** @type {Map<string, SentTransaction>} */
  const sends = new Map();

  for (const sent of pending ?? []) {
    const hash = lower(sent?.hash);
    const idx = sent?.profileIndex;
    const otherProfile = idx !== undefined && idx !== null && profileIndex !== undefined && profileIndex !== null && Number(idx) !== Number(profileIndex);

    // A send kept only for what the chain's row lacks shows with that row.
    if (!hash || otherProfile || sends.has(hash) || (sent.settled && !chain.has(hash))) continue;
    sends.set(hash, sent);
  }

  /** @type {ActivityRow[]} */
  const rows = [];
  /** @type {Map<ActivityRow, BridgeFacts | null>} */
  const calls = new Map();
  /** @type {Map<number, number>} */
  const blockTimes = new Map();

  for (const hash of new Set([...chain.keys(), ...sends.keys()])) {
    const known = chain.get(hash);
    const sent = sends.get(hash) ?? null;
    const c = known?.entry ? publicFacts(known.entry, known.shielded) : known?.shielded ? shieldedFacts(known.shielded) : null;
    const s = sent ? sentFacts(sent, own, now) : null;
    const contractId = c?.contractId ?? s?.contractId ?? null;
    const fnName = c?.fnName ?? s?.fnName ?? null;
    const direction = /** @type {Direction} */ (c ? c.direction : s?.direction);
    // The chain's kind when it names a shield, an unshield or a stake
    // operation; else what the wallet sent, which the chain may name less
    // closely. A call of the transfer contract's convert that isn't coming
    // back is a shield.
    let kind = c?.kind && !GENERIC.has(c.kind) ? c.kind : (s?.kind ?? c?.kind ?? null);

    if (kind === ENTRY_KIND.CONTRACT_CALL && contractId === TRANSFER_CONTRACT && fnName === "convert" && direction !== "in") {
      kind = ENTRY_KIND.SHIELD;
    }

    const counterparty = c?.counterparty ?? s?.counterparty(direction) ?? null;
    // Unless it went through, its value didn't move on chain: what it was sent with shows.
    const value = !c ? /** @type {bigint} */ (s?.value) : c.success === true || !s?.hasValue ? c.value : s.value;

    /** @type {ActivityStatus} */
    let status = "unknown";
    let error = null;
    let dropped = false;

    if (c && c.success !== null) {
      status = c.success ? "executed" : "failed";
      error = c.error;
    } else if (s && c) {
      // Final on chain: the outcome the wallet saw it end with, else unknown until its details come.
      status = s.status === "executed" || s.status === "failed" ? s.status : "unknown";
      error = s.status === "failed" ? s.error : null;
    } else if (s) {
      ({ dropped, status } = s);
      error = s.error;
    }

    const route =
      kind !== ENTRY_KIND.TRANSFER || (direction !== "in" && direction !== "out") || !counterparty
        ? null
        : c?.route != null && c.kind === ENTRY_KIND.TRANSFER && c.direction === direction && c.counterparty === counterparty
          ? c.route
          : net
            ? routeForAccount(net, counterparty, direction)
            : null;
    const sozuCall = Boolean(c?.sozu) || Boolean(net && isSozuCall(net, { contractId, fnName }, { pools: poolList }));
    const call = c?.bridge ?? s?.bridge ?? null;
    const touchesBridge =
      (Boolean(call) || Boolean(net && [contractId, counterparty].some((id) => isBridgeContract(/** @type {Network} */ (net), id)))) &&
      // What came in from an account isn't the bridge's, whatever its
      // transaction called: a gas refund from another account's call to the
      // bridge is a transfer from that account.
      !(direction === "in" && isAccount(counterparty));
    const bridge = touchesBridge ? bridgeOf({ call, direction, fnName, value }) : null;

    /** @type {ActivityRow["nameCall"]} */
    let named = null;

    if (nameCall && kind === ENTRY_KIND.CONTRACT_CALL && contractId) {
      const asked = { contractId, fnName: fnName ?? "" };
      const fromChain = known?.entry ? nameFactsOf(nameCall, asked, known.entry) : null;
      const fromSent = sent ? nameFactsOf(nameCall, asked, sent) : null;
      const facts = fromChain ?? fromSent;
      /** @param {"name" | "reservation"} field */
      const pick = (field) => textOf(fromChain?.[field] !== undefined ? fromChain[field] : fromSent?.[field]);

      if (facts) named = { kind: facts.kind, name: pick("name"), reservation: pick("reservation") };
    }

    const verified = counterparty ? names?.get(counterparty) : undefined;
    const sozu = sozuCall ? (fnName === SOZU_FN.UNSTAKE ? "unstake" : "stake") : null;

    /** @type {ActivityRow} */
    const row = {
      blockHash: c ? c.blockHash : (s?.blockHash ?? null),
      blockHeight: c ? c.blockHeight : (s?.blockHeight ?? null),
      bridge,
      category: categoryOf({ bridge, direction, kind, route, sozu }),
      contractId,
      counterparty,
      counterpartyName: typeof verified === "string" ? verified : null,
      detailsAt: c?.detailsAt ?? null,
      direction,
      dropped,
      entry: known?.entry ?? null,
      error,
      fee: c && c.success !== null ? c.fee : (c?.fee ?? s?.fee ?? null),
      fnName,
      gasLimit: c?.gasLimit ?? s?.gasLimit ?? null,
      gasPrice: c?.gasPrice ?? s?.gasPrice ?? null,
      gasSpent: c && c.success !== null ? c.gasSpent : (c?.gasSpent ?? s?.gasSpent ?? null),
      hash,
      incomplete: false,
      kind,
      memo: c?.memo ?? s?.memo ?? null,
      nameCall: named,
      privacy: s?.privacy ?? (kind === ENTRY_KIND.UNSHIELD && known?.shielded ? "shielded" : c?.privacy) ?? "public",
      profileIndex: s?.profileIndex ?? null,
      route,
      sent,
      source: known?.entry ? "public" : known?.shielded ? "shielded" : "sent",
      sozu,
      status,
      submittedAt: s?.submittedAt ?? null,
      success: c ? c.success : null,
      time: c?.time ?? s?.time ?? null,
      toName: s?.toName ?? null,
      value,
    };

    if (c?.time !== null && c?.time !== undefined && c.blockHeight !== null && !blockTimes.has(c.blockHeight)) {
      blockTimes.set(c.blockHeight, c.time);
    }

    calls.set(row, call);
    rows.push(row);
  }

  // The rows of one block share its time.
  for (const row of rows) {
    if (row.time === null && row.blockHeight !== null) row.time = blockTimes.get(row.blockHeight) ?? null;
    row.incomplete = row.time === null || (row.source === "public" && row.success === null);
  }

  nameReservations(rows);
  settleWithdrawals(rows, calls, claims, arrivals);

  /** @param {ActivityRow} row */
  const sortTime = (row) =>
    row.time ??
    (state && timeOf(state.headAt) !== null && Number.isFinite(state.finalized) && row.blockHeight !== null
      ? state.headAt - Math.max(0, state.finalized - row.blockHeight) * BLOCK_MS
      : 0);

  return rows.sort(
    (a, b) =>
      sortTime(b) - sortTime(a) ||
      (b.blockHeight ?? 0) - (a.blockHeight ?? 0) ||
      (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
  );
}

/**
 * Names each reservation by a registration after it with the same reservation.
 *
 * @param {ActivityRow[]} rows
 */
function nameReservations(rows) {
  const registrations = rows.filter((row) => row.nameCall?.kind === "registration" && row.nameCall.reservation && row.nameCall.name);

  if (!registrations.length) return;

  for (const row of rows) {
    const reservation = row.nameCall?.kind === "reservation" && !row.nameCall.name ? row.nameCall.reservation : null;
    const by = reservation ? registrations.find((r) => r.nameCall?.reservation === reservation && comesAfter(r, row)) : undefined;

    if (by && row.nameCall) row.nameCall = { ...row.nameCall, name: by.nameCall?.name ?? null };
  }
}

/**
 * A proof's withdrawal, claimed by a claim of this activity that went
 * through, is on its way or is on chain, or as the app read it; and a
 * deposit's arrival on DuskEVM.
 *
 * @param {ActivityRow[]} rows
 * @param {Map<ActivityRow, BridgeFacts | null>} calls
 * @param {ActivityInput["claims"]} claims
 * @param {ActivityInput["arrivals"]} arrivals
 */
function settleWithdrawals(rows, calls, claims, arrivals) {
  const claimed = new Set();

  for (const row of rows) {
    const call = calls.get(row);

    // A claim that went through, is on its way, or is on chain, its outcome to be read.
    const claims = row.status === "executed" || row.status === "pending" || (row.status === "unknown" && row.source !== "sent");

    if (call?.kind === "claim" && claims && row.bridge?.nonce) claimed.add(row.bridge.nonce);
  }

  for (const row of rows) {
    const { bridge } = row;

    if (!bridge) continue;

    if (calls.get(row)?.kind === "prove") {
      const read = bridge.hash ? (claims?.get(bridge.hash) ?? null) : null;

      bridge.claim = read && typeof read === "object" ? read : null;
      bridge.claimed = Boolean((bridge.nonce && claimed.has(bridge.nonce)) || bridge.claim?.claimed === true);
    }

    const arrival = bridge.step === "deposit" && bridge.to && row.status === "executed" ? arrivals?.get(row.hash) : undefined;

    if (arrival && EVM_HASH.test(String(arrival.hash ?? ""))) {
      bridge.arrival = { at: timeOf(arrival.at), hash: /** @type {`0x${string}`} */ (arrival.hash) };
    }
  }
}

/**
 * Whether a send adds to the chain's row what the chain doesn't say.
 *
 * @param {SentTransaction} sent
 */
const addsToChainRow = (sent) =>
  // The shielded history has neither a shielded send's recipient nor its memo.
  Boolean(textOf(sent.toName) || (sent.privacy === "shielded" && (textOf(sent.memo) || textOf(sent.to))));

/**
 * The sends the chain's histories have the outcome of, as `activity.d.ts` says.
 *
 * @param {SettleInput} [input]
 * @returns {{ keep: SentTransaction[], drop: string[] }}
 */
export function settleSends({ public: entries, shielded, pending, keeps } = {}) {
  const adds = typeof keeps === "function" ? keeps : addsToChainRow;
  const outcome = new Set(
    [...(entries ?? []), ...(shielded ?? [])].filter((entry) => typeof entry?.success === "boolean").map((entry) => lower(entry.hash))
  );
  // A failed transaction moved nothing: its row shows what the send tried to.
  const failed = new Set([...(entries ?? []), ...(shielded ?? [])].filter((entry) => entry?.success === false).map((entry) => lower(entry.hash)));
  /** @type {SentTransaction[]} */
  const keep = [];
  /** @type {string[]} */
  const drop = [];

  for (const sent of pending ?? []) {
    if (!sent || sent.settled || !outcome.has(lower(sent.hash))) continue;

    let kept;

    try {
      kept = Boolean(adds(sent)) || (failed.has(lower(sent.hash)) && (luxOrNull(sent.amount) ?? 0n) > 0n);
    } catch {
      // Not judged: left as it is, for the next run.
      continue;
    }

    if (kept) keep.push({ ...sent, settled: true });
    else drop.push(sent.hash);
  }

  return { drop, keep };
}
