/* @ts-self-types="./amounts.d.ts" */
/**
 * How the apps write and read amounts of DUSK, with Intl only: what's shown,
 * and what a field reads back, follow the browser's language together, so an
 * amount reads back as itself or is refused, never as another.
 *
 * @module
 */

const LUX_DECIMALS = 9;
const LUX_PER_DUSK = 10n ** BigInt(LUX_DECIMALS);

/** Decimals a short amount shows, when it's 0.01 DUSK or more. */
const SHORT_DECIMALS = 4;

/** 0.01 DUSK, in lux: under it, a short amount keeps 2 significant digits. */
const SMALL = 10_000_000n;

const MINUS = "−";

/**
 * @typedef {{ decimal: string, digits: string[], whole: Intl.NumberFormat }} LocaleParts
 */

/** @type {Map<string, LocaleParts>} */
const partsByLocale = new Map();

/**
 * How a locale writes a number: its decimal separator, its digits from 0 to
 * 9 and its grouping of whole numbers.
 *
 * @param {string | undefined} locale
 * @returns {LocaleParts}
 */
function localeParts(locale) {
  const key = locale ?? "";
  const known = partsByLocale.get(key);

  if (known) {
    return known;
  }

  const plain = new Intl.NumberFormat(locale, { useGrouping: false });
  const oneToZero = Array.from(plain.format(1234567890));
  const parts = {
    decimal:
      plain.formatToParts(1.5).find((part) => part.type === "decimal")?.value ??
      ".",
    digits: [oneToZero[9], ...oneToZero.slice(0, 9)],
    whole: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
  };

  partsByLocale.set(key, parts);

  return parts;
}

/**
 * @param {unknown} value
 * @returns {bigint}
 */
function luxOf(value) {
  if (typeof value === "bigint") return value;

  if (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && /^\s*-?\d+\s*$/.test(value))
  ) {
    return BigInt(/** @type {number | string} */ (value));
  }

  throw new TypeError("An amount is a whole number of lux");
}

/**
 * Whole DUSK and the digits after the separator, in the locale's writing.
 *
 * @param {boolean} negative
 * @param {bigint} whole
 * @param {string} fraction Latin digits, trailing zeros trimmed
 * @param {string | undefined} locale
 */
function written(negative, whole, fraction, locale) {
  const { decimal, digits, whole: grouped } = localeParts(locale);
  const decimals = Array.from(fraction, (d) => digits[Number(d)]).join("");

  return `${negative ? MINUS : ""}${grouped.format(whole)}${decimals ? `${decimal}${decimals}` : ""}`;
}

/**
 * `lux` (not negative) to `decimals` decimals, rounded as `round` says.
 *
 * @param {bigint} lux
 * @param {number} decimals 0 to 9
 * @param {"down" | "up" | "nearest"} round
 * @returns {{ whole: bigint, fraction: string }}
 */
function rounded(lux, decimals, round) {
  const step = 10n ** BigInt(LUX_DECIMALS - decimals);
  const units =
    round === "down"
      ? lux / step
      : round === "up"
        ? (lux + step - 1n) / step
        : (lux + step / 2n) / step;
  const per = LUX_PER_DUSK / step;

  return {
    fraction:
      decimals === 0
        ? ""
        : (units % per).toString().padStart(decimals, "0").replace(/0+$/, ""),
    whole: units / per,
  };
}

/**
 * The decimals a short amount of `lux` (more than 0) shows: 4 from 0.01
 * DUSK, else as many as give 2 significant digits, up to all 9.
 *
 * @param {bigint} lux
 */
function shortDecimals(lux) {
  if (lux >= SMALL) {
    return SHORT_DECIMALS;
  }

  // A number of k digits in lux has its first significant digit at decimal
  // 10 − k, so its second at 11 − k.
  return Math.min(LUX_DECIMALS, 11 - lux.toString().length);
}

/**
 * `round` applies to the amount's size: down for balances and what can be
 * spent (never more than there is), up for fees (never less than is paid),
 * else to the nearest, half up.
 *
 * @param {bigint | number | string} lux
 * @param {{ mode?: "short" | "exact", round?: "down" | "up" | "nearest", locale?: string }} [options]
 * @returns {{ text: string, exact: string }}
 */
export function formatDusk(
  lux,
  { mode = "short", round = "nearest", locale = amountLocale() } = {}
) {
  if (mode !== "short" && mode !== "exact") {
    throw new RangeError("The mode is short or exact");
  }

  if (round !== "down" && round !== "up" && round !== "nearest") {
    throw new RangeError("Rounding is down, up or nearest");
  }

  const value = luxOf(lux);
  const negative = value < 0n;
  const size = negative ? -value : value;
  const all = rounded(size, LUX_DECIMALS, "down");
  const exact = written(negative && size > 0n, all.whole, all.fraction, locale);

  if (mode === "exact" || size === 0n) {
    return { exact, text: exact };
  }

  const short = rounded(size, shortDecimals(size), round);

  return {
    exact,
    text: written(negative, short.whole, short.fraction, locale),
  };
}

/**
 * @param {bigint | number | string} lux
 * @returns {string}
 */
export function formatDuskPlain(lux) {
  const value = luxOf(lux);
  const size = value < 0n ? -value : value;
  const { fraction, whole } = rounded(size, LUX_DECIMALS, "down");

  return `${value < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** @type {Map<string, string>} */
const amountLocales = new Map();

/**
 * The browser's language with digits a person can type back: an amount is
 * written in it where it's read back too.
 *
 * @param {string} [language] The browser's, unless given
 * @returns {string}
 */
export function amountLocale(language = globalThis.navigator?.language || "en-US") {
  let locale = amountLocales.get(language);

  if (!locale) {
    try {
      locale = new Intl.Locale(language, { numberingSystem: "latn" }).toString();
    } catch {
      // A language Intl can't read: English.
      locale = "en-US";
    }

    amountLocales.set(language, locale);
  }

  return locale;
}

/**
 * @param {string} [language] The browser's, unless given
 * @returns {string} How the language writes decimals, in digits a person can type back
 */
export const decimalSeparator = (language) => localeParts(amountLocale(language)).decimal;

/**
 * @param {bigint | number | string} whole A whole number
 * @param {string} [language] The browser's, unless given
 * @returns {string} It grouped as the language groups, in digits a person can type back: "1.484" in Dutch
 */
export const groupDigits = (whole, language) =>
  localeParts(amountLocale(language)).whole.format(BigInt(whole));

/**
 * A plain amount, such as `formatDuskPlain` gives, for an amount field: in
 * the decimal separator the field reads back.
 *
 * @param {string} plain
 * @param {string} [decimal] `decimalSeparator()`, unless given
 * @returns {string}
 */
export const amountForField = (plain, decimal = decimalSeparator()) =>
  String(plain ?? "").replace(".", decimal);

/**
 * An amount as typed, in the plain form `parseDusk` reads: a decimal comma
 * made a point, and digit grouping left out where it can't be decimals. "1,5"
 * is 1.5, "1.000,5" and "1,000.5" are 1000.5, and "1,000,000" is a million.
 * One separator before three digits is a decimal where the language writes
 * decimals with it. Otherwise it could mean either (`unclearAmount`), so it
 * isn't made plain and `parseDusk` refuses it, as it does what isn't an amount.
 *
 * @param {string} text
 * @param {string} [decimal] `decimalSeparator()`, unless given
 * @returns {string}
 */
export function normalizeAmount(text, decimal = decimalSeparator()) {
  const value = String(text ?? "").trim();
  const commaDecimals = decimal === ",";

  // Groups of three after a first group that doesn't start with a zero.
  if (/^[1-9]\d{0,2}(,\d{3})+\.\d*$/.test(value)) return value.replaceAll(",", "");
  if (/^[1-9]\d{0,2}(\.\d{3})+,\d*$/.test(value)) return value.replaceAll(".", "").replace(",", ".");
  if (/^[1-9]\d{0,2}(,\d{3}){2,}$/.test(value)) return value.replaceAll(",", "");
  if (commaDecimals && /^[1-9]\d{0,2}(\.\d{3}){2,}$/.test(value)) return value.replaceAll(".", "");

  if (unclearAmount(value, decimal)) return commaDecimals ? value.replace(".", ",") : value;

  return /^\d*,\d*$/.test(value) ? value.replace(",", ".") : value;
}

/**
 * The two amounts a text could mean, where the language's other separator
 * stands before three digits, or null. In Dutch "1.001" could be a thousand
 * and one or, as a point is often typed for decimals, just over one.
 *
 * @param {string} text
 * @param {string} [decimal] `decimalSeparator()`, unless given
 * @returns {{ grouped: string, decimal: string } | null} As the language writes each
 */
export function unclearAmount(text, decimal = decimalSeparator()) {
  const value = String(text ?? "").trim();
  const either = (decimal === "," ? /^([1-9]\d{0,2})\.(\d{3})$/ : /^([1-9]\d{0,2}),(\d{3})$/).exec(value);

  return either ? { decimal: `${either[1]}${decimal}${either[2]}`, grouped: `${either[1]}${either[2]}` } : null;
}

/**
 * A plain amount of DUSK in lux: digits, with up to nine decimals after a
 * point. Null when it isn't one.
 *
 * @param {string} plain What `normalizeAmount` gives
 * @returns {bigint | null}
 */
export function parseDusk(plain) {
  const value = String(plain ?? "").trim();

  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(value)) return null;

  const [whole, fraction = ""] = value.split(".");

  if (fraction.length > LUX_DECIMALS) return null;

  return BigInt(whole || "0") * LUX_PER_DUSK + BigInt(fraction.padEnd(LUX_DECIMALS, "0"));
}
