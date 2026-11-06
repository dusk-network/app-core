import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  amountExample,
  amountForField,
  amountLocale,
  decimalSeparator,
  defaultCurrency,
  formatAmount,
  formatDusk,
  formatDuskPlain,
  groupDigits,
  normalizeAmount,
  parseDusk,
  readAmount,
  unclearAmount,
} from "../src/amounts.js";

describe("amounts", () => {
  it("shows at most 4 decimals, and 2 significant digits under 0.01", () => {
    assert.deepEqual(formatDusk(1_853_542n, { locale: "en" }), { exact: "0.001853542", text: "0.0019" });

    for (const [lux, text] of [
      [173_852_610_026n, "173.8526"],
      [99_999n, "0.0001"],
      [12_345n, "0.000012"],
      [1n, "0.000000001"],
      [9_999_999n, "0.01"],
      [10_000_000n, "0.01"],
      [1_500_000_000n, "1.5"],
      [0n, "0"],
      ["-500000000", "−0.5"],
    ]) {
      assert.equal(formatDusk(lux, { locale: "en" }).text, text, String(lux));
    }
  });

  it("rounds down for balances, up for fees, and to the nearest otherwise", () => {
    for (const [lux, round, text] of /** @type {const} */ ([
      [1_853_542n, "down", "0.0018"],
      [1_853_542n, "up", "0.0019"],
      [1_850_000n, undefined, "0.0019"],
      [99_999n, "down", "0.000099"],
      [173_852_650_000n, "down", "173.8526"],
      [173_852_610_001n, "up", "173.8527"],
    ])) {
      assert.equal(formatDusk(lux, { locale: "en", round }).text, text, `${lux} ${round}`);
    }
  });

  it("never shows an amount that isn't 0 as 0, nor past it the wrong way", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };

    for (let i = 0; i < 3000; i++) {
      const lux = BigInt(next()) ** BigInt(1 + (i % 3)) / BigInt(1 + (next() % 1000));

      if (lux === 0n) continue;

      const exact = Number(formatDuskPlain(lux));
      const down = Number(formatDusk(lux, { locale: "en", round: "down" }).text.replaceAll(",", ""));
      const up = Number(formatDusk(lux, { locale: "en", round: "up" }).text.replaceAll(",", ""));

      assert.ok(down > 0 && up > 0, String(lux));
      assert.ok(down <= exact && up >= exact, String(lux));
    }
  });

  it("gives the exact amount too, all 9 decimals with the zeros trimmed", () => {
    assert.deepEqual(formatDusk(173_852_610_026n, { locale: "en", mode: "exact" }), {
      exact: "173.852610026",
      text: "173.852610026",
    });
    assert.equal(formatDusk(1_000_000_000n, { mode: "exact", locale: "en" }).text, "1");
    assert.equal(formatDusk(123_456_789_012_345_678n, { locale: "en" }).exact, "123,456,789.012345678");
  });

  it("writes the separators and digits of the locale", () => {
    assert.deepEqual(formatDusk(173_852_610_026n, { locale: "nl-NL" }), {
      exact: "173,852610026",
      text: "173,8526",
    });
    assert.equal(formatDusk(123_456_789_012_345_678n, { locale: "de-DE" }).text, "123.456.789,0123");
    assert.equal(formatDusk(123_456_789_012_345_678n, { locale: "fr-FR" }).text, "123 456 789,0123");
    assert.equal(formatDusk(123_456_789_012_345_678n, { locale: "en-IN" }).text, "12,34,56,789.0123");
    assert.equal(formatDusk(1_853_542n, { locale: "ar-EG" }).text, "٠٫٠٠١٩");
  });

  it("writes a file's amount with a point and no grouping", () => {
    assert.equal(formatDuskPlain(173_852_610_026n), "173.852610026");
    assert.equal(formatDuskPlain(-1n), "-0.000000001");
    assert.equal(formatDuskPlain(1_234_000_000_000n), "1234");
    assert.equal(formatDuskPlain(0), "0");
  });

  it("refuses what isn't a whole number of lux", () => {
    for (const bad of [1.5, "1.5", "abc", null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      assert.throws(() => formatDusk(/** @type {any} */ (bad)), TypeError);
    }
    assert.throws(() => formatDusk(1n, { mode: /** @type {any} */ ("long") }), RangeError);
    assert.throws(() => formatDusk(1n, { round: /** @type {any} */ ("half") }), RangeError);
    assert.throws(() => formatAmount(1n, { decimals: -1 }), RangeError);
  });

  it("writes an EVM token's amount by the same rule as DUSK's: short in a row, exact in its detail", () => {
    const WEI_PER_LUX = 1_000_000_000n;

    // The same amount reads the same whichever chain it's on.
    for (const lux of [53_082_083n, 90_082_082n, 190_082_082n, 1n, 1_484_923_500_000n]) {
      assert.deepEqual(
        formatAmount(lux * WEI_PER_LUX, { decimals: 18, locale: "en", round: "down" }),
        formatDusk(lux, { locale: "en", round: "down" }),
        String(lux)
      );
    }

    // Never all 18 decimals in a row, however many it has; all of them in the detail.
    assert.deepEqual(formatAmount(190_082_082_123_456_789n, { decimals: 18, locale: "en", round: "down" }), { exact: "0.190082082123456789", text: "0.19" });
    assert.deepEqual(formatAmount(1_859_281_123_456_789n, { decimals: 18, locale: "en" }), { exact: "0.001859281123456789", text: "0.0019" });
    // Gas of a fraction of a coin keeps two significant digits, and a wei isn't 0.
    assert.equal(formatAmount(210_000_000_000_123n, { decimals: 18, locale: "en" }).text, "0.00021");
    assert.equal(formatAmount(1n, { decimals: 18, locale: "en" }).text, "0.000000000000000001");
    assert.equal(formatAmount(1_500_000_000_000_000_000_000n, { decimals: 18, locale: "nl-NL" }).text, "1.500");
    // Fewer decimals than the short form shows.
    assert.equal(formatAmount(123_456n, { decimals: 2, locale: "en" }).text, "1,234.56");
    assert.equal(formatAmount(5n, { decimals: 0, locale: "en" }).text, "5");
  });
});

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const inLanguage = (/** @type {string} */ language) =>
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language } });

describe("reading amounts", () => {
  afterEach(() => {
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  });

  const read = (/** @type {string} */ text, /** @type {string} */ decimal) => parseDusk(normalizeAmount(text, decimal));
  const DUSK = 1_000_000_000n;

  it("reads what a Dutch person writes", () => {
    assert.equal(read("1,5", ","), (15n * DUSK) / 10n);
    assert.equal(read("1,001", ","), 1_001_000_000n);
    assert.equal(read("1.001,5", ","), 1_001_500_000_000n);
    assert.equal(read("1.000.000", ","), 1_000_000n * DUSK);
    assert.equal(read(",5", ","), DUSK / 2n);
    assert.equal(read("1,", ","), DUSK);
  });

  it("reads what an English person writes", () => {
    assert.equal(read("1.5", "."), (15n * DUSK) / 10n);
    assert.equal(read("1.001", "."), 1_001_000_000n);
    assert.equal(read("1,001.5", "."), 1_001_500_000_000n);
    assert.equal(read("1,000,000", "."), 1_000_000n * DUSK);
    assert.equal(read(".5", "."), DUSK / 2n);
    assert.equal(read("1.", "."), DUSK);
  });

  it("takes either way of writing decimals where only one reading is possible", () => {
    assert.equal(read("1.5", ","), (15n * DUSK) / 10n);
    assert.equal(read("1,5", "."), (15n * DUSK) / 10n);
    assert.equal(read("0,123", "."), 123_000_000n);
    assert.equal(read("0.123", ","), 123_000_000n);
    assert.equal(read("1.000,5", "."), 1_000_500_000_000n);
    assert.equal(read("1,000.5", ","), 1_000_500_000_000n);
  });

  it("refuses what could mean a thousand or one, and says what it could mean", () => {
    assert.equal(read("1.001", ","), null);
    assert.deepEqual(unclearAmount("1.001", ","), { decimal: "1,001", grouped: "1001" });
    assert.equal(read("1,001", "."), null);
    assert.deepEqual(unclearAmount("1,001", "."), { decimal: "1.001", grouped: "1001" });

    for (const clear of ["1,001", "1.5", "1.25", "0.123", "1.0001", "1001", ""]) {
      assert.equal(unclearAmount(clear, ","), null, clear);
    }
  });

  it("refuses what isn't an amount, and more decimals than DUSK has", () => {
    for (const text of ["", " ", ".", ",", "abc", "1,2,3", "1.2.3", "-1", "1e3", "1 000", "0.1234567891"]) {
      assert.equal(read(text, "."), null, JSON.stringify(text));
    }
    assert.equal(read("1.000.000", "."), null);
    assert.equal(read("0,1234567891", ","), null);
    assert.equal(read("0.123456789", "."), 123_456_789n);
  });

  it("reads every amount it shows as that amount, or refuses it, in any language", () => {
    const amounts = [1n, 1_001_000_000n, 1_001_000_000_000n, 1_484_923_500_000n, 1_000_000n * DUSK, 12_345n, DUSK / 2n];
    let readBack = 0;
    /** @type {string[]} */
    const refused = [];

    for (const language of ["en-US", "en-GB", "nl-NL", "de-DE", "fr-FR", "es-ES", "de-CH", "hi-IN", "ar-EG"]) {
      inLanguage(language);
      for (const lux of amounts) {
        const shown = formatDusk(lux, { locale: amountLocale(), mode: "exact" }).text;
        const back = read(shown, decimalSeparator());
        assert.ok(back === lux || back === null, `${language}: ${shown} read as ${back}`);

        if (back === lux) readBack += 1;
        else refused.push(`${language} ${shown}`);

        // Max fills what's read back, whatever the language.
        assert.equal(read(amountForField(formatDuskPlain(lux)), decimalSeparator()), lux, `${language}: field`);
      }
    }

    // Nearly all read back. What doesn't is a thousand and one written with one
    // separator that could be decimals, and the app says what it could mean.
    assert.equal(readBack, 57);
    assert.deepEqual(refused, ["en-US 1,001", "en-GB 1,001", "nl-NL 1.001", "de-DE 1.001", "hi-IN 1,001", "ar-EG 1,001"]);
  });

  it("never reads what it shows as another amount, whatever the amount or the language", () => {
    let seed = 11;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    const languages = ["en-US", "en-GB", "en-IN", "nl-NL", "de-DE", "de-AT", "de-CH", "fr-FR", "fr-CH", "it-CH", "es-ES", "es-MX", "pt-BR", "pl-PL", "sv-SE", "ru-RU", "hi-IN", "bn-IN", "ar-EG", "ar-SA", "fa-IR", "ja-JP"];

    for (let i = 0; i < 4000; i++) {
      const lux = BigInt(next()) ** BigInt(1 + (i % 3)) / BigInt(1 + (next() % 1000));
      const language = languages[i % languages.length];
      const decimal = decimalSeparator(language);
      const shown = formatDusk(lux, { locale: amountLocale(language), mode: "exact" }).text;
      const back = parseDusk(normalizeAmount(shown, decimal, language));

      assert.ok(back === lux || (back === null && unclearAmount(shown, decimal) !== null), `${language}: ${shown} of ${lux} read as ${back}`);
    }
  });

  it("reads a language's own groups, however its space was typed", () => {
    for (const space of [" ", "\u00a0", "\u202f", "\u2009"]) {
      assert.equal(parseDusk(normalizeAmount(`1${space}000`, ",", "fr-FR")), 1000n * DUSK, JSON.stringify(space));
      assert.equal(parseDusk(normalizeAmount(`1${space}000,5`, ",", "fr-FR")), 1000n * DUSK + DUSK / 2n, JSON.stringify(space));
      assert.equal(parseDusk(normalizeAmount(`1${space}234${space}567,89`, ",", "fr-FR")), 1_234_567_890_000_000n, JSON.stringify(space));
    }

    assert.equal(parseDusk(normalizeAmount("1'000", ".", "de-CH")), 1000n * DUSK);
    assert.equal(parseDusk(normalizeAmount("1\u2019000.5", ".", "de-CH")), 1000n * DUSK + DUSK / 2n);
    assert.equal(parseDusk(normalizeAmount("12,34,567.89", ".", "hi-IN")), 1_234_567_890_000_000n);
    assert.equal(parseDusk(normalizeAmount("1,00,000", ".", "hi-IN")), 100_000n * DUSK);
    // Polish leaves a thousand's group out when it writes one, and still reads it.
    assert.equal(parseDusk(normalizeAmount("1 000", ",", "pl-PL")), 1000n * DUSK);

    // In the browser's language, unless told otherwise.
    inLanguage("fr-FR");
    assert.equal(read("1 000,5", decimalSeparator()), 1000n * DUSK + DUSK / 2n);
    assert.equal(parseDusk(normalizeAmount("1 000")), 1000n * DUSK);
  });

  it("refuses groups the language doesn't write, and a lone separator that could mean two things", () => {
    for (const [text, language] of [
      // Not the language's groups.
      ["1 000", "en-US"],
      ["1 000", "de-DE"],
      ["1'000", "fr-FR"],
      ["12,34,567", "en-US"],
      ["1,23,45,67", "hi-IN"],
      // Not groups at all.
      ["1 00", "fr-FR"],
      ["1000 000", "fr-FR"],
      ["10 00", "fr-FR"],
      ["01 000", "fr-FR"],
      ["0 001", "fr-FR"],
      ["1 000 00", "fr-FR"],
      ["1'00", "de-CH"],
      ["1 000,5,5", "fr-FR"],
      // Nor is a space a decimal.
      ["1 5", "fr-FR"],
    ]) {
      assert.equal(parseDusk(normalizeAmount(/** @type {string} */ (text), decimalSeparator(language), language)), null, `${language}: ${text}`);
    }

    // A lone point or comma before three digits stays unclear, wherever its language groups with it.
    for (const [text, language] of [
      ["1.000", "nl-NL"],
      ["1.000", "de-DE"],
      ["1.000", "fr-FR"],
      ["1.000", "es-ES"],
      ["1,000", "en-US"],
      ["1,000", "hi-IN"],
      ["1,000", "de-CH"],
    ]) {
      const decimal = decimalSeparator(language);

      assert.equal(parseDusk(normalizeAmount(/** @type {string} */ (text), decimal, language)), null, `${language}: ${text}`);
      assert.notEqual(unclearAmount(/** @type {string} */ (text), decimal), null, `${language}: ${text}`);
    }
  });

  it("writes an amount example in the language's separators, and it reads back", () => {
    assert.equal(amountExample(), "0.5");
    assert.equal(amountExample("10.5", "fr-FR"), "10,5");
    assert.equal(amountExample("10.5", "en-US"), "10.5");
    assert.equal(amountExample("1234.5", "nl-NL"), "1.234,5");
    assert.equal(amountExample("1234.5", "en-US"), "1,234.5");
    // Which apostrophe depends on the runtime's language data: both read back.
    assert.match(amountExample("1000", "de-CH"), /^1['\u2019]000$/);
    assert.equal(readAmount("1'000", "de-CH").lux, 1000n * DUSK);
    assert.equal(readAmount("1\u2019000", "de-CH").lux, 1000n * DUSK);
    assert.throws(() => amountExample("abc"), TypeError);

    inLanguage("es-ES");
    assert.equal(amountExample("10.5"), "10,5");

    for (const language of ["en-US", "en-GB", "nl-NL", "de-DE", "fr-FR", "es-ES", "de-CH", "hi-IN", "ar-EG"]) {
      for (const [plain, lux] of /** @type {const} */ ([["10.5", 10_500_000_000n], ["0.5", DUSK / 2n], ["1234.5", 1_234_500_000_000n], ["1", DUSK]])) {
        assert.equal(readAmount(amountExample(plain, language), language).lux, lux, `${language}: ${plain}`);
      }
    }
  });

  it("says in plain words what's wrong with an amount, in the language's separators", () => {
    assert.deepEqual(readAmount("", "fr-FR"), { lux: null, problem: null });
    assert.deepEqual(readAmount("  ", "fr-FR"), { lux: null, problem: null });
    assert.deepEqual(readAmount("1 000,5", "fr-FR"), { lux: 1000n * DUSK + DUSK / 2n, problem: null });
    assert.deepEqual(readAmount("1.234", "fr-FR"), { lux: null, problem: "Is that 1234 or 1,234? Write the one you mean." });
    assert.deepEqual(readAmount("1,234", "en-US"), { lux: null, problem: "Is that 1234 or 1.234? Write the one you mean." });
    assert.deepEqual(readAmount("abc", "es-ES"), { lux: null, problem: "Enter an amount such as 10 or 10,5." });
    assert.deepEqual(readAmount("abc", "en-GB"), { lux: null, problem: "Enter an amount such as 10 or 10.5." });
    assert.deepEqual(readAmount("0", "en-GB"), { lux: null, problem: "Enter an amount greater than 0." });
    assert.deepEqual(readAmount("0,0", "fr-FR"), { lux: null, problem: "Enter an amount greater than 0." });
    assert.deepEqual(readAmount("1.1234567891", "en-GB"), { lux: null, problem: "DUSK has 9 decimals at most." });
    assert.deepEqual(readAmount("1,1234567891", "fr-FR"), { lux: null, problem: "DUSK has 9 decimals at most." });
    assert.deepEqual(readAmount("18446744074", "en-GB"), { lux: null, problem: "That amount is too large." });
    assert.deepEqual(readAmount("18446744073.709551615", "en-GB"), { lux: (1n << 64n) - 1n, problem: null });
  });

  it("writes and reads in the same language, unless told otherwise", () => {
    inLanguage("de-DE");
    const shown = formatDusk(1001n * DUSK).text;
    assert.equal(shown, "1.001");
    assert.equal(read(shown, decimalSeparator()), null);

    // Arabic writes its own digits and separator only when asked to.
    inLanguage("ar-EG");
    assert.match(formatDusk(1_500_000_000n).text, /^[0-9.,]+$/);
    assert.match(formatDusk(1_500_000_000n, { locale: "ar-EG" }).text, /^[٠-٩٫٬]+$/);
    assert.equal(read(amountForField("1.5", decimalSeparator("ar-EG")), decimalSeparator("ar-EG")), 1_500_000_000n);
  });

  it("writes in the browser's language, in digits a person can type", () => {
    inLanguage("nl-NL");
    assert.equal(decimalSeparator(), ",");
    assert.equal(groupDigits(1484n), "1.484");
    assert.equal(amountForField("0.35"), "0,35");
    inLanguage("hi-IN");
    assert.equal(groupDigits(1234567n), "12,34,567");
    inLanguage("ar-EG");
    assert.match(groupDigits(1234567n), /^[0-9,.]+$/);
    inLanguage("not a language");
    assert.equal(amountLocale(), "en-US");
  });
});

describe("the currency a wallet starts on", () => {
  it("is euros where the browser's region pays in euros: the euro area, Bulgaria since 2026, the states that use it, France's overseas regions", () => {
    // Lena's.
    for (const language of ["de-DE", "fr-FR", "es-ES", "nl-NL", "it-IT", "bg-BG", "hr-HR", "el-GR", "pt-PT", "de-AT", "fr-BE", "ca-AD", "fr-MC", "it-SM", "it-VA", "sr-Latn-ME", "sq-XK", "fr-RE", "fr-GP", "fr-GF", "fr-YT", "sv-AX", "es-IC", "fr-PM"]) {
      assert.equal(defaultCurrency(language), "EUR", language);
    }
  });

  it("is US dollars anywhere else, Singapore and Switzerland among them", () => {
    for (const language of ["en-US", "en-GB", "en-SG", "zh-SG", "de-CH", "fr-CH", "en-IN", "hi-IN", "ja-JP", "pt-BR", "es-MX", "sv-SE", "da-DK", "pl-PL", "cs-CZ", "ro-RO", "fr-CA", "en-150"]) {
      assert.equal(defaultCurrency(language), "USD", language);
    }
  });

  it("takes a language's main region where it names none, and dollars for what isn't a language", () => {
    for (const [language, currency] of [["de", "EUR"], ["fr", "EUR"], ["es", "EUR"], ["it", "EUR"], ["nl", "EUR"], ["bg", "EUR"], ["ca", "EUR"], ["en", "USD"], ["pt", "USD"], ["sv", "USD"], ["zh", "USD"]]) {
      assert.equal(defaultCurrency(language), currency, language);
    }

    assert.equal(defaultCurrency("not a language!"), "USD");
    assert.equal(defaultCurrency(""), "USD");
  });
});
