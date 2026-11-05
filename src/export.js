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
 * Each file is one wallet's view, as the format wants: a transfer between two
 * profiles is a withdrawal in one's file and a deposit in the other's, with
 * the same time, amount and hash, which Koinly merges into a transfer. It has
 * no tag for it: no tag is what keeps it from reading as income.
 *
 * @module
 */

import { formatDuskPlain } from "./amounts.js";
import { displayText } from "./text.js";

/** @typedef {import("./activity.js").ActivityRow} ActivityRow */
/** @typedef {import("./export.js").ExportOptions} ExportOptions */
/** @typedef {import("./export.js").ExportPeriod} ExportPeriod */
/** @typedef {import("./export.js").ExportResult} ExportResult */
/** @typedef {import("./sozu.js").SozuFact} SozuFact */

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
 * @typedef {{ sent?: bigint, sentCoin?: string, received?: bigint, receivedCoin?: string, fee?: bigint | null, tag?: string, words: string, valued: bigint | null }} Line
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
  const { stake, supply } = fact.pool;

  return supply > 0n ? `1 stDUSK = ${formatDuskPlain((1_000_000_000n * stake) / supply)} DUSK` : "";
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
 * The lines of a transfer with one of the bridge's accounts.
 *
 * @param {ActivityRow} row
 * @param {NonNullable<ActivityRow["route"]>} route
 * @param {bigint | null} fee
 * @returns {Line[]}
 */
function routeLines(row, route, fee) {
  const chain = route.chain?.name ?? route.id;
  const bridgeFee = route.kind === "service" ? `, bridge fee ${formatDuskPlain(route.feeLux)} DUSK` : "";

  return [{ ...moved(row), fee, words: row.direction === "in" ? `From ${chain}` : `To ${chain}${bridgeFee}` }];
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
 * What a contract call is, in words.
 *
 * @param {ActivityRow} row
 */
function callWords(row) {
  const named = row.nameCall;

  if (named) return `${named.name ? `${named.name}: ` : ""}${named.kind}`;

  return row.fnName ? `Call ${row.fnName}` : "Contract call";
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

/** @param {bigint | null | undefined} lux */
const amountOf = (lux) => (lux === undefined || lux === null ? "" : formatDuskPlain(lux));

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
 * What an amount of DUSK comes to at a price: to the cent, or where that
 * would read 0, to 8 decimals.
 *
 * @param {bigint} lux
 * @param {{ digits: bigint, places: number }} price
 */
function worthOf(lux, { digits, places }) {
  const scale = 10n ** BigInt(LUX_DECIMALS + places);
  const units = lux * digits;
  /** @param {number} decimals */
  const at = (decimals) => {
    const step = 10n ** BigInt(decimals);
    const rounded = (units * step + scale / 2n) / scale;

    return { rounded, text: `${rounded / step}.${(rounded % step).toString().padStart(decimals, "0")}` };
  };
  const cents = at(2);

  return cents.rounded > 0n || units === 0n ? cents.text : at(8).text.replace(/0+$/, "").replace(/\.$/, ".0");
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
export async function accountingCsv({ bom = false, contactName, currency = "EUR", facts, network, period, price, profile, profiles = [], rows }) {
  const account = String(profile?.account ?? "");
  /** @type {ReadonlySet<string>} */
  const self = new Set([profile?.account, profile?.address].flatMap((id) => (typeof id === "string" && id !== "" ? [id] : [])));
  /** @type {Map<string, string>} */
  const own = new Map();

  for (const each of [...profiles, ...(profile ? [profile] : [])]) {
    for (const id of [each?.account, each?.address]) if (typeof id === "string" && id !== "" && each?.name) own.set(id, String(each.name));
  }

  const left = { notRead: 0, outOfPeriod: 0, pending: 0 };
  /** @type {Map<number, Promise<{ digits: bigint, places: number } | null>>} */
  const prices = new Map();
  let unpriced = 0;
  /** @param {number} at */
  const priceAt = (at) => {
    let known = prices.get(at);

    if (!known) {
      known = Promise.resolve()
        .then(() => /** @type {NonNullable<ExportOptions["price"]>} */ (price)({ at, coin: DUSK }))
        .then(priceOf, () => null);
      prices.set(at, known);
    }

    return known;
  };
  const chronological = [...(rows ?? [])].sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  /** @type {string[]} */
  const lines = [CSV_COLUMNS.map(field).join(",")];
  let count = 0;

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

    if (period && (row.time < period.from || row.time >= period.to)) {
      left.outOfPeriod += 1;
      continue;
    }

    const internal = row.counterparty && !self.has(row.counterparty) ? own.get(row.counterparty) : undefined;
    const name = internal ?? row.counterpartyName ?? row.toName ?? (row.counterparty ? contactName?.(row.counterparty) : "") ?? "";

    for (const line of linesOf(row, { address: Boolean(profile?.address), facts, own, self })) {
      const unit = price && line.valued !== null ? await priceAt(row.time) : null;

      if (price && line.valued !== null && !unit) unpriced += 1;

      lines.push(
        [
          field(dateOf(row.time)),
          field(amountOf(line.sent)),
          field(line.sent === undefined ? "" : line.sentCoin),
          field(amountOf(line.received)),
          field(line.received === undefined ? "" : line.receivedCoin),
          field(amountOf(line.fee)),
          field(line.fee ? DUSK : ""),
          field(unit && line.valued !== null ? worthOf(line.valued, unit) : ""),
          field(unit ? currency : ""),
          field(line.tag ?? ""),
          textField([line.words, row.memo].filter(Boolean).join(" · ")),
          field(row.hash),
          textField(profile?.name ?? ""),
          field(account),
          textField(name),
          field(row.counterparty ?? ""),
          field(internal ? "yes" : ""),
          textField(row.memo ?? ""),
        ].join(",")
      );
      count += 1;
    }
  }

  const slug = slugOf(profile?.name) || "profile";
  const on = network && String(network).toLowerCase() !== "mainnet" ? `-${slugOf(network)}` : "";

  return {
    count,
    csv: `${bom ? BOM : ""}${lines.join("\r\n")}\r\n`,
    fileName: `dusk-${slug}${on}-${period?.label ?? "all"}.csv`,
    left,
    unpriced,
  };
}
