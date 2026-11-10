/**
 * How the Dusk apps write and read amounts, with Intl only: what's shown, and
 * what a field reads back, follow the browser's language together, so an
 * amount reads back as itself or is refused, never as another.
 *
 * The one rule for an amount, of DUSK or an EVM token: a row and a balance
 * line show `text` (`short`), its detail shows `exact`. Most wallets write
 * them so: nobody reads all 18 decimals in a list. `text` rounds down for an
 * amount or a balance, to the nearest for a fee paid, and up for the most a
 * fee can be.
 *
 * @example
 * ```js
 * import { amountExample, formatAmount, formatDusk, readAmount, unclearAmount } from "@dusk/app-core/amounts";
 *
 * formatDusk(1_853_542n, { round: "up" }); // { text: "0.0019", exact: "0.001853542" }
 * formatAmount(90_082_082_000_000_000n, { decimals: 18, round: "down" }); // { text: "0.09", exact: "0.090082082" }
 * readAmount("1 000,5", "fr-FR"); // { lux: 1_000_500_000_000n, problem: null }
 * readAmount("1.001", "nl-NL"); // { lux: null, problem: "Is that 1001 or 1,001? Write the one you mean." }
 * unclearAmount("1.001", ","); // { grouped: "1001", decimal: "1,001" }
 * amountExample("10.5", "fr-FR"); // "10,5"
 * ```
 *
 * @module
 */

/**
 * An amount in units of `decimals` decimals (9 unless given; 18 for an EVM
 * token's wei). `short` (the default): at most 4 decimals, but 2 significant
 * digits under 0.01, and never 0 for an amount that isn't; `exact`: all of
 * them, trailing zeros trimmed. Round `down` for balances and amounts,
 * `nearest` for a fee paid, `up` for the most a fee can be. The locale's
 * separators and digits, by default `amountLocale()`'s; `exact` is always the
 * whole amount, for a detail or a tap to reveal it.
 */
export declare function formatAmount(
  units: bigint | number | string,
  options?: {
    decimals?: number;
    mode?: "short" | "exact";
    round?: "down" | "up" | "nearest";
    locale?: string;
  }
): { text: string; exact: string };

/**
 * An amount of DUSK from lux: `formatAmount`'s rule, with DUSK's 9 decimals.
 */
export declare function formatDusk(
  lux: bigint | number | string,
  options?: {
    mode?: "short" | "exact";
    round?: "down" | "up" | "nearest";
    locale?: string;
  }
): { text: string; exact: string };

/** Every decimal, a point and no grouping: for a file or an input's value. */
export declare function formatDuskPlain(lux: bigint | number | string): string;

/** The browser's language, unless given, with digits a person can type back. */
export declare function amountLocale(language?: string): string;

/**
 * The fiat currency a wallet starts on, by the browser's region: "EUR" where
 * it pays in euros, "USD" anywhere else. The euro's regions are the euro area,
 * Bulgaria in it since 2026; Andorra, Monaco, San Marino, the Vatican,
 * Montenegro and Kosovo; France's overseas regions and the collectivities
 * that use it (GF, GP, MQ, RE, YT, BL, MF, PM, TF); and Åland, the Canary
 * Islands, Ceuta and Melilla. A language without a region takes the one it's
 * most spoken in, as the browser's likely subtags say: "de", "fr", "es", "it"
 * and "nl" are EUR; "en" (the US), "pt" (Brazil) and "sv" (Sweden) are USD.
 * What isn't a language is USD.
 */
export declare function defaultCurrency(language?: string): "EUR" | "USD";

/** How a language writes decimals, in digits a person can type back: the browser's, unless given. */
export declare const decimalSeparator: (language?: string) => string;

/** A whole number grouped as a language groups, in digits a person can type back: "1.484" in Dutch. */
export declare const groupDigits: (whole: bigint | number | string, language?: string) => string;

/** A plain amount for an amount field: in the decimal separator it reads back. */
export declare const amountForField: (plain: string, decimal?: string) => string;

/**
 * A plain amount, such as "10.5", in the language's separators, for an
 * example in a hint: "10,5" in French, "1,234.5" in English. "0.5" unless
 * given. A TypeError for anything but digits and decimals after a point.
 */
export declare function amountExample(plain?: string, language?: string): string;

/**
 * An amount as typed, in the plain form `parseDusk` reads: the language's own
 * groups read too (`language`, the browser's unless given): "1 000,5" with any
 * of French's spaces, "1'000.5" in Swiss German, "12,34,567.89" in Hindi. What
 * could mean either of two amounts (`unclearAmount`) isn't made plain, so it's
 * refused.
 */
export declare function normalizeAmount(text: string, decimal?: string, language?: string): string;

/** The two amounts a text could mean, as the language writes each, or null. */
export declare function unclearAmount(
  text: string,
  decimal?: string
): { grouped: string; decimal: string } | null;

/** A plain amount of DUSK in lux, up to nine decimals; null when it isn't one. */
export declare function parseDusk(plain: string): bigint | null;

/**
 * An amount of DUSK as a person typed it, in the language's reading (the
 * browser's, unless given): the lux it is, or what's wrong with it in plain
 * words: that it could be two amounts, that a space the language doesn't
 * group with is in it ("Leave out the space: 1234,5."), that it has too many
 * decimals, or what an amount looks like. Nothing typed is neither.
 */
export declare function readAmount(text: string, language?: string): { lux: bigint | null; problem: string | null };

/**
 * The amounts of DUSK a search can mean, as what a row shows starts with
 * what's typed: "120" is from 120 up to 121 DUSK, and "0.2" from 0.2 up to
 * 0.3, in lux, `to` left out. It's read in the language's way (the
 * browser's, unless given) and with either decimal mark, so "0.2" and "0,2"
 * are the same in German; where a mark could mean either of two
 * (`unclearAmount`), as "1.000" in German, both are looked for. Empty for
 * what isn't an amount above 0.
 */
export declare function amountsMeant(query: unknown, language?: string): { from: bigint; to: bigint }[];

