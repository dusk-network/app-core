/* @ts-self-types="./sozu.d.ts" */
/**
 * A person's stake with Sozu, from their activity and the status the apps
 * read of Sozu (`readSozuStatus` of `@dusk-network/networks/sozu`): what went
 * in, what came out, what it's worth now and what it earned, and what an
 * amount earns in a year at the present rate.
 *
 * @module
 */

import { networks } from "@dusk-network/networks";
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
/** @typedef {import("./sozu.js").SozuGrowth} SozuGrowth */
/** @typedef {import("./sozu.js").SozuPoint} SozuPoint */
/** @typedef {{ numerator: bigint, denominator: bigint }} Rate */
/** @typedef {import("./sozu.js").NativeRewards} NativeRewards */
/** @typedef {Pick<NativeRewards, "days" | "from" | "to" | "perBlock" | "blocks">} NativeMeasure */

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
/** The pool's event as rkyv writes it, last in its data: four u64s and an account, to 8 bytes. */
const POOL_EVENT_BYTES = 232;
/** An account in Sozu's events: a tag, then a contract's 32 bytes or a key's 193. */
const ACCOUNT_BYTES = 194;
/** A provisioner's key, as an unstake's event lists them ahead of itself. */
const PROVISIONER_BYTES = 193;
/** The stDUSK token's transfer: a u64, then the two accounts, to 8 bytes. */
const TRANSFER_BYTES = 400;
/** The zero address the token burns to: a contract's tag and 32 bytes of zero. */
const ZERO_ADDRESS = "00".repeat(33);

/** How long `sozuGrowth` keeps what it read: an hour, as Sozu restakes every hour. */
export const GROWTH_MAX_AGE_MS = 60 * 60_000;
/** The period `sozuGrowth` measures, unless asked another, in days. */
const GROWTH_DAYS = 30;
/** Blocks a day, at one block every 10 seconds. */
const BLOCKS_PER_DAY = 8_640;
/** The most blocks the archive lists a contract's transactions of in one field. */
const TXS_BLOCKS = 200;
/** Windows read at each end: 600 blocks, where Sozu restakes every 360. */
const TXS_WINDOWS = 3;
const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;
/** How far the latest restake's stDUSK may be from the pool's rate now, as a share: further, and it isn't the pool's. */
const RATE_TOLERANCE = 0.005;
/** A reward event's stake and stDUSK: the last u64s but one, from the end of its data. */
const REWARD_STAKE_FROM_END = 24;
/** Digits a growth's ratio is worked out to. */
const GROWTH_SCALE = 1_000_000_000_000n;
/** @type {WeakMap<object, Map<string, Promise<SozuGrowth | null>>>} */
const growthsUnderWay = new WeakMap();
/** @type {WeakMap<object, Map<string, Promise<NativeMeasure | null>>>} */
const nativeUnderWay = new WeakMap();
/** The stake contract, whose event in each block says what that block paid. */
const STAKE_CONTRACT = networks.mainnet.contracts.stake;
/** Blocks read across the period, each the middle of its share of it. */
const NATIVE_SAMPLES = 6;
/** A reward in the stake contract's event, as rkyv writes it: a key's 193 bytes, to 8, its u64 value and its reason. */
const REWARD_BYTES = 216;
const REWARD_VALUE_AT = 200;
const REWARD_REASON_AT = 208;
/** A reward's reasons: a generator's fixed share and its extra, a voter's, and another, which is Dusk's own: not a staker's. */
const REWARD_OTHER = 3;

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
 * Hex an event's data is, in lower case: "" for anything else.
 *
 * @param {unknown} data
 */
const hexOf = (data) => (typeof data === "string" && /^(?:[0-9a-f]{2})+$/i.test(data) ? data.toLowerCase() : "");

/**
 * A little-endian u64 of hex, from a byte.
 *
 * @param {string} hex
 * @param {number} at
 */
function u64At(hex, at) {
  let value = 0n;

  for (let byte = 7; byte >= 0; byte -= 1) value = (value << 8n) | BigInt(Number.parseInt(hex.slice((at + byte) * 2, (at + byte) * 2 + 2), 16));

  return value;
}

/**
 * An account as Sozu's events write it, from a byte: its tag and what its
 * kind has, a contract's 32 bytes or a key's 193. Null for another tag.
 *
 * @param {string} hex
 * @param {number} at
 */
function accountAt(hex, at) {
  const tag = hex.slice(at * 2, at * 2 + 2);
  const size = tag === "00" ? 32 : tag === "01" ? 193 : 0;

  return size ? hex.slice(at * 2, (at + 1 + size) * 2) : null;
}

/**
 * A pool event's four u64s and the account it names. rkyv writes the event
 * last, after what it points to: an unstake's provisioners come first, as
 * many as its first u64's upper half says. A stake's event has nothing before it.
 *
 * @param {unknown} data
 * @param {ActivityRow["sozu"]} kind
 */
function poolEvent(data, kind) {
  const hex = hexOf(data);
  const start = hex.length / 2 - POOL_EVENT_BYTES;

  if (start < 0) return null;

  const figures = Array.from({ length: 4 }, (_, i) => u64At(hex, start + i * 8));
  const before = kind === "unstake" ? Math.ceil((Number(figures[0] >> 32n) * PROVISIONER_BYTES) / 8) * 8 : 0;

  return start === before ? { account: accountAt(hex, start + 32), figures } : null;
}

/**
 * The stDUSK an unstake burned, as the token says it in the same transaction:
 * its transfer from the account to the zero address.
 *
 * @param {any[]} events
 * @param {string | null} account
 * @returns {bigint | null}
 */
function burnedBy(events, account) {
  for (const event of events) {
    const hex = event.topic === "transfer" ? hexOf(event.data) : "";

    if (account && hex.length === TRANSFER_BYTES * 2 && accountAt(hex, 8) === account && accountAt(hex, 8 + ACCOUNT_BYTES) === ZERO_ADDRESS) return u64At(hex, 0);
  }

  return null;
}

/**
 * What a stake or an unstake did, from its transaction's entry in the
 * archive: the pool's own event, as it says it, of the row's amount, and the
 * stDUSK an unstake burned, as the token says it: where an unstake takes all
 * there is, the pool burns all the account's stDUSK, a lux over what its rate
 * can come to.
 *
 * @param {any} raw
 * @param {ActivityRow} row
 * @returns {SozuFact | null}
 */
function factOf(raw, row) {
  const pool = String(row.contractId ?? "").toLowerCase();
  const topic = row.sozu === "stake" ? "deposit" : "unstake";
  const events = (Array.isArray(raw?.events) ? raw.events : []).filter((/** @type {any} */ event) => event && event.reverted !== true);

  for (const event of events) {
    const read = event.topic === topic && String(event.target ?? "").toLowerCase() === pool ? poolEvent(event.data, row.sozu) : null;

    if (!read) continue;

    const [first, second, stake, supply] = read.figures;

    if (row.sozu === "stake") {
      if (first !== row.value || second > first) continue;

      const stDusk = stDuskFor(first - second, { stake, supply });

      if (stDusk !== null) return { amount: first, fee: second, kind: "stake", pool: { stake, supply }, stDusk };
    } else if (second === row.value && stake > 0n) {
      const stDusk = burnedBy(events, read.account);

      if (stDusk !== null) return { amount: second, fee: 0n, kind: "unstake", pool: { stake, supply }, stDusk };
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

// What a cache keeps a fact under. 0.7.1 read some unstakes a lux short and
// kept them under "sozu:": a new key reads them again.
const CACHE_KEY = "sozu2:";

/**
 * @param {{ stake: bigint, supply: bigint } | null | undefined} pool
 * @returns {bigint | null}
 */
export function stDuskWorth(pool) {
  const stake = pool?.stake;
  const supply = pool?.supply;

  return typeof stake === "bigint" && typeof supply === "bigint" && supply > 0n ? (LUX_PER_DUSK * stake) / supply : null;
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

    const kept = factKept(cache?.get(`${CACHE_KEY}${row.hash}`));

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
      cache?.set(`${CACHE_KEY}${row.hash}`, keptOf(fact));
    }
  }

  return facts;
}

/**
 * A restake of the pool's, from a transaction the archive lists calling it:
 * a `recycle` that went through. Null for any other.
 *
 * @param {any} listed
 * @param {string} pool
 * @returns {{ id: string, height: number, at: number } | null}
 */
function restakeOf(listed, pool) {
  /** @type {any} */
  let tx = null;

  try {
    tx = JSON.parse(String(listed?.tx?.json ?? "null"));
  } catch {
    tx = null;
  }

  const height = Number(listed?.blockHeight);
  const at = Number(listed?.blockTimestamp) * 1000;
  const id = String(listed?.id ?? "").toLowerCase();

  if (listed?.err || tx?.call?.fn_name !== "recycle" || String(tx?.call?.contract ?? "").toLowerCase() !== pool || !CONTRACT_ID.test(id)) return null;

  return Number.isSafeInteger(height) && Number.isFinite(at) && at > 0 ? { at, height, id } : null;
}

/**
 * What one stDUSK was worth once a restake went through: the pool's stake
 * and its stDUSK, as its reward event says them in that block's events.
 *
 * @param {unknown} list The block's events, as the archive gives them
 * @param {{ id: string, height: number, at: number }} restake
 * @param {string} pool
 * @returns {SozuPoint | null}
 */
function pointOf(list, restake, pool) {
  const event = (Array.isArray(list) ? list : []).find(
    (each) => each && each.reverted !== true && each.topic === "reward" && String(each.origin ?? "").toLowerCase() === restake.id && String(each.source ?? each.target ?? "").toLowerCase() === pool
  );
  const hex = hexOf(event?.data);
  const end = hex.length / 2;

  if (end < REWARD_STAKE_FROM_END) return null;

  const stake = u64At(hex, end - REWARD_STAKE_FROM_END);
  const supply = u64At(hex, end - REWARD_STAKE_FROM_END + 8);

  return stake > 0n && supply > 0n ? { at: restake.at, height: restake.height, stake, supply } : null;
}

/**
 * How much more a's stDUSK is worth than b's, as a share: null where either
 * has nothing to divide by.
 *
 * @param {{ stake: bigint, supply: bigint }} a
 * @param {{ stake: bigint, supply: bigint }} b
 */
const grownBy = (a, b) => (a.supply > 0n && b.stake > 0n ? Number((a.stake * b.supply * GROWTH_SCALE) / (a.supply * b.stake) - GROWTH_SCALE) / Number(GROWTH_SCALE) : null);

/** @param {SozuGrowth} growth */
const growthKept = (growth) =>
  JSON.stringify(growth, (_, value) => (typeof value === "bigint" ? `${value}` : value));

/**
 * @param {string | null | undefined} text
 * @returns {{ readAt: number, growth: SozuGrowth } | null}
 */
function growthRead(text) {
  try {
    const { growth, readAt } = JSON.parse(String(text));
    /** @param {any} point */
    const point = (point) => ({ at: Number(point.at), height: Number(point.height), stake: BigInt(point.stake), supply: BigInt(point.supply) });

    return { growth: { days: Number(growth.days), from: point(growth.from), rate: Number(growth.rate), to: point(growth.to) }, readAt: Number(readAt) };
  } catch {
    return null;
  }
}

/**
 * @param {{ archive: Pick<Archive, "query">, pool?: string | null, status?: SozuStatusLike | null, days?: number, tipHeight?: number | bigint | null, cache?: FactCache, maxAgeMs?: number, now?: number }} options
 * @returns {Promise<SozuGrowth | null>}
 */
export async function sozuGrowth({ archive, cache, days = GROWTH_DAYS, maxAgeMs = GROWTH_MAX_AGE_MS, now = Date.now(), pool, status, tipHeight }) {
  const id = String(pool ?? /** @type {any} */ (status)?.contracts?.pool ?? "").toLowerCase();

  if (!CONTRACT_ID.test(id)) return null;
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError("A period is a whole number of days");

  const key = `sozu-growth:${id}:${days}`;
  const figures = readStatus(status).pool;
  // The growth as this caller has it: none where its status's rate now isn't
  // the latest restake's, as then what was read isn't the pool's figures.
  /** @param {SozuGrowth | null} growth */
  const ofCaller = (growth) => {
    const apart = growth && figures ? grownBy(growth.to, figures) : 0;

    return growth && apart !== null && Math.abs(apart) <= RATE_TOLERANCE ? growth : null;
  };
  const kept = growthRead(cache?.get(key));

  if (kept && now - kept.readAt >= 0 && now - kept.readAt < maxAgeMs) return ofCaller(kept.growth);

  const under = cache ? growthsUnderWay.get(cache)?.get(key) : undefined;

  if (under) return ofCaller(await under);

  const answer = readGrowth(archive, id, days, tipHeight);
  const reads = cache ? (growthsUnderWay.get(cache) ?? new Map()) : null;

  if (cache && reads) {
    growthsUnderWay.set(cache, reads);
    reads.set(key, answer);
  }

  try {
    const growth = await answer;

    // Kept where this caller's status agrees with it, or it has none to say.
    if (growth && ofCaller(growth)) cache?.set(key, JSON.stringify({ growth: JSON.parse(growthKept(growth)), readAt: now }));

    return ofCaller(growth);
  } finally {
    reads?.delete(key);
  }
}

/**
 * How the pool's stDUSK grew over `days`, as the chain says: null where it
 * can't be read. Nothing here knows what any caller's status says.
 *
 * @param {Pick<Archive, "query">} archive
 * @param {string} id The pool's contract ID
 * @param {number} days
 * @param {number | bigint | null | undefined} tipHeight
 * @returns {Promise<SozuGrowth | null>}
 */
async function readGrowth(archive, id, days, tipHeight) {
  try {
    const tip = tipHeight === undefined || tipHeight === null ? Number((await archive.query("query { tip: block(height: -1) { header { height } } }"))?.tip?.header?.height) : Number(tipHeight);
    const then = tip - days * BLOCKS_PER_DAY;

    if (!Number.isSafeInteger(tip) || then < TXS_BLOCKS * TXS_WINDOWS) return null;

    // The latest restake, and the one nearest the period's start.
    const latest = Array.from({ length: TXS_WINDOWS }, (_, i) => [`n${i}`, tip - TXS_BLOCKS * (i + 1) + 1, tip - TXS_BLOCKS * i]);
    const first = Array.from({ length: TXS_WINDOWS }, (_, i) => [`t${i}`, then - (TXS_BLOCKS * TXS_WINDOWS) / 2 + TXS_BLOCKS * i, then - (TXS_BLOCKS * TXS_WINDOWS) / 2 + TXS_BLOCKS * (i + 1) - 1]);
    const listed = await archive.query(
      `query { ${[...latest, ...first].map(([alias, from, to]) => `${alias}: blockTxs(range: [${from}, ${to}], contract: ${JSON.stringify(id)}) { id blockHeight blockTimestamp err tx { json } }`).join(" ")} }`
    );
    /** @param {(string | number)[][]} windows */
    const restakesIn = (windows) => windows.flatMap(([alias]) => (Array.isArray(listed?.[alias]) ? listed[alias] : [])).map((each) => restakeOf(each, id)).filter((each) => each !== null);
    const end = restakesIn(latest).sort((a, b) => b.height - a.height)[0];
    const start = restakesIn(first).sort((a, b) => Math.abs(a.height - then) - Math.abs(b.height - then))[0];

    if (!end || !start || start.height >= end.height) return null;

    const blocks = await archive.query(`query { a: contractEvents(height: ${start.height}) { json } b: contractEvents(height: ${end.height}) { json } }`);
    const from = pointOf(blocks?.a?.json, start, id);
    const to = pointOf(blocks?.b?.json, end, id);
    const span = from && to ? to.at - from.at : 0;

    if (!from || !to || span <= 0) return null;

    const grown = grownBy(to, from);

    return grown === null ? null : { days: Math.round(span / DAY_MS), from, rate: (grown * YEAR_MS) / span, to };
  } catch {
    // What can't be read says nothing: the rate as it's worked out stands.
    return null;
  }
}

/**
 * What a block paid stakers, from its stake contract's reward event: every
 * reward in it but Dusk's own. Null where it has none, or one that doesn't
 * read as rewards.
 *
 * @param {unknown} list The block's events, as the archive gives them
 * @returns {bigint | null}
 */
function paidToStakers(list) {
  const event = (Array.isArray(list) ? list : []).find((each) => each && each.reverted !== true && each.topic === "reward" && String(each.source ?? each.target ?? "").toLowerCase() === STAKE_CONTRACT);
  const hex = hexOf(event?.data);
  const end = hex.length / 2 - 8;

  if (end < 0) return null;

  // rkyv's vector, last: where its rewards start, from itself, and how many.
  const root = u64At(hex, end);
  const count = Number(root >> 32n);
  const start = end + Number(BigInt.asIntN(32, root));

  if (start < 0 || start + count * REWARD_BYTES !== end) return null;

  let paid = 0n;

  for (let i = 0; i < count; i += 1) {
    const at = start + i * REWARD_BYTES;
    const reason = Number.parseInt(hex.slice((at + REWARD_REASON_AT) * 2, (at + REWARD_REASON_AT) * 2 + 2), 16);

    if (reason > REWARD_OTHER) return null;
    if (reason !== REWARD_OTHER) paid += u64At(hex, at + REWARD_VALUE_AT);
  }

  return paid;
}

/**
 * What native staking paid over `days`, as the chain says: null where it
 * can't be read. Nothing here knows what's staked.
 *
 * @param {Pick<Archive, "query">} archive
 * @param {number} days
 * @param {number | bigint | null | undefined} tipHeight
 * @returns {Promise<NativeMeasure | null>}
 */
async function readNative(archive, days, tipHeight) {
  try {
    const tip = tipHeight === undefined || tipHeight === null ? Number((await archive.query("query { tip: block(height: -1) { header { height } } }"))?.tip?.header?.height) : Number(tipHeight);
    const start = tip - days * BLOCKS_PER_DAY;

    if (!Number.isSafeInteger(tip) || start < 1) return null;

    const heights = Array.from({ length: NATIVE_SAMPLES }, (_, i) => Math.round(start + ((i + 0.5) * (tip - start)) / NATIVE_SAMPLES));
    // The period ends at the archive's own tip, which may trail the node's by a block or two.
    const read = await archive.query(
      `query { a: block(height: ${start}) { header { height timestamp } } b: block(height: -1) { header { height timestamp } } ${heights.map((height, i) => `e${i}: contractEvents(height: ${height}) { json }`).join(" ")} }`
    );
    const paid = heights.map((_, i) => paidToStakers(read?.[`e${i}`]?.json)).filter((each) => each !== null);
    const from = { at: Number(read?.a?.header?.timestamp) * 1000, height: start };
    const to = { at: Number(read?.b?.header?.timestamp) * 1000, height: Number(read?.b?.header?.height) };
    const span = to.at - from.at;

    // Most blocks read, or it says too little.
    if (paid.length * 2 < NATIVE_SAMPLES || !(span > 0) || !(to.height > start)) return null;

    return { blocks: paid.length, days: Math.round(span / DAY_MS), from, perBlock: paid.reduce((sum, each) => sum + each, 0n) / BigInt(paid.length), to };
  } catch {
    // What can't be read says nothing: the rate is estimated as before.
    return null;
  }
}

/**
 * @param {{ archive: Pick<Archive, "query">, provisioners: ReadonlyArray<{ amount?: unknown, eligibility?: unknown }>, tipHeight?: number | bigint | null, days?: number, network?: unknown, cache?: FactCache, maxAgeMs?: number, now?: number }} options
 * @returns {Promise<NativeRewards | null>}
 */
export async function nativeRewards({ archive, cache, days = GROWTH_DAYS, maxAgeMs = GROWTH_MAX_AGE_MS, network = "", now = Date.now(), provisioners, tipHeight }) {
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError("A period is a whole number of days");

  const key = `native-rewards:${String(network)}:${days}`;
  /** @param {string | null | undefined} text */
  const kept = (text) => {
    try {
      const { measure, readAt } = JSON.parse(String(text));

      return now - readAt >= 0 && now - readAt < maxAgeMs ? { ...measure, perBlock: BigInt(measure.perBlock) } : null;
    } catch {
      return null;
    }
  };
  let measure = kept(cache?.get(key));

  if (!measure) {
    const reads = cache ? (nativeUnderWay.get(cache) ?? new Map()) : null;
    const under = reads?.get(key) ?? readNative(archive, days, tipHeight);

    if (cache && reads) {
      nativeUnderWay.set(cache, reads);
      reads.set(key, under);
    }

    try {
      measure = await under;
    } finally {
      reads?.delete(key);
    }

    if (measure) cache?.set(key, JSON.stringify({ measure: { ...measure, perBlock: `${measure.perBlock}` }, readAt: now }));
  }

  if (!measure || !Array.isArray(provisioners)) return null;

  // What's staked now, as consensus counts it at the tip: what a staker shares a block's pay with.
  const { staked } = working(provisioners, measure.to.height, 0);
  const blocksAYear = ((measure.to.height - measure.from.height) * YEAR_MS) / (measure.to.at - measure.from.at);

  return staked > 0n ? { ...measure, rate: (Number(measure.perBlock) * blocksAYear) / Number(staked), staked } : null;
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
 * @param {SozuGrowth | null} [growth]
 * @returns {number | null}
 */
export const sozuRate = (nativeRate, status, growth) => growth?.rate ?? rateAfterFee(nativeRate, status?.fees?.reward);

/**
 * @param {{ amount: bigint | number | string, nativeRate?: number | null, status?: SozuStatusLike | null, growth?: SozuGrowth | null }} input
 * @returns {SozuYear}
 */
export function sozuYear({ amount, growth, nativeRate, status }) {
  const lux = luxOf(amount) ?? 0n;
  const { depositFee: fee } = readStatus(status);
  const rate = sozuRate(nativeRate, status, growth);
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
 * What one stDUSK was worth, in DUSK, to four decimals; more where the two
 * ends would read the same.
 *
 * @param {{ stake: bigint, supply: bigint }} point
 * @param {number} decimals
 */
const valueOf = ({ stake, supply }, decimals) => {
  const scale = 10n ** BigInt(decimals);

  return Number((stake * scale + supply / 2n) / supply) / Number(scale);
};

/**
 * @param {{ nativeRate?: number | null, native?: NativeRewards | null, status?: SozuStatusLike | null, provisioners?: ReadonlyArray<{ amount?: unknown, eligibility?: unknown }> | null, tipHeight?: number | bigint | null, locale?: string, growth?: SozuGrowth | null }} input
 * @returns {string | null}
 */
export function sozuRateLine({ growth, locale = amountLocale(), native: measured, nativeRate, provisioners, status, tipHeight }) {
  /** @param {number} days */
  const period = (days) => (days === 1 ? "the last day" : `the last ${new Intl.NumberFormat(locale).format(days)} days`);

  if (growth) {
    const decimals = valueOf(growth.from, 4) === valueOf(growth.to, 4) ? 6 : 4;
    const value = new Intl.NumberFormat(locale, { maximumFractionDigits: decimals, minimumFractionDigits: decimals });

    return `stDUSK went from ${value.format(valueOf(growth.from, decimals))} to ${value.format(valueOf(growth.to, decimals))} DUSK over ${period(growth.days)}, after Sozu's share.`;
  }

  const read = provisioners && tipHeight !== null && tipHeight !== undefined;
  const native = measured?.rate ?? nativeRate ?? (read ? nativeRateEstimate({ provisioners: /** @type {any} */ (provisioners), tipHeight }) : null);

  if (typeof native !== "number" || !Number.isFinite(native)) return null;

  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, style: "percent" });
  const shown = percent.format(Math.round(native * 100) / 100);
  const one = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const compact = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation: "compact" });
  /** @type {string} */
  let start = `About ${shown} a year across the network`;

  if (measured) {
    // What the chain paid, over the period it was measured.
    start = `${one.format(Number(measured.perBlock) / Number(LUX_PER_DUSK))} DUSK a block to stakers over ${period(measured.days)}, ${compact.format(Number(measured.staked / LUX_PER_DUSK))} DUSK staked now: about ${shown} a year`;
  } else if (read) {
    const { perBlock, staked } = working(/** @type {any} */ (provisioners), tipHeight, native);

    start = `${one.format(perBlock)} DUSK a block to stakers, ${compact.format(Number(staked / LUX_PER_DUSK))} DUSK staked now: about ${shown} a year`;
  }

  const fee = rateOf(status?.fees?.reward);
  const after = sozuRate(native, status);

  if (!fee || after === null) return `${start}, before Sozu's share.`;

  return `${start}. Less Sozu's ${feePercent(fee, locale)}: about ${percent.format(after)}, and a little over as it restakes rewards every hour.`;
}
