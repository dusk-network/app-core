/**
 * How the Dusk apps write and read amounts of DUSK, with Intl only: what's
 * shown, and what a field reads back, follow the browser's language together,
 * so an amount reads back as itself or is refused, never as another.
 *
 * @example
 * ```js
 * import { formatDusk, normalizeAmount, parseDusk, unclearAmount } from "@dusk/app-core/amounts";
 *
 * formatDusk(1_853_542n, { round: "up" }); // { text: "0.0019", exact: "0.001853542" }
 * parseDusk(normalizeAmount("1,5", ",")); // 1_500_000_000n
 * unclearAmount("1.001", ","); // { grouped: "1001", decimal: "1,001" }
 * ```
 *
 * @module
 */

/**
 * An amount of DUSK from lux. `short` (the default): at most 4 decimals, but
 * 2 significant digits under 0.01, and never 0 for an amount that isn't;
 * `exact`: all 9, trailing zeros trimmed. Round `down` for balances, `up`
 * for fees. The locale's separators and digits, by default `amountLocale()`'s;
 * `exact` is always the whole amount, for a title or a tap to reveal it.
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

/** How a language writes decimals, in digits a person can type back: the browser's, unless given. */
export declare const decimalSeparator: (language?: string) => string;

/** A whole number grouped as a language groups, in digits a person can type back: "1.484" in Dutch. */
export declare const groupDigits: (whole: bigint | number | string, language?: string) => string;

/** A plain amount for an amount field: in the decimal separator it reads back. */
export declare const amountForField: (plain: string, decimal?: string) => string;

/**
 * An amount as typed, in the plain form `parseDusk` reads. What could mean
 * either of two amounts (`unclearAmount`) isn't made plain, so it's refused.
 */
export declare function normalizeAmount(text: string, decimal?: string): string;

/** The two amounts a text could mean, as the language writes each, or null. */
export declare function unclearAmount(
  text: string,
  decimal?: string
): { grouped: string; decimal: string } | null;

/** A plain amount of DUSK in lux, up to nine decimals; null when it isn't one. */
export declare function parseDusk(plain: string): bigint | null;
