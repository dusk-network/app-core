/* @ts-self-types="./sozu.d.ts" */
/**
 * A person's stake with Sozu, from their activity and the status the apps
 * read of Sozu (`readSozuStatus` of `@dusk-network/networks/sozu`): what went
 * in, what came out, what it's worth now and what it earned, and what an
 * amount earns in a year at the present rate.
 *
 * @module
 */

import { nativeRateEstimate, sozuRateEstimate } from "@dusk-network/networks/rates";
import { feePercent, sozuFee, stDuskFor } from "@dusk-network/networks/sozu";

import { amountLocale } from "./amounts.js";

/** @typedef {import("./activity.js").ActivityRow} ActivityRow */
/** @typedef {import("./bridge.js").FactCache} FactCache */
/** @typedef {import("./history.js").Archive} Archive */
/** @typedef {import("./sozu.js").SozuFact} SozuFact */
/** @typedef {import("./sozu.js").SozuPosition} SozuPosition */
/** @typedef {import("./sozu.js").SozuStatusLike} SozuStatusLike */
/** @typedef {import("./sozu.js").SozuYear} SozuYear */
/** @typedef {{ numerator: bigint, denominator: bigint }} Rate */

const LUX_PER_DUSK = 1_000_000_000n;
const MAX_U64 = (1n << 64n) - 1n;
/** A rate's digits a bigint sum takes: a billionth. */
const RATE_SCALE = 1_000_000_000;
/** The stake consensus counts from, as `nativeRateEstimate` counts it: 1,000 DUSK. */
const MINIMUM_STAKE_LUX = 1_000_000_000_000n;
/** Blocks in a year of 365.25 days at one block every 10 seconds, as `nativeRateEstimate` counts them. */
const BLOCKS_PER_YEAR = (365.25 * 24 * 60 * 60) / 10;
/** Stakes read in one request. */
const FACTS_BATCH = 25;
const CONTRACT_ID = /^[0-9a-f]{64}$/;

/**
 * Lux from a bigint, a whole number or its text: null for anything else.
 *
 * @param {unknown} value
 * @returns {bigint | null}
 */
function luxOf(value) {
  if (typeof value === "bigint") return value >= 0n && value <= MAX_U64 ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;

  const text = typeof value === "string" ? value.trim() : "";

  if (!/^\d+$/.test(text)) return null;

  const lux = BigInt(text);

  return lux <= MAX_U64 ? lux : null;
}

/**
 * @param {unknown} rate
 * @returns {Rate | null}
 */
function rateOf(rate) {
  const { denominator, numerator } = /** @type {Record<string, unknown>} */ (rate ?? {});
  const n = luxOf(numerator);
  const d = luxOf(denominator);

  return n !== null && d !== null ? { denominator: d, numerator: n } : null;
}

/**
 * What a status says, whichever way an app keeps it: as `readSozuStatus`
 * gives it, or with its amounts as text under the names the extension's
 * engine gives them. Each figure is null where it wasn't read.
 *
 * @param {SozuStatusLike | null | undefined} status
 */
function readStatus(status) {
  const pool = /** @type {Record<string, unknown>} */ (status?.pool ?? {});
  const position = /** @type {Record<string, unknown>} */ (status?.position ?? {});
  const stake = luxOf(pool.stake ?? pool.totalStakeLux);
  const supply = luxOf(pool.supply ?? pool.tokenTotalSupply);

  return {
    balance: luxOf(position.balance ?? position.poolBalanceLux),
    depositFee: rateOf(status?.fees?.deposit),
    pool: stake !== null && supply !== null ? { stake, supply } : null,
    rewardFee: rateOf(status?.fees?.reward),
    stDusk: luxOf(position.stDusk ?? position.stDuskBalanceLux),
  };
}

/**
 * @param {ActivityRow} row
 */
const went = (row) => row.status === "executed" && (row.sozu === "stake" || row.sozu === "unstake");

/**
 * A pool event's figures: four little-endian u64s from the start of its data.
 *
 * @param {unknown} hex
 * @returns {bigint[] | null}
 */
function poolFigures(hex) {
  const text = typeof hex === "string" ? hex.toLowerCase() : "";

  if (text.length < 64 || !/^(?:[0-9a-f]{2})+$/.test(text)) return null;

  return Array.from({ length: 4 }, (_, i) => {
    let value = 0n;

    for (let byte = 7; byte >= 0; byte -= 1) value = (value << 8n) | BigInt(Number.parseInt(text.slice(i * 16 + byte * 2, i * 16 + byte * 2 + 2), 16));

    return value;
  });
}

/**
 * What a stake or an unstake did, from its transaction's entry in the
 * archive: the pool's own event, as it says it, of the row's amount.
 *
 * @param {any} raw
 * @param {ActivityRow} row
 * @returns {SozuFact | null}
 */
function factOf(raw, row) {
  const pool = String(row.contractId ?? "").toLowerCase();
  const topic = row.sozu === "stake" ? "deposit" : "unstake";

  for (const event of Array.isArray(raw?.events) ? raw.events : []) {
    const figures = event && event.reverted !== true && event.topic === topic && String(event.target ?? "").toLowerCase() === pool ? poolFigures(event.data) : null;

    if (!figures) continue;

    const [first, second, stake, supply] = figures;

    if (row.sozu === "stake") {
      if (first !== row.value || second > first) continue;

      const stDusk = stDuskFor(first - second, { stake, supply });

      if (stDusk !== null) return { amount: first, fee: second, kind: "stake", pool: { stake, supply }, stDusk };
    } else if (second === row.value && stake > 0n) {
      return { amount: second, fee: 0n, kind: "unstake", pool: { stake, supply }, stDusk: (second * supply) / stake };
    }
  }

  return null;
}

/** @param {SozuFact} fact */
const keptOf = (fact) => JSON.stringify({ ...fact, amount: `${fact.amount}`, fee: `${fact.fee}`, pool: { stake: `${fact.pool.stake}`, supply: `${fact.pool.supply}` }, stDusk: `${fact.stDusk}` });

/**
 * @param {string | null | undefined} text
 * @returns {SozuFact | null}
 */
function factKept(text) {
  try {
    const kept = JSON.parse(String(text));

    return { amount: BigInt(kept.amount), fee: BigInt(kept.fee), kind: kept.kind, pool: { stake: BigInt(kept.pool.stake), supply: BigInt(kept.pool.supply) }, stDusk: BigInt(kept.stDusk) };
  } catch {
    return null;
  }
}

/**
 * @param {{ archive: Pick<Archive, "query">, account: string, rows: Iterable<ActivityRow>, cache?: FactCache }} options
 * @returns {Promise<Map<string, SozuFact>>}
 */
export async function sozuFacts({ account, archive, cache, rows }) {
  /** @type {Map<string, SozuFact>} */
  const facts = new Map();
  /** @type {ActivityRow[]} */
  const asked = [];

  for (const row of rows ?? []) {
    if (!went(row) || row.source !== "public" || row.blockHeight === null || facts.has(row.hash) || !CONTRACT_ID.test(String(row.contractId ?? ""))) continue;

    const kept = factKept(cache?.get(`sozu:${row.hash}`));

    if (kept) facts.set(row.hash, kept);
    else asked.push(row);
  }

  for (let start = 0; start < asked.length; start += FACTS_BATCH) {
    const batch = asked.slice(start, start + FACTS_BATCH);
    const heights = [...new Set(batch.map((row) => row.blockHeight))];
    const data = await archive.query(`query { ${heights.map((height, i) => `h${i}: moonlightHistory(sender: ${JSON.stringify(account)}, fromBlock: ${height}, toBlock: ${height}) { json }`).join(" ")} }`);
    const found = heights.flatMap((_, i) => {
      const list = data?.[`h${i}`]?.json;

      return Array.isArray(list) ? list : [];
    });

    for (const row of batch) {
      const fact = factOf(found.find((raw) => String(raw?.origin ?? "").toLowerCase() === row.hash), row);

      if (!fact) continue;

      facts.set(row.hash, fact);
      cache?.set(`sozu:${row.hash}`, keptOf(fact));
    }
  }

  return facts;
}

/**
 * @param {{ rows?: Iterable<ActivityRow> | null, status?: SozuStatusLike | null, facts?: ReadonlyMap<string, SozuFact> | null, complete?: boolean }} [input]
 * @returns {SozuPosition}
 */
export function sozuPosition({ complete = true, facts, rows, status } = {}) {
  const { balance, depositFee, stDusk } = readStatus(status);
  let putIn = 0n;
  let takenOut = 0n;
  /** @type {bigint | null} */
  let depositFees = 0n;
  let feesExact = true;
  let waiting = 0;

  for (const row of rows ?? []) {
    if (!row?.sozu) continue;

    if (row.status === "pending") waiting += 1;
    if (!went(row)) continue;

    if (row.sozu === "unstake") {
      takenOut += row.value;
      continue;
    }

    putIn += row.value;

    const known = facts?.get(row.hash)?.fee;

    if (known !== undefined) {
      if (depositFees !== null) depositFees += known;
    } else {
      // Not read from its transaction: at the rate there is now, which may not be the one it paid.
      feesExact = false;
      depositFees = depositFee && depositFees !== null ? depositFees + sozuFee(row.value, depositFee) : null;
    }
  }

  return {
    depositFees,
    earned: complete && balance !== null && depositFees !== null ? balance + takenOut - putIn + depositFees : null,
    feesExact,
    putIn,
    stDusk,
    takenOut,
    waiting,
    worthNow: balance,
  };
}

/**
 * @param {number | null | undefined} nativeRate
 * @param {unknown} rewardFee
 * @returns {number | null}
 */
const rateAfterFee = (nativeRate, rewardFee) =>
  sozuRateEstimate(typeof nativeRate === "number" && Number.isFinite(nativeRate) ? Math.round(nativeRate * 100) / 100 : null, /** @type {any} */ (rateOf(rewardFee)));

/**
 * @param {number | null | undefined} nativeRate
 * @param {SozuStatusLike | null | undefined} status
 * @returns {number | null}
 */
export const sozuRate = (nativeRate, status) => rateAfterFee(nativeRate, status?.fees?.reward);

/**
 * @param {{ amount: bigint | number | string, nativeRate?: number | null, status?: SozuStatusLike | null }} input
 * @returns {SozuYear}
 */
export function sozuYear({ amount, nativeRate, status }) {
  const lux = luxOf(amount) ?? 0n;
  const { depositFee: fee } = readStatus(status);
  const rate = sozuRate(nativeRate, status);
  const depositFee = fee ? sozuFee(lux, fee) : null;
  const worth = depositFee === null ? null : lux > depositFee ? lux - depositFee : 0n;
  const rewards = rate === null || worth === null ? null : (worth * BigInt(Math.round(rate * RATE_SCALE))) / BigInt(RATE_SCALE);

  return { depositFee, earned: rewards === null || depositFee === null ? null : rewards - depositFee, rate, rewards, worth };
}

/**
 * The stake consensus counts at the tip, as `nativeRateEstimate` counts it,
 * and what a block pays it.
 *
 * @param {ReadonlyArray<{ amount?: unknown, eligibility?: unknown }>} provisioners
 * @param {number | bigint} tipHeight
 * @param {number} native
 */
function working(provisioners, tipHeight, native) {
  const tip = BigInt(tipHeight);
  let staked = 0n;

  for (const provisioner of provisioners) {
    const stake = typeof provisioner?.amount === "number" ? BigInt(Math.trunc(provisioner.amount)) : luxOf(provisioner?.amount);
    const eligibility = luxOf(provisioner?.eligibility);

    if (stake !== null && stake >= MINIMUM_STAKE_LUX && eligibility !== null && eligibility <= tip) staked += stake;
  }

  return { perBlock: (Number(staked) * native) / BLOCKS_PER_YEAR / Number(LUX_PER_DUSK), staked };
}

/**
 * @param {{ nativeRate?: number | null, status?: SozuStatusLike | null, provisioners?: ReadonlyArray<{ amount?: unknown, eligibility?: unknown }> | null, tipHeight?: number | bigint | null, locale?: string }} input
 * @returns {string | null}
 */
export function sozuRateLine({ locale = amountLocale(), nativeRate, provisioners, status, tipHeight }) {
  const read = provisioners && tipHeight !== null && tipHeight !== undefined;
  const native = nativeRate ?? (read ? nativeRateEstimate({ provisioners: /** @type {any} */ (provisioners), tipHeight }) : null);

  if (typeof native !== "number" || !Number.isFinite(native)) return null;

  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, style: "percent" });
  const shown = percent.format(Math.round(native * 100) / 100);
  /** @type {string} */
  let start = `About ${shown} a year across the network`;

  if (read) {
    const { perBlock, staked } = working(/** @type {any} */ (provisioners), tipHeight, native);
    const one = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    const compact = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation: "compact" });

    start = `${one.format(perBlock)} DUSK a block to stakers, ${compact.format(Number(staked / LUX_PER_DUSK))} DUSK staked now: about ${shown} a year`;
  }

  const fee = rateOf(status?.fees?.reward);
  const after = sozuRate(native, status);

  if (!fee || after === null) return `${start}, before Sozu's share.`;

  return `${start}. Less Sozu's ${feePercent(fee, locale)}: about ${percent.format(after)}, and a little over as it restakes rewards every hour.`;
}
