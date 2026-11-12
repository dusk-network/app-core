/* @ts-self-types="./export.d.ts" */
/**
 * An account's activity as the file an accountant or a crypto tax tool reads.
 *
 * The format is Koinly's universal CSV: `Date`, `Sent Amount`, `Sent Currency`,
 * `Received Amount`, `Received Currency`, `Fee Amount`, `Fee Currency`, `Net
 * Worth Amount`, `Net Worth Currency`, `Tag`, `Description`, `TxHash`, with
 * dates as `YYYY-MM-DD HH:mm:ss` in UTC, a point for decimals and no grouping
 * (https://support.koinly.io/en/articles/9489976-how-to-create-a-custom-csv-file-with-your-data).
 *
 * Why this one. Exchanges each write their own columns, and no tool's import
 * reads them all, so what's common is a tax tool's template. This one is what
 * others follow: Coinpanda's generic template has these columns, and explorers
 * and converters write it for their users, as cspr.live and binance2koinly do.
 * It alone of the tools' templates holds all an accountant asks for: sent,
 * received and fee each with its coin, a fiat value at the time, a tag, a free
 * description and the transaction's hash. CoinTracker's has no hash,
 * description or fiat value, and CoinLedger's no fiat value, and both take US
 * dates. A spreadsheet opens it as it opens an exchange's file: comma-separated
 * with a point for decimals, by Data > From Text/CSV where the language writes
 * a comma for decimals. It has no BOM unless asked for: Koinly has refused a
 * file's headers over one.
 *
 * Koinly ignores columns it doesn't know, so what it has no column for (whose
 * account it is, who the other side is, and whether it's a transfer between
 * the person's own profiles) sits to the right of its twelve.
 *
 * A token's transfer has its amount, currency and recipient in those same columns,
 * from the wallet's own record of it (`sent.asset`): the chain's row says only that
 * the contract was called.
 *
 * Each file is one wallet's view, as the format wants: a transfer between two
 * profiles is a withdrawal in one's file and a deposit in the other's, with
 * the same time, amount and hash, which Koinly merges into a transfer. It has
 * no tag for it: no tag is what keeps it from reading as income.
 *
 * @module
 */

import { formatDuskPlain } from "./amounts.js";
import { routes } from "@dusk-network/networks";

import { bridgeSenders, bridgedTo, migrationApprovals, migrationFacts, migrationsOf } from "./bridge-evm.js";
import { networkOf } from "./bridge-common.js";
import { memoTextOf } from "./moved.js";
import { sozuPointAt, sozuPosition, stDuskWorth } from "./sozu.js";
import { displayText } from "./text.js";

/** @typedef {import("./activity.js").ActivityRow} ActivityRow */
/** @typedef {import("./export.js").ExportOptions} ExportOptions */
/** @typedef {import("./export.js").ExportPeriod} ExportPeriod */
/** @typedef {import("./export.js").ExportResult} ExportResult */
/** @typedef {import("./sozu.js").SozuFact} SozuFact */
/** @typedef {import("./sozu.js").SozuStatusLike} SozuStatusLike */
/** @typedef {import("./history.js").Archive} Archive */
/** @typedef {import("./bridge.js").FactCache} FactCache */
/** @typedef {import("./bridge.js").MigrationEvm} MigrationEvm */
/** @typedef {import("./bridge.js").MigrationApproval} MigrationApproval */

/** The format's twelve, then what it ignores. */
export const CSV_COLUMNS = Object.freeze([
  "Date",
  "Sent Amount",
  "Sent Currency",
  "Received Amount",
  "Received Currency",
  "Fee Amount",
  "Fee Currency",
  "Net Worth Amount",
  "Net Worth Currency",
  "Tag",
  "Description",
  "TxHash",
  "Account Name",
  "Account",
  "Counterparty Name",
  "Counterparty",
  "Internal Transfer",
  "Memo",
]);

const DUSK = "DUSK";
const ST_DUSK = "stDUSK";
const LUX_DECIMALS = 9;
/** The decimals of every value in fiat: one precision, from a fraction of a cent up. */
const WORTH_DECIMALS = 8;
// The most a token's decimals can be, as a contract's `u8` has them.
const MAX_TOKEN_DECIMALS = 255;
const BOM = "\ufeff";

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/**
 * How far ahead of UTC a zone is at a moment, in milliseconds.
 *
 * @param {number} at
 * @param {string | undefined} timeZone
 */
function offsetAt(at, timeZone) {
  /** @type {Record<string, number>} */
  const parts = {};

  for (const part of new Intl.DateTimeFormat("en-US", { day: "numeric", hour: "numeric", hourCycle: "h23", minute: "numeric", month: "numeric", second: "numeric", timeZone, year: "numeric" }).formatToParts(at)) {
    parts[part.type] = Number(part.value);
  }

  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000;
}

/**
 * The moment a day starts in a zone.
 *
 * @param {number} year
 * @param {number} month From 1
 * @param {number} day
 * @param {string | undefined} timeZone
 */
function dayStart(year, month, day, timeZone) {
  const utc = Date.UTC(year, month - 1, day);
  const DAY = 86_400_000;
  // The zone's offset on either side of the day, as a clock change at midnight
  // can skip that midnight or have it twice: the first moment of that very day.
  const moments = [utc - offsetAt(utc - DAY, timeZone), utc - offsetAt(utc + DAY, timeZone)]
    .filter((at) => {
      const local = new Date(at + offsetAt(at, timeZone));

      return local.getUTCFullYear() === new Date(utc).getUTCFullYear() && local.getUTCMonth() === new Date(utc).getUTCMonth() && local.getUTCDate() === new Date(utc).getUTCDate();
    });

  return moments.length ? Math.min(...moments) : utc - offsetAt(utc, timeZone);
}

/**
 * @param {number} year
 * @param {number} quarter 1 to 4
 * @param {{ timeZone?: string }} [options]
 * @returns {ExportPeriod}
 */
export function quarterPeriod(year, quarter, { timeZone } = {}) {
  if (!Number.isSafeInteger(year) || ![1, 2, 3, 4].includes(quarter)) throw new RangeError("A quarter is a year, and 1, 2, 3 or 4");

  const first = (quarter - 1) * 3 + 1;

  return { from: dayStart(year, first, 1, timeZone), label: `${year}-q${quarter}`, to: dayStart(year, first + 3, 1, timeZone) };
}

/**
 * @param {string} from The first day, "2026-10-01"
 * @param {string} to The last day, itself included
 * @param {{ timeZone?: string }} [options]
 * @returns {ExportPeriod}
 */
export function datesPeriod(from, to, { timeZone } = {}) {
  /** @param {string} text */
  const day = (text) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));

    if (!match) throw new RangeError("A day is written 2026-10-01");

    const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const real = new Date(Date.UTC(year, month - 1, date));

    if (real.getUTCMonth() !== month - 1 || real.getUTCDate() !== date) throw new RangeError(`There's no day ${text}`);

    return [year, month, date];
  };
  const [fromYear, fromMonth, fromDay] = day(from);
  const [toYear, toMonth, toDay] = day(to);
  const period = { from: dayStart(fromYear, fromMonth, fromDay, timeZone), label: `${from}-to-${to}`, to: dayStart(toYear, toMonth, toDay + 1, timeZone) };

  if (period.to <= period.from) throw new RangeError("The last day is after the first");

  return period;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * A line of the file, before its value in fiat.
 *
 * `valued` is the DUSK it's worth, null for what isn't DUSK. `sentDecimals` is a
 * token's own, and `counterparty` who it went to where that isn't the row's. A
 * line of another chain's has its own time, hash, account and memo.
 *
 * @typedef {{ sent?: bigint, sentCoin?: string, sentDecimals?: number, received?: bigint, receivedCoin?: string, fee?: bigint | null, tag?: string, words: string, valued: bigint | null, counterparty?: string, partyName?: string, at?: number, hash?: string, account?: string, accountName?: string, memo?: string }} Line
 */

/**
 * @param {bigint} lux
 * @param {string} words
 * @returns {Line}
 */
const feeLine = (lux, words) => ({ sent: lux, sentCoin: DUSK, tag: "cost", valued: lux, words });

/**
 * @param {ActivityRow} row
 * @returns {Line}
 */
const moved = (row) => (row.direction === "in" ? { received: row.value, receivedCoin: DUSK, valued: row.value, words: "" } : { sent: row.value, sentCoin: DUSK, valued: row.value, words: "" });

/**
 * A line of what a row moved under a tag the format skips on import, with its
 * fee on a line of its own, which stays in.
 *
 * @param {ActivityRow} row
 * @param {string} tag
 * @param {string} words
 * @param {bigint | null} fee
 * @returns {Line[]}
 */
const skipped = (row, tag, words, fee) => [{ ...moved(row), tag, words }, ...(fee ? [feeLine(fee, `Network fee: ${words}`)] : [])];

/**
 * @param {ActivityRow} row
 */
const sozuWord = (row) => (row.sozu === "stake" ? "Staked with Sozu" : row.sozu === "unstake" ? "Unstaked from Sozu" : "");

/**
 * What one stDUSK was worth when a stake or an unstake went through, in DUSK.
 *
 * @param {SozuFact} fact
 */
function rateWords(fact) {
  const worth = stDuskWorth(fact.pool);

  return worth === null ? "" : `1 stDUSK = ${formatDuskPlain(worth)} DUSK`;
}

/**
 * The lines a stake or an unstake with Sozu makes: a trade of DUSK and stDUSK
 * where its stDUSK is known, as the format records a token received for what
 * was staked; else what it moved, under the staking tags.
 *
 * @param {ActivityRow} row
 * @param {SozuFact | undefined} fact
 * @param {bigint | null} fee
 * @returns {Line[]}
 */
function sozuLines(row, fact, fee) {
  const stake = row.sozu === "stake";

  if (!fact) return skipped(row, stake ? "stake" : "unstake", `${sozuWord(row)}, its stDUSK not read`, fee);

  const deposit = fact.fee > 0n ? `, deposit fee ${formatDuskPlain(fact.fee)} DUSK` : "";
  const words = `${sozuWord(row)}${deposit}, ${rateWords(fact)}`;

  return stake
    ? [{ fee, received: fact.stDusk, receivedCoin: ST_DUSK, sent: row.value, sentCoin: DUSK, valued: row.value, words }]
    : [{ fee, received: row.value, receivedCoin: DUSK, sent: fact.stDusk, sentCoin: ST_DUSK, valued: row.value, words }];
}

/**
 * The lines of a transfer with one of the bridge's accounts. One out to
 * another chain sends what reached it there, and pays the bridge's fee as a
 * fee, beside the network's: what's sent is what a tax tool matches with
 * what came in on the other side.
 *
 * @param {ActivityRow} row
 * @param {NonNullable<ActivityRow["route"]>} route
 * @param {bigint | null} fee
 * @returns {Line[]}
 */
function routeLines(row, route, fee) {
  const chain = route.chain?.name ?? route.id;

  if (row.direction === "in") return [{ ...moved(row), fee, words: `From ${chain}` }];
  if (route.kind !== "service") return [{ ...moved(row), fee, words: `To ${chain}` }];

  // What the bridge keeps: its fee, or all of what was sent where that's less.
  const kept = row.value < route.feeLux ? row.value : route.feeLux;
  const sent = row.value - kept;

  return [{ fee: fee === null ? kept : fee + kept, sent, sentCoin: DUSK, valued: sent, words: `To ${chain}, bridge fee ${formatDuskPlain(kept)} DUSK` }];
}

/**
 * The lines of a call to DuskEVM's bridge or Portal.
 *
 * @param {ActivityRow} row
 * @param {NonNullable<ActivityRow["bridge"]>} bridge
 * @param {bigint | null} fee
 * @returns {Line[]}
 */
function bridgeLines(row, bridge, fee) {
  if (bridge.step === "deposit") return [{ ...moved(row), fee, words: `To DuskEVM${bridge.to ? ` ${bridge.to}` : ""}` }];
  if (bridge.step === "withdrawal") return [{ ...moved(row), fee, words: "From DuskEVM" }];

  const words = bridge.step === "proof" ? "Proof of a DuskEVM withdrawal" : bridge.step === "claim" ? "Claim of a DuskEVM withdrawal" : "Call of DuskEVM's bridge";

  return fee ? [feeLine(fee, words)] : [];
}

/**
 * The lines of a migration's side on its own chain, for the payout on Dusk it
 * was paid with: the gas its own approval and it paid there, in that chain's
 * coin, each at its own time and hash, of the address that sent it, as costs.
 * What it moved is the payout's line.
 *
 * @param {ActivityRow} row
 * @param {MigrationEvm | undefined} fact
 * @returns {Line[]}
 */
function evmLines(row, fact) {
  const route = /** @type {any} */ (row.route);

  if (fact?.state !== "mined" || !fact.from || fact.at === null || route?.kind !== "migration") return [];

  const chain = route.chain?.name ?? route.id;
  const decimals = route.chain?.currency?.decimals ?? 18;
  const base = { account: fact.from, accountName: chain, counterparty: String(route.contract ?? "").toLowerCase() || undefined, memo: "", partyName: "", sentCoin: fact.coin, sentDecimals: decimals, tag: "cost", valued: null };
  /** @type {Line[]} */
  const lines = [];

  if (fact.approvalState === "found" && fact.approval?.gasWei && fact.approval.at !== null) {
    lines.push({ ...base, at: fact.approval.at, hash: fact.approval.hash, sent: fact.approval.gasWei, words: `Network fee on ${chain}: approval for a migration to Dusk` });
  }

  if (fact.gasWei) {
    const moved = fact.lux === null ? "" : ` of ${formatDuskPlain(fact.lux)} ${route.chain?.tokenLabel ?? DUSK}`;

    lines.push({ ...base, at: fact.at, hash: fact.hash, sent: fact.gasWei, words: `Network fee on ${chain}: migration${moved} to Dusk` });
  }

  return lines;
}

/** What an approval that's no migration's own did, after "approval for a migration to Dusk". */
const APPROVAL_WORDS = Object.freeze({ open: ", not used yet", revoke: ", revoked", spent: "", uncertain: "", unused: ", never used" });

/**
 * The line of an approval or a revoke of a migration's contract on its own
 * chain: the gas it paid there, at its own time and hash, of the address that
 * sent it, as a cost.
 *
 * @param {MigrationApproval} approval
 * @returns {Line}
 */
const approvalLine = ({ at, chain, coin, contract, decimals, gasWei, hash, owner, state }) => ({
  account: owner,
  accountName: chain,
  at: /** @type {number} */ (at),
  counterparty: contract,
  hash,
  memo: "",
  partyName: "",
  sent: /** @type {bigint} */ (gasWei),
  sentCoin: coin,
  sentDecimals: decimals,
  tag: "cost",
  valued: null,
  words: `Network fee on ${chain}: ${state === "revoke" ? "approval for migrations to Dusk revoked" : `approval for a migration to Dusk${APPROVAL_WORDS[state]}`}`,
});

/**
 * What a contract call is, in words.
 *
 * @param {ActivityRow} row
 */
function callWords(row) {
  const named = row.nameCall;

  if (named) return `${named.name ? `${named.name}: ` : ""}${named.kind}`;

  // A token's transfer this wallet has no record of: the chain's row doesn't say what it moved.
  if (/^transfer(_from)?$/.test(row.fnName ?? "")) return `Call ${row.fnName}, which may have moved a token: its amount isn't in this wallet's record`;

  return row.fnName ? `Call ${row.fnName}` : "Contract call";
}

/**
 * An amount with a point and no grouping, exact to its decimals.
 *
 * @param {bigint} units
 * @param {number} decimals
 */
function plainUnits(units, decimals) {
  const digits = units.toString().padStart(decimals + 1, "0");
  const point = digits.length - decimals;
  const fraction = digits.slice(point).replace(/0+$/, "");

  return `${digits.slice(0, point)}${fraction ? `.${fraction}` : ""}`;
}

/**
 * What the wallet's own record says a call to a token did. Null for a record
 * that isn't one, or whose amount can't be read: no amount is made up.
 *
 * @param {ActivityRow} row
 */
function tokenOf(row) {
  const asset = /** @type {any} */ (row.sent?.asset);
  const op = String(asset?.op ?? "").toLowerCase();
  const units = String(asset?.valueUnits ?? asset?.value ?? "");
  const decimals = asset?.decimals;

  if (row.kind !== "contract_call" || asset?.type !== "DRC20" || (op !== "transfer" && op !== "approve")) return null;
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS || !/^\d+$/.test(units)) return null;

  return {
    decimals: /** @type {number} */ (decimals),
    isMax: asset.isMax === true,
    op,
    party: String((op === "approve" ? asset.spender : asset.to) ?? "").trim() || undefined,
    symbol: String(asset.symbol ?? "").trim() || row.contractId || "Token",
    units: BigInt(units),
  };
}

/**
 * The lines of a call to a token: a transfer as what it moved, to whom, and an
 * allowance or a transfer that moved nothing as its fee, saying what it was. What
 * a token moved has no value in DUSK.
 *
 * @param {ActivityRow} row
 * @param {NonNullable<ReturnType<typeof tokenOf>>} token
 * @param {{ fee: bigint | null, own: ReadonlyMap<string, string>, self: ReadonlySet<string> }} context
 * @returns {Line[]}
 */
function tokenLines(row, { decimals, isMax, op, party, symbol, units }, { fee, own, self }) {
  const contract = row.contractId ? `, contract ${row.contractId}` : "";
  // DUSK the call itself moved, as a deposit with a token's call, whatever the token did.
  const native = row.value > 0n ? [{ ...moved(row), words: callWords(row) }] : [];
  const onlyFee = (/** @type {string} */ words) => [...(fee ? [{ ...feeLine(fee, words), counterparty: party }] : []), ...native];

  if (op === "approve") {
    const allowed = isMax ? `Unlimited allowance of ${symbol}` : units === 0n ? `Allowance of ${symbol} removed` : `Allowance of ${plainUnits(units, decimals)} ${symbol}`;

    return onlyFee(`${allowed}${contract}`);
  }

  if (party && self.has(party)) return onlyFee(`Transfer of ${symbol} to the account itself`);
  if (units === 0n) return onlyFee(`Transfer of no ${symbol}${contract}`);

  const other = party ? own.get(party) : undefined;

  return [
    { counterparty: party, fee, sent: units, sentCoin: symbol, sentDecimals: decimals, valued: null, words: `Transfer of ${symbol}${other ? ` to own profile ${other}` : ""}${contract}` },
    ...native,
  ];
}

/**
 * The lines one row of an account's activity makes: most make one. An outcome
 * the chain says failed moved nothing, and its fee stands alone. What's only
 * a fee, a call that moved nothing as it is, is the format's `cost`, and a
 * transfer between the profile's own balances moves nothing either.
 *
 * @param {ActivityRow} row
 * @param {{ own: ReadonlyMap<string, string>, self: ReadonlySet<string>, address: boolean, facts: ReadonlyMap<string, SozuFact> | undefined }} context
 * @returns {Line[]}
 */
function linesOf(row, { address, facts, own, self }) {
  const { fee } = row;
  const onlyFee = (/** @type {string} */ words) => (fee ? [feeLine(fee, words)] : []);
  const other = row.counterparty && !self.has(row.counterparty) ? own.get(row.counterparty) : undefined;

  if (row.status === "failed") return onlyFee(`Failed: ${sozuWord(row) || (row.kind === "contract_call" ? callWords(row) : "transfer")}`);

  const token = tokenOf(row);

  if (token) return tokenLines(row, token, { fee, own, self });
  if (row.sozu) return sozuLines(row, facts?.get(row.hash), fee);
  if (row.kind === "stake") return skipped(row, "stake", "Native stake", fee);
  if (row.kind === "unstake") return skipped(row, "unstake", "Native unstake", fee);
  if (row.kind === "withdraw_reward") return [{ ...moved(row), fee, tag: "reward", words: "Staking rewards claimed" }];

  if (row.kind === "shield" || row.kind === "unshield") {
    const word = row.kind === "shield" ? "Shield" : "Unshield";
    // A shield to the profile's own address, where the app says which that is,
    // and an unshield the profile's shielded history has. A shield received
    // from anyone else is money coming in.
    const fromElsewhere = row.direction === "in" && !(row.counterparty && self.has(row.counterparty));
    const within = row.kind === "shield" ? !fromElsewhere && (!address || !row.counterparty || self.has(row.counterparty)) : row.privacy === "shielded";

    return within ? onlyFee(`${word} of ${formatDuskPlain(row.value)} DUSK, within the profile`) : [{ ...moved(row), fee, words: other ? `${word} ${row.direction === "in" ? "from" : "to"} own profile ${other}` : word }];
  }

  if (row.bridge) return bridgeLines(row, row.bridge, fee);
  if (row.route) return routeLines(row, row.route, fee);
  if (row.direction === "self") return onlyFee("Transfer to the account itself");
  if (row.value === 0n) return onlyFee(row.kind === "contract_call" ? callWords(row) : "Transfer of nothing");

  const words = other ? `Transfer ${row.direction === "in" ? "from" : "to"} own profile ${other}` : row.kind === "contract_call" ? callWords(row) : "";

  return [{ ...moved(row), fee, words }];
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/**
 * A field of the file, quoted when it holds a separator, a quote or a line
 * break.
 *
 * @param {unknown} value
 */
function field(value) {
  const text = String(value ?? "");

  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Text someone else chose, as a memo or a name: nothing in it hides or
 * reorders what it says, line breaks aside, and it's never read as a formula.
 *
 * @param {unknown} value
 */
function textField(value) {
  const { text } = displayText(value ?? "", { lineBreaks: true });

  return field(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
}

/**
 * @param {number} at
 */
const dateOf = (at) => new Date(at).toISOString().slice(0, 19).replace("T", " ");

/**
 * @param {bigint | null | undefined} units
 * @param {number} [decimals] A token's own; DUSK's, unless given
 */
function amountOf(units, decimals) {
  if (units === undefined || units === null) return "";

  return decimals === undefined ? formatDuskPlain(units) : plainUnits(units, decimals);
}

/**
 * A price as digits: its text, a number's in full, or null for what isn't one.
 *
 * @param {unknown} price
 * @returns {{ digits: bigint, places: number } | null}
 */
function priceOf(price) {
  const text = typeof price === "number" ? (Number.isFinite(price) ? price.toFixed(12) : "") : typeof price === "bigint" ? price.toString() : String(price ?? "").trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);

  if (!match) return null;

  const fraction = (match[2] ?? "").slice(0, 18);

  return { digits: BigInt(`${match[1]}${fraction}`), places: fraction.length };
}

/**
 * What an amount of DUSK comes to at a price, in units of `WORTH_DECIMALS`,
 * rounded half up.
 *
 * @param {bigint} lux
 * @param {{ digits: bigint, places: number }} price
 */
const worthUnits = (lux, { digits, places }) => {
  const scale = 10n ** BigInt(LUX_DECIMALS + places);

  return (lux * digits * 10n ** BigInt(WORTH_DECIMALS) + scale / 2n) / scale;
};

/**
 * Units of `WORTH_DECIMALS` as the file writes them: every value to the same
 * 8 decimals, a cent's worth or a fraction of one.
 *
 * @param {bigint} units
 */
function worthText(units) {
  const size = units < 0n ? -units : units;
  const step = 10n ** BigInt(WORTH_DECIMALS);

  return `${units < 0n ? "-" : ""}${size / step}.${(size % step).toString().padStart(WORTH_DECIMALS, "0")}`;
}

/**
 * @param {bigint} lux
 * @param {{ digits: bigint, places: number }} price
 */
const worthOf = (lux, price) => worthText(worthUnits(lux, price));

/**
 * A price lookup that asks once for each time: what one DUSK was worth then,
 * as digits, or null where `price` doesn't say or its lookup fails.
 *
 * @param {ExportOptions["price"]} price
 * @returns {(at: number) => Promise<{ digits: bigint, places: number } | null>}
 */
function pricesOf(price) {
  /** @type {Map<number, Promise<{ digits: bigint, places: number } | null>>} */
  const asked = new Map();

  return (at) => {
    let known = asked.get(at);

    if (!known) {
      known = Promise.resolve()
        .then(() => /** @type {NonNullable<ExportOptions["price"]>} */ (price)({ at, coin: DUSK }))
        .then(priceOf, () => null);
      asked.set(at, known);
    }

    return known;
  };
}

/**
 * A profile's name in a file's name: its letters and digits, without accents.
 *
 * @param {unknown} name
 */
function slugOf(name) {
  const plain = String(name ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");

  return Array.from(plain.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")).slice(0, 60).join("").replace(/-+$/, "");
}

/**
 * @param {ExportOptions} options
 * @returns {Promise<ExportResult>}
 */
export async function accountingCsv({ approvals, bom = false, bridge, contactName, currency = "EUR", evm, evmAddresses, facts, network, period, price, profile, profiles = [], rows }) {
  const account = String(profile?.account ?? "");
  const all = [...(rows ?? [])];
  // The EVM addresses this profile bridged DUSK to, as its rows say: the person's own.
  const bridged = bridgedTo(all);
  // And those the app knows as the person's, where it gives them, as both wallets do: anyone can migrate to an account.
  const given = evmAddresses === undefined || evmAddresses === null ? (bridge ? [] : null) : [...evmAddresses];
  const ownEvm = given === null ? null : new Set([...given.map((address) => String(address ?? "").toLowerCase()), ...bridged]);
  // The migrations this profile's rows were paid for: an approval or a revoke that goes with one of them is this file's.
  const paidHere = new Set(migrationsOf(all).map(({ hash }) => hash));
  // Each migration's side on its own chain and the person's approvals and revokes there, read here where the app doesn't give them.
  const reads = bridge && ownEvm?.size ? bridge : null;
  const asked = migrationsOf(period ? all.filter(({ time }) => typeof time === "number" && time >= period.from) : all).map((migration) => ({ ...migration, approval: reads?.approvalOf?.(migration.hash) ?? null }));
  // Whether each migration's side couldn't be read at all.
  let factsFailed = false;
  /** @type {{ owner: string, chain: string, state: "error" | "beyond" | "unread", from: number | null }[]} */
  const approvalsUnread = [];
  /** @param {string | null | undefined} id A route's */
  const chainNamed = (id) => {
    try {
      return String(/** @type {any} */ (routes(networkOf(/** @type {any} */ (reads?.network))).find((route) => route.id === id))?.chain?.name ?? id ?? "");
    } catch {
      return String(id ?? "");
    }
  };
  const evmFacts =
    evm ??
    (reads && asked.length
      ? await migrationFacts({ cache: reads.cache, fetch: reads.fetch, migrations: asked, network: reads.network, rpcUrl: reads.rpcUrl }).catch(() => {
          factsFailed = true;

          return new Map();
        })
      : undefined);
  // The approvals and revokes, and what of them couldn't be read: an owner's that failed, or that stop at a block, as
  // their read windows did or the RPC keeps nothing older. None of theirs is left out without a word.
  const approvalsRead =
    approvals ??
    (reads && ownEvm
      ? await migrationApprovals({ cache: reads.cache, fetch: reads.fetch, network: reads.network, owners: ownEvm, rpcUrl: reads.rpcUrl }).then(
          ({ approvals: found, reads: done }) => {
            for (const read of done) if (read.state !== "read") approvalsUnread.push({ chain: chainNamed(read.route), from: read.from, owner: read.owner, state: read.state });

            return found;
          },
          () => {
            for (const owner of ownEvm) approvalsUnread.push({ chain: "", from: null, owner, state: "error" });

            return [];
          }
        )
      : undefined);
  // The file of an approval or a revoke whose owner sent no migration: the profile of the person's that bridged DUSK to
  // that owner first, as the archive's memo index lists the transfers naming it; where none did, as an address only
  // connected, their first profile, by its public account. The same profile, whichever of theirs is exported. With no
  // other profile of theirs given, this file is their only one, and has it, with a public account or not.
  const others = profiles.some((each) => typeof each?.account === "string" && each.account !== "" && each.account !== account);
  const people = [...new Set([profile?.account, ...profiles.map((each) => each?.account)].filter((id) => typeof id === "string" && id !== ""))].sort();
  /** @type {MigrationApproval[]} */
  const approvalList = [...(approvalsRead ?? [])];
  const unmigrated = [...new Set(approvalList.filter((approval) => !approval.migration && (!ownEvm || ownEvm.has(approval.owner))).map((approval) => approval.owner))];
  /** @param {string} owner */
  const chainOf = (owner) => String(approvalList.find((approval) => approval.owner === owner)?.chain ?? "");
  // The profile of the person's that bridged DUSK out to each such owner first, as the memo index lists it: that profile's
  // rows say so, and it reads that owner. Null where the index couldn't be read.
  /** @type {Map<string, string> | null} */
  let bridgedFirst = new Map();

  if (unmigrated.length && others && reads?.archive) {
    const senders = await bridgeSenders({ addresses: unmigrated, archive: reads.archive, network: reads.network }).catch(() => null);

    if (!senders) bridgedFirst = null;
    else {
      for (const [owner, list] of senders) {
        const first = list.find((each) => people.includes(each.sender));

        if (first) bridgedFirst.set(owner, first.sender);
      }
    }
  }

  /** @param {string} owner */
  const homeOf = (owner) => (bridgedFirst ? (bridgedFirst.get(owner) ?? people[0]) : null);

  // One booked here, or by the profile the index says bridged to it, which reads it, needs no word. Any other this profile
  // knows of may be another's to book that never reads it, as the first profile, by an address only this one's rows or
  // the app here give, or a deposit to DuskEVM the index doesn't list: whose file it is can't be told, and it's said.
  if (others) {
    for (const owner of unmigrated) {
      if (homeOf(owner) !== account && !bridgedFirst?.has(owner)) approvalsUnread.push({ chain: chainOf(owner), from: null, owner, state: "error" });
    }
  }
  /** @type {ReadonlySet<string>} */
  const self = new Set([profile?.account, profile?.address].flatMap((id) => (typeof id === "string" && id !== "" ? [id] : [])));
  /** @type {Map<string, string>} */
  const own = new Map();

  for (const each of [...profiles, ...(profile ? [profile] : [])]) {
    for (const id of [each?.account, each?.address]) if (typeof id === "string" && id !== "" && each?.name) own.set(id, String(each.name));
  }

  const left = { notRead: 0, outOfPeriod: 0, pending: 0 };
  const priceAt = pricesOf(price);
  let unpriced = 0;
  const chronological = [...all].sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  // The EVM addresses whose gas the file has, and the migrations whose side on their own chain couldn't be read.
  /** @type {Set<string>} */
  const evmBooked = new Set();
  /** @type {{ hash: string, chain: string }[]} */
  const evmUnread = [];
  /** @type {{ at: number, text: string }[]} */
  const written = [];
  let count = 0;
  // The transactions on another chain a migration's own lines have: an approval among them is booked once.
  /** @type {Set<string>} */
  const booked = new Set();
  /** @param {number} at */
  const inPeriod = (at) => !period || (at >= period.from && at < period.to);

  /**
   * Writes a line, of a row where it's one's, in the period of its own time.
   *
   * @param {Line} line
   * @param {ActivityRow | null} row
   */
  const write = async (line, row) => {
    const at = /** @type {number} */ (line.at ?? row?.time);

    if (!inPeriod(at)) return;
    // A line of another chain's names its EVM address as its account.
    if (line.account) evmBooked.add(line.account);

    // A token's own line says who it went to, or that it isn't known: never the contract called.
    const ownParty = "counterparty" in line;
    const party = ownParty ? line.counterparty : row?.counterparty;
    const internal = party && !self.has(party) ? own.get(party) : undefined;
    // The person's own names first, where they asked for them: their contact's over a verified .dusk name.
    const name = line.partyName ?? internal ?? ((party && contactName?.(party)) || null) ?? (ownParty ? null : row?.counterpartyName) ?? (ownParty && !party ? null : row?.toName) ?? "";
    const memo = line.memo ?? row?.memo ?? "";
    const unit = price && line.valued !== null ? await priceAt(at) : null;

    if (price && !unit) unpriced += 1;

    written.push({
      at,
      text: [
        field(dateOf(at)),
        field(amountOf(line.sent, line.sentDecimals)),
        line.sent === undefined ? "" : textField(line.sentCoin),
        field(amountOf(line.received)),
        field(line.received === undefined ? "" : line.receivedCoin),
        field(amountOf(line.fee)),
        field(line.fee ? DUSK : ""),
        field(unit && line.valued !== null ? worthOf(line.valued, unit) : ""),
        field(unit ? currency : ""),
        field(line.tag ?? ""),
        textField([line.words, memo].filter(Boolean).join(" · ")),
        field(line.hash ?? row?.hash),
        textField(line.accountName ?? profile?.name ?? ""),
        field(line.account ?? account),
        textField(name),
        textField(party ?? ""),
        field(internal ? "yes" : ""),
        textField(memo),
      ].join(","),
    });
    count += 1;
  };

  for (const row of chronological) {
    // Never on the chain, so it never happened.
    if (row.dropped) continue;

    if (row.status === "pending" || row.status === "unknown") {
      left[row.status === "pending" ? "pending" : "notRead"] += 1;
      continue;
    }

    if (row.time === null || row.incomplete) {
      left.notRead += 1;
      continue;
    }

    // A migration's side on its own chain, with the payout it was paid with: named by its memo, as text,
    // and, where the app gives the person's EVM addresses, sent from one of them. Another's gas is no cost of theirs.
    const paidFor = row.route?.kind === "migration" && row.direction === "in" ? (memoTextOf(row) ?? "").toLowerCase() : "";
    const fact = paidFor ? evmFacts?.get(paidFor) : undefined;
    const migration = !ownEvm || (fact?.from && ownEvm.has(fact.from.toLowerCase())) ? fact : undefined;
    const unreadHere = fact?.state === "pending" || fact?.state === "error" || (factsFailed && !fact && paidHere.has(paidFor));

    if (unreadHere && (!period || row.time >= period.from)) evmUnread.push({ chain: String(row.route?.chain?.name ?? row.route?.id ?? ""), hash: paidFor });
    const rowIn = inPeriod(row.time);
    const evmOwn = evmLines(row, migration);

    for (const line of evmOwn) booked.add(String(line.hash));

    // Each line goes in the period of its own time: a migration's fees on its
    // own chain may be in one before its payout's, the rest of a row in its.
    if (!rowIn) {
      left.outOfPeriod += 1;
      if (!migration) continue;
    }

    for (const line of [...evmOwn, ...(rowIn ? linesOf(row, { address: Boolean(profile?.address), facts, own, self }) : [])]) await write(line, row);
  }

  // The approvals and revokes on a migration's own chain that no migration's lines have, each once, in the file
  // of the profile its migration paid: one of an owner who sent none, as above.
  for (const approval of approvalList) {
    const here = approval.migration ? paidHere.has(approval.migration) : !others || (account !== "" && homeOf(approval.owner) === account);

    if (here && !booked.has(approval.hash) && approval.at !== null && approval.gasWei !== null && (!ownEvm || ownEvm.has(approval.owner))) await write(approvalLine(approval), null);
  }

  const slug = slugOf(profile?.name) || "profile";
  const on = network && String(network).toLowerCase() !== "mainnet" ? `-${slugOf(network)}` : "";

  return {
    count,
    // Oldest first, as a migration's lines on its own chain come before its payout.
    csv: `${bom ? BOM : ""}${[CSV_COLUMNS.map(field).join(","), ...written.sort((a, b) => a.at - b.at).map((line) => line.text)].join("\r\n")}\r\n`,
    evm: { approvalsUnread, booked: [...evmBooked], unread: evmUnread },
    fileName: `dusk-${slug}${on}-${period?.label ?? "all"}.csv`,
    left,
    unpriced,
  };
}

// ---------------------------------------------------------------------------
// Rewards by year
// ---------------------------------------------------------------------------

/** What each of a year's rewards is called, in the words both wallets show. */
export const REWARD_WORDS = Object.freeze({ claimed: "Native staking, claimed", sozu: "Sozu, taken out by unstaking", sozuGrown: "Sozu, grown while held" });

/** The one line under them both wallets show: what taken out by unstaking is, and how it's counted. */
export const REWARDS_COUNTED = "Taken out by unstaking is part of grown while held: what came back, less what that stDUSK cost at its average price, deposit fees not counted.";

/**
 * How long a stake or an unstake with Sozu waits for its facts before what
 * it did counts as not known: the archive lists a transaction's events a
 * little after its block, a minute or so.
 */
export const FACTS_WAIT_MS = 600_000;

/**
 * A lux in parts fine enough that what a pool's rates leave below a lux
 * adds up to none: rewards are summed in them, and a year's come to whole
 * lux, toward nothing.
 */
const FINE = 10n ** 18n;

/**
 * What an amount of stDUSK was worth at a pool's figures, in `FINE` parts of
 * a lux: one for one in a pool of none, as it mints its first.
 *
 * @param {bigint} stDusk
 * @param {{ stake: bigint, supply: bigint }} pool
 */
const fineWorth = (stDusk, { stake, supply }) => (supply > 0n ? (stDusk * stake * FINE) / supply : stDusk * FINE);

/**
 * A fact's pool figures, which say its rate: null where it has none.
 *
 * @param {SozuFact | undefined} fact
 * @returns {{ stake: bigint, supply: bigint } | null}
 */
const poolOf = (fact) => (typeof fact?.pool?.stake === "bigint" && typeof fact.pool.supply === "bigint" ? fact.pool : null);

/**
 * Lux from a status' figure, as the apps' statuses write one: null for none.
 *
 * @param {unknown} value
 */
const luxIn = (value) => (typeof value === "bigint" ? value : /^\d+$/.test(String(value ?? "")) ? BigInt(String(value)) : null);

/**
 * What one stDUSK is worth now, as a status says it: by what's held. While
 * a stake or an unstake is read (`reading`), what's held now isn't what the
 * year's figures hold, as an unstake that took all of it, or all but a lux,
 * whose worth is a rounding: then by the pool's own figures, where the
 * status has them. Null where it says neither.
 *
 * @param {(SozuStatusLike & { contracts?: { pool?: string | null } | null }) | null | undefined} status
 * @param {boolean} reading
 * @returns {{ stake: bigint, supply: bigint } | null}
 */
function rateNow(status, reading) {
  const { stDusk, worthNow } = sozuPosition({ status });
  const pool = /** @type {Record<string, unknown>} */ (status?.pool ?? {});
  const stake = luxIn(pool.stake ?? pool.totalStakeLux);
  const supply = luxIn(pool.supply ?? pool.tokenTotalSupply);

  if (reading && stake !== null && supply) return { stake, supply };

  return worthNow !== null && stDusk ? { stake: worthNow, supply: stDusk } : null;
}

/**
 * @param {{ rows: Iterable<ActivityRow>, facts?: ReadonlyMap<string, SozuFact>, price?: ExportOptions["price"], timeZone?: string, complete?: boolean, status?: (SozuStatusLike & { contracts?: { pool?: string | null } | null }) | null, archive?: Pick<Archive, "query">, cache?: FactCache, now?: number }} options
 * @returns {Promise<import("./export.js").YearRewards[]>}
 */
export async function rewardsByYear({ archive, cache, complete = true, facts, now = Date.now(), price, rows, status, timeZone }) {
  const yearOf = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" });
  /** @param {number} at */
  const yearAt = (at) => Number(yearOf.format(at));
  const priceAt = pricesOf(price);
  /** @typedef {{ at: number, fine: bigint }} Reward */
  /** @typedef {{ stake: bigint, supply: bigint }} Pool */
  /** @type {Map<number, { claimed: Reward[], sozu: Reward[] | null, reading: number }>} */
  const years = new Map();
  // Sozu's stDUSK held and what it cost, in FINE parts of a lux, while every stake and unstake before is known.
  let held = 0n;
  let cost = 0n;
  let known = complete;
  // What's held after each stake and unstake, at the pool's figures as it went through, while all before it is
  // known; and from when what's held isn't, as from the first of them where the history isn't whole.
  /** @type {{ at: number, held: bigint, pool: Pool }[]} */
  const moves = [];
  /** @type {number | null} */
  let unknownFrom = null;
  const all = [...(rows ?? [])];
  const went = all.filter((row) => row.status === "executed" && !row.dropped && typeof row.time === "number" && (row.kind === "withdraw_reward" || row.sozu));
  // In the chain's order, as far as the rows say it: by block, and within one a stake before an unstake, as the rows don't say which
  // went first and an unstake can't give back stDUSK its own block's stake hadn't minted yet.
  /** @param {ActivityRow} row */
  const blockOf = (row) => [/** @type {number} */ (row.time), row.blockHeight ?? 0, row.sozu === "unstake" ? 1 : 0];
  const inOrder = went.sort((a, b) => {
    const [x, y] = [blockOf(a), blockOf(b)];

    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
  });
  // The newest stakes and unstakes with Sozu, of the last minutes, whose facts the archive doesn't list yet:
  // left out until it does, as one on its way is, so what's said is what was said before them.
  const sozuMoves = inOrder.filter((row) => row.sozu);
  let firstUnread = sozuMoves.length;

  while (complete && facts && firstUnread > 0 && !facts.has(sozuMoves[firstUnread - 1].hash) && now - /** @type {number} */ (sozuMoves[firstUnread - 1].time) <= FACTS_WAIT_MS) firstUnread -= 1;

  const unread = new Set(sozuMoves.slice(firstUnread));
  /** @type {number | null} */
  const readingFrom = firstUnread < sozuMoves.length ? /** @type {number} */ (sozuMoves[firstUnread].time) : null;

  for (const row of inOrder) {
    const at = /** @type {number} */ (row.time);
    const year = yearAt(at);
    const rewards = years.get(year) ?? { claimed: [], reading: 0, sozu: [] };

    years.set(year, rewards);

    if (!row.sozu) {
      rewards.claimed.push({ at, fine: row.value * FINE });
      continue;
    }

    if (unread.has(row)) {
      rewards.reading += 1;
      continue;
    }

    const fact = facts?.get(row.hash);
    const pool = poolOf(fact);

    if (row.sozu === "stake") {
      known &&= fact !== undefined;
      held += fact?.stDusk ?? 0n;
      // What its stDUSK was worth at the rate it was minted at, the deposit fee and the pool's rounding aside;
      // what went in less the fee, where the fact has no rate.
      cost += fact && pool ? fineWorth(fact.stDusk, pool) : (row.value - (fact?.fee ?? 0n)) * FINE;
    } else if (!known || !fact || fact.stDusk > held || held === 0n) {
      known = false;
      rewards.sozu = null;
    } else {
      // An unstake: what its stDUSK was worth at its own rate, as the pool rounds it aside, or what came back where
      // the fact has no rate, beyond what that stDUSK cost on average.
      const spent = (cost * fact.stDusk) / held;

      rewards.sozu?.push({ at, fine: (pool ? fineWorth(fact.stDusk, pool) : row.value * FINE) - spent });
      held -= fact.stDusk;
      cost -= spent;
    }

    // One without the pool's figures says nothing of the rate.
    if (known && pool) moves.push({ at, held, pool });
    else unknownFrom ??= at;
  }

  // What the stDUSK held grew, in each year: between each two moments its rate is known, its stakes and
  // unstakes, each new year, read from the chain, and now, at what the status says it's worth.
  /** @type {Map<number, Reward[] | null>} */
  const grown = new Map();
  /** @param {number} year */
  const grownIn = (year) => {
    const parts = grown.get(year);

    return parts === undefined ? [] : parts;
  };
  const last = moves.at(-1);

  if (last) {
    // Up to now, or to the first stake or unstake still being read: what's held after it isn't known yet.
    const until = unknownFrom ?? (last.held > 0n ? Math.max(readingFrom ?? now, last.at) : last.at);
    const anchors = all.flatMap((row) => (row.status === "executed" && typeof row.time === "number" && typeof row.blockHeight === "number" ? [{ at: row.time, height: row.blockHeight }] : []));
    // The pool the status names, else the one the last stake or unstake called.
    const pool = String(status?.contracts?.pool ?? [...inOrder].reverse().find((row) => row.sozu)?.contractId ?? "");
    const worthNowOf = rateNow(status, readingFrom !== null);
    /** @type {{ at: number, held: bigint, pool: Pool | null | Promise<Pool | null>, yearEnd: boolean }[]} */
    const marks = [];
    let holding = 0n;
    let next = dayStart(yearAt(moves[0].at) + 1, 1, 1, timeZone);

    for (const move of [...moves, null]) {
      // Each new year before it while something is held, at the pool's last restake by then.
      for (; next <= (move?.at ?? until); next = dayStart(yearAt(next) + 1, 1, 1, timeZone)) {
        if (holding > 0n) marks.push({ at: next, held: holding, pool: archive && pool ? sozuPointAt({ anchors, archive, at: next, cache, pool }) : null, yearEnd: true });
      }

      if (move) {
        marks.push({ at: move.at, held: move.held, pool: move.pool, yearEnd: false });
        holding = move.held;
      }
    }

    // Still held, all of it known: now, at what one stDUSK is worth as the status says.
    if (holding > 0n && unknownFrom === null) {
      marks.push({ at: until, held: 0n, pool: worthNowOf, yearEnd: false });
    }

    const pools = await Promise.all(marks.map((mark) => mark.pool));

    for (let i = 0; i + 1 < marks.length; i += 1) {
      const [from, to] = [marks[i], marks[i + 1]];
      const [then, after] = [pools[i], pools[i + 1]];
      const year = yearAt(from.at);
      const parts = grownIn(year);

      if (from.held === 0n || parts === null) continue;

      // Each part at its end's price: a year's own last moment, where a new year ends it.
      grown.set(year, then && after ? [...parts, { at: to.yearEnd ? to.at - 1 : to.at, fine: fineWorth(from.held, after) - fineWorth(from.held, then) }] : null);
    }

    for (const year of grown.keys()) if (!years.has(year)) years.set(year, { claimed: [], reading: 0, sozu: [] });
  }

  /**
   * A year's rewards in whole lux, toward nothing: what's under a lux is no reward, as the pool's rounding in a
   * stake or an unstake is none. Each part brings the lux it takes the year's to, and is worth those at its price.
   *
   * @param {Reward[]} list
   * @returns {Promise<import("./export.js").RewardsSum>}
   */
  const sumOf = async (list) => {
    let fine = 0n;
    let lux = 0n;
    let units = 0n;
    let unpriced = 0;

    for (const part of list) {
      fine += part.fine;

      const brings = fine / FINE - lux;

      lux += brings;

      if (brings === 0n) continue;

      const unit = price ? await priceAt(part.at) : null;

      if (unit) units += brings < 0n ? -worthUnits(-brings, unit) : worthUnits(brings, unit);
      else if (price) unpriced += 1;
    }

    return { lux, unpriced, worth: price ? worthText(units) : null };
  };
  // From the year what's held isn't known on, what it grew isn't either.
  const lost = unknownFrom === null ? Infinity : yearAt(unknownFrom);

  return Promise.all(
    [...years.entries()]
      .sort(([a], [b]) => a - b)
      .map(async ([year, { claimed, reading, sozu }]) => {
        const parts = year >= lost ? null : grownIn(year);

        return { claimed: await sumOf(claimed), reading, sozu: sozu && (await sumOf(sozu)), sozuGrown: parts && (await sumOf(parts)), year };
      })
  );
}
