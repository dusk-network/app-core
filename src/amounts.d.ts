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
 * readAmount("1.000", "en-GB");
 * // { lux: null, problem: "Is that 1 or 1000? Write the one you mean.", question: "Is that 1 or 1000?",
 * //   choices: [{ field: "1", lux: 1_000_000_000n }, { field: "1000", lux: 1_000_000_000_000n }] }
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

/** A currency the apps' price source gives DUSK's price in, by its ISO 4217 code. */
export type PriceCurrency =
  | "AED" | "ARS" | "AUD" | "BDT" | "BHD" | "BMD" | "BRL" | "CAD" | "CHF" | "CLP" | "CNY" | "CZK" | "DKK" | "EUR" | "GBP"
  | "GEL" | "HKD" | "HUF" | "IDR" | "ILS" | "INR" | "JPY" | "KRW" | "KWD" | "LKR" | "MMK" | "MXN" | "MYR" | "NGN" | "NOK"
  | "NZD" | "PHP" | "PKR" | "PLN" | "RUB" | "SAR" | "SEK" | "SGD" | "THB" | "TRY" | "TWD" | "UAH" | "USD" | "VND" | "ZAR";

/**
 * The currencies the apps' price source, CoinGecko, gives DUSK's price in,
 * as its list of them said in November 2026, in alphabetical order: all of
 * its own but the bolívar Venezuela no longer pays in (VEF), gold, silver,
 * the IMF's drawing right and coins. What a wallet offers to show values in.
 */
export declare const PRICE_CURRENCIES: ReadonlyArray<PriceCurrency>;

/**
 * The fiat currency a wallet starts on, by the browser's region: the one it
 * pays in, where the price source gives DUSK's price in it, as "SGD" in
 * Singapore, "INR" in India and "CHF" in Switzerland; "USD" anywhere else.
 * The euro's regions are the euro area, Bulgaria in it since 2026; Andorra,
 * Monaco, San Marino, the Vatican, Montenegro and Kosovo; France's overseas
 * regions and the collectivities that use it (GF, GP, MQ, RE, YT, BL, MF,
 * PM, TF); and Åland, the Canary Islands, Ceuta and Melilla. A territory
 * that pays in another country's currency takes that one, as the Faroes
 * take Danish kroner. A language without a region takes the one it's most
 * spoken in, as the browser's likely subtags say: "de" and "fr" are EUR,
 * "pt" (Brazil) BRL, "ja" JPY, "en" (the US) USD. What isn't a language is
 * USD.
 */
export declare function defaultCurrency(language?: string): PriceCurrency;

/** How a language writes decimals, in digits a person can type back: the browser's, unless given. */
export declare const decimalSeparator: (language?: string) => string;

/** A whole number grouped as a language groups, in digits a person can type back: "1.484" in Dutch. */
export declare const groupDigits: (whole: bigint | number | string, language?: string) => string;

/**
 * A plain amount for an amount field: in the decimal separator it reads
 * back. One as `formatDuskPlain` writes it, whose three decimals would read
 * as a group of thousands (`unclearAmount`), has a fourth, a zero, so the
 * field reads it as it is: "1.234" is "1.2340" in English and "1,2340" in
 * German. One written otherwise, as "1.000", stays as it's written, for the
 * field to ask which is meant. Every amount a wallet works out and puts in a
 * field goes through it: Max, Send back's, a send's kept to send again. A
 * link's is read as typing reads it (`linkAmount` of `/payment-links`).
 */
export declare function amountForField(plain: string, decimal?: string): string;

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
 * could mean either of two amounts (`unclearAmount`), in any language, isn't
 * made plain, so it's refused.
 */
export declare function normalizeAmount(text: string, decimal?: string, language?: string): string;

/**
 * The two amounts a text could mean, as the language writes each, or null:
 * where a lone point or comma stands before three digits, after a whole part
 * of one to three digits that isn't 0, in any language, as a point is often
 * typed for decimals where a comma is the language's, and the other way
 * round. "1.000" and "1,000" are one or a thousand in English and in German
 * alike; "0.500", "1.25" and "1.2345" are what they say.
 */
export declare function unclearAmount(
  text: string,
  decimal?: string
): { grouped: string; decimal: string } | null;

/** A plain amount of DUSK in lux, up to nine decimals; null when it isn't one. */
export declare function parseDusk(plain: string): bigint | null;

/**
 * An amount of DUSK as a person typed it, in the language's reading (the
 * browser's, unless given): the lux it is, or what's wrong with it in plain
 * words: that it could be two amounts (`unclearAmount`, in any language: "1.000"
 * asks on an English phone as "1,000" does), each said as no reader takes it
 * for the other, exactly, and as each can be written to mean it ("Is that 1
 * or 1000?", "Is that 2.1250 or 2125?"; never "1.000" for one, nor "about
 * 2.13"), that a space the language doesn't
 * group with is in it ("Leave out the space: 1234,5."), that it has too many
 * decimals, or what an amount looks like. Nothing typed is neither.
 *
 * Where it could be two, the question alone (`question`, "Is that 2.1250 or
 * 2125?", which `problem` follows with "Write the one you mean.") and the two
 * to choose from (`choices`), the decimal one first: each as the field is
 * to hold it, which reads back as that amount without the question
 * (`field`, "2.1250" and "2125"), and in lux (`lux`), for a button each.
 */
export declare function readAmount(text: string, language?: string): AmountRead;

/** One of two amounts a text could mean: as a field writes it, so it reads back as that amount, and in lux. */
export type AmountChoice = { field: string; lux: bigint };

/** What `readAmount` reads: the amount, or what's wrong; and where it could be two, the question and the two. */
export type AmountRead =
  | { lux: bigint | null; problem: string | null; question?: undefined; choices?: undefined }
  | { lux: null; problem: string; question: string; choices: [AmountChoice, AmountChoice] };

/**
 * The amounts of DUSK a search can mean, as what a row shows starts with
 * what's typed: "120" is from 120 up to 121 DUSK, and "0.2" from 0.2 up to
 * 0.3, in lux, `to` left out. It's read in the language's way (the
 * browser's, unless given) and with either decimal mark, so "0.2" and "0,2"
 * are the same in German; where a mark could mean either of two
 * (`unclearAmount`), as "1.000" in any language, both are looked for. Empty for
 * what isn't an amount above 0.
 */
export declare function amountsMeant(query: unknown, language?: string): { from: bigint; to: bigint }[];

