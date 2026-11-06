/* @ts-self-types="./amounts.d.ts" */
/**
 * How the apps write and read amounts, with Intl only: what's shown, and what
 * a field reads back, follow the browser's language together, so an amount
 * reads back as itself or is refused, never as another.
 *
 * @module
 */

const LUX_DECIMALS = 9;
const LUX_PER_DUSK = 10n ** BigInt(LUX_DECIMALS);
const MAX_U64 = (1n << 64n) - 1n;

/** Decimals a short amount shows, when it's 0.01 or more. */
const SHORT_DECIMALS = 4;

const MINUS = "−";

/**
 * What separates a language's groups of digits, wherever one can't be taken
 * for a decimal: its spaces, the no-break and narrow ones as well, and its
 * apostrophes, straight or not.
 */
const SPACES = /[ \u00a0\u2009\u202f]/g;
const APOSTROPHES = /['\u2019]/g;

/**
 * @typedef {{ decimal: string, digits: string[], groups: Intl.NumberFormat, whole: Intl.NumberFormat }} LocaleParts
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
    // Every group, as Polish and Spanish leave a thousand's out when they write one.
    groups: new Intl.NumberFormat(locale, /** @type {Intl.NumberFormatOptions} */ ({ maximumFractionDigits: 0, useGrouping: /** @type {any} */ ("always") })),
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

  throw new TypeError("An amount is a whole number of its smallest unit");
}

/**
 * The whole part and the digits after the separator, in the locale's writing.
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
 * `amount` (not negative), in units of `places` decimals, to `decimals`
 * decimals, rounded as `round` says.
 *
 * @param {bigint} amount
 * @param {number} places The decimals its units have
 * @param {number} decimals 0 to `places`
 * @param {"down" | "up" | "nearest"} round
 * @returns {{ whole: bigint, fraction: string }}
 */
function rounded(amount, places, decimals, round) {
  const step = 10n ** BigInt(places - decimals);
  const units =
    round === "down"
      ? amount / step
      : round === "up"
        ? (amount + step - 1n) / step
        : (amount + step / 2n) / step;
  const per = 10n ** BigInt(decimals);

  return {
    fraction:
      decimals === 0
        ? ""
        : (units % per).toString().padStart(decimals, "0").replace(/0+$/, ""),
    whole: units / per,
  };
}

/**
 * The decimals a short amount (more than 0) of `places` decimals shows: 4
 * from 0.01, else as many as give 2 significant digits, up to all of them.
 *
 * @param {bigint} amount
 * @param {number} places
 */
function shortDecimals(amount, places) {
  if (places <= SHORT_DECIMALS || amount >= 10n ** BigInt(places - 2)) {
    return Math.min(SHORT_DECIMALS, places);
  }

  // A number of k digits has its first significant digit at decimal
  // places + 1 − k, so its second at places + 2 − k.
  return Math.min(places, places + 2 - amount.toString().length);
}

/**
 * An amount in units of `decimals` decimals, as `formatAmount` says. `round`
 * applies to the amount's size: down for balances and what can be spent
 * (never more than there is), up for fees' maxima (never less than is paid),
 * else to the nearest, half up.
 *
 * @param {bigint | number | string} units
 * @param {{ decimals?: number, mode?: "short" | "exact", round?: "down" | "up" | "nearest", locale?: string }} [options]
 * @returns {{ text: string, exact: string }}
 */
export function formatAmount(
  units,
  { decimals = LUX_DECIMALS, mode = "short", round = "nearest", locale = amountLocale() } = {}
) {
  if (mode !== "short" && mode !== "exact") {
    throw new RangeError("The mode is short or exact");
  }

  if (round !== "down" && round !== "up" && round !== "nearest") {
    throw new RangeError("Rounding is down, up or nearest");
  }

  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new RangeError("An amount's decimals are a whole number");
  }

  const value = luxOf(units);
  const negative = value < 0n;
  const size = negative ? -value : value;
  const all = rounded(size, decimals, decimals, "down");
  const exact = written(negative && size > 0n, all.whole, all.fraction, locale);

  if (mode === "exact" || size === 0n) {
    return { exact, text: exact };
  }

  const short = rounded(size, decimals, shortDecimals(size, decimals), round);

  return {
    exact,
    text: written(negative, short.whole, short.fraction, locale),
  };
}

/**
 * @param {bigint | number | string} lux
 * @param {{ mode?: "short" | "exact", round?: "down" | "up" | "nearest", locale?: string }} [options]
 * @returns {{ text: string, exact: string }}
 */
export const formatDusk = (lux, options) => formatAmount(lux, { ...options, decimals: LUX_DECIMALS });

/**
 * @param {bigint | number | string} lux
 * @returns {string}
 */
export function formatDuskPlain(lux) {
  const value = luxOf(lux);
  const size = value < 0n ? -value : value;
  const { fraction, whole } = rounded(size, LUX_DECIMALS, LUX_DECIMALS, "down");

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
 * The regions that pay in euros: the euro area, Bulgaria in it since 2026;
 * the states that use it by agreement or on their own; France's overseas
 * regions and the collectivities that use it; and the parts of Finland and
 * Spain that are regions of their own to a browser.
 */
const EURO_REGIONS = new Set([
  ...["AT", "BE", "BG", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"],
  ...["AD", "MC", "SM", "VA", "ME", "XK"],
  ...["GF", "GP", "MQ", "RE", "YT", "BL", "MF", "PM", "TF"],
  ...["AX", "IC", "EA"],
]);

/**
 * @param {string} [language] The browser's, unless given
 * @returns {"EUR" | "USD"}
 */
export function defaultCurrency(language = globalThis.navigator?.language || "en-US") {
  try {
    const locale = new Intl.Locale(language);
    // A language alone: the region it's most spoken in.
    const region = locale.region ?? locale.maximize().region;

    return region && EURO_REGIONS.has(region.toUpperCase()) ? "EUR" : "USD";
  } catch {
    return "USD";
  }
}

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
 * A plain amount, such as "10.5", written with the language's separators, for
 * an example in a hint: "10,5" in French, "1,234.5" in English, "1.234,5" in
 * Dutch. It reads back as that amount where it's more than a lone separator
 * could leave unclear, as anything with decimals is.
 *
 * @param {string} [plain] Digits, and decimals after a point: "0.5", unless given
 * @param {string} [language] The browser's, unless given
 * @returns {string}
 */
export function amountExample(plain = "0.5", language) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(plain));

  if (!match) throw new TypeError("An example is digits, and decimals after a point");

  const { decimal, digits, whole } = localeParts(amountLocale(language));
  const fraction = Array.from(match[2] ?? "", (d) => digits[Number(d)]).join("");

  return `${whole.format(BigInt(match[1]))}${fraction ? `${decimal}${fraction}` : ""}`;
}

/**
 * A text's whole part with its groups as the language writes them, in the
 * plain form, with its decimals: "1 000,5" in French, however the space was
 * typed, "1\u2019000.5" in Swiss German, "12,34,567.89" in Hindi. Null for
 * anything else: another group's size, or another language's separators.
 *
 * @param {string} value
 * @param {string} decimal
 * @param {string | undefined} language
 * @returns {string | null}
 */
function languageGrouped(value, decimal, language) {
  const [wholeText, fraction, ...rest] = value.split(decimal);
  const digits = wholeText.replace(SPACES, "").replace(APOSTROPHES, "").replaceAll(",", "").replaceAll(".", "");

  if (rest.length || digits === wholeText || !/^[1-9]\d*$/.test(digits) || !/^\d*$/.test(fraction ?? "")) return null;

  /** @param {string} text */
  const same = (text) => text.replace(SPACES, " ").replace(APOSTROPHES, "'");
  const { groups } = localeParts(amountLocale(language));

  return same(groups.format(BigInt(digits))) === same(wholeText) ? `${digits}${fraction === undefined ? "" : `.${fraction}`}` : null;
}

/**
 * An amount as typed, in the plain form `parseDusk` reads: a decimal comma
 * made a point, and digit grouping left out where it can't be decimals. "1,5"
 * is 1.5, "1.000,5" and "1,000.5" are 1000.5, and "1,000,000" is a million;
 * so are the language's own groups: "1 000" in French, "1'000" in Swiss
 * German, "12,34,567" in Hindi. One separator before three digits is a
 * decimal where the language writes decimals with it. Otherwise it could mean
 * either (`unclearAmount`), so it isn't made plain and `parseDusk` refuses
 * it, as it does what isn't an amount.
 *
 * @param {string} text
 * @param {string} [decimal] The language's, unless given
 * @param {string} [language] The browser's, unless given: whose groups are read
 * @returns {string}
 */
export function normalizeAmount(text, decimal, language) {
  const separator = decimal ?? decimalSeparator(language);
  const value = String(text ?? "").trim();
  const commaDecimals = separator === ",";

  // Groups of three after a first group that doesn't start with a zero.
  if (/^[1-9]\d{0,2}(,\d{3})+\.\d*$/.test(value)) return value.replaceAll(",", "");
  if (/^[1-9]\d{0,2}(\.\d{3})+,\d*$/.test(value)) return value.replaceAll(".", "").replace(",", ".");
  if (/^[1-9]\d{0,2}(,\d{3}){2,}$/.test(value)) return value.replaceAll(",", "");
  if (commaDecimals && /^[1-9]\d{0,2}(\.\d{3}){2,}$/.test(value)) return value.replaceAll(".", "");

  if (unclearAmount(value, separator)) return commaDecimals ? value.replace(".", ",") : value;

  return languageGrouped(value, separator, language) ?? (/^\d*,\d*$/.test(value) ? value.replace(",", ".") : value);
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

/**
 * An amount of DUSK as a person typed it, in the language's reading: the lux
 * it is, or what's wrong with it in plain words. Nothing typed is neither.
 *
 * @param {string} text
 * @param {string} [language] The browser's, unless given
 * @returns {{ lux: bigint | null, problem: string | null }}
 */
export function readAmount(text, language) {
  const typed = String(text ?? "").trim();

  if (!typed) return { lux: null, problem: null };

  const decimal = decimalSeparator(language);
  const either = unclearAmount(typed, decimal);

  if (either) return { lux: null, problem: `Is that ${either.grouped} or ${either.decimal}? Write the one you mean.` };

  const plain = normalizeAmount(typed, decimal, language);
  const lux = parseDusk(plain);

  if (lux === null) {
    return {
      lux: null,
      problem: /^\d*\.\d+$/.test(plain) ? `DUSK has ${LUX_DECIMALS} decimals at most.` : `Enter an amount such as 10 or ${amountExample("10.5", language)}.`,
    };
  }

  if (lux === 0n) return { lux: null, problem: "Enter an amount greater than 0." };
  if (lux > MAX_U64) return { lux: null, problem: "That amount is too large." };

  return { lux, problem: null };
}
