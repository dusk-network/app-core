import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { displayText } from "../src/text.js";

describe("text a person must trust", () => {
  it("shows what a sign request's bytes say, not what its controls make them read as", () => {
    // Marek's: on screen this reads "I agree to pay 1000 DUSK".
    const shown = displayText("I agree to pay \u202E0001\u202C DUSK");

    assert.equal(shown.text, "I agree to pay \\u202e0001\\u202c DUSK");
    assert.equal(shown.neutralized, true);
    assert.deepEqual(shown.flags, ["bidi_control"]);
    assert.ok(shown.text.includes("0001"), "the digits as they are");
    assert.doesNotMatch(shown.text, /\p{Bidi_Control}/u);
  });

  it("makes a memo that reads backwards plain to see", () => {
    const { flags, neutralized, text } = displayText("\u202Egnp.exe claim your airdrop https://evil.example");

    assert.equal(text, "\\u202egnp.exe claim your airdrop https://evil.example");
    assert.equal(neutralized, true);
    assert.deepEqual(flags, ["bidi_control"]);
  });

  it("neutralises every text-direction control", () => {
    for (const control of ["\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"]) {
      const { flags, neutralized, text } = displayText(`A${control}B`);

      assert.equal(text, `A\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}B`);
      assert.ok(neutralized);
      assert.deepEqual(flags, ["bidi_control"]);
    }
  });

  it("makes characters that render as nothing visible rather than leaving them out", () => {
    for (const hidden of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad, 0x180e, 0x3164, 0x115f, 0x34f, 0xfe00, 0xe0001, 0xe0100]) {
      const char = String.fromCodePoint(hidden);
      const { flags, neutralized, text } = displayText(`Ali${char}ce`);
      const codes = Array.from({ length: char.length }, (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");

      assert.equal(text, `Ali${codes}ce`, hidden.toString(16));
      assert.ok(neutralized, hidden.toString(16));
      assert.deepEqual(flags, ["invisible_format"], hidden.toString(16));
    }
  });

  it("shows control characters as what they are", () => {
    assert.deepEqual(displayText("A\tB"), { flags: ["control_chars"], neutralized: true, text: "A\\u0009B" });
    assert.deepEqual(displayText("A\u0000B\u0085C\u007fD"), { flags: ["control_chars"], neutralized: true, text: "A\\u0000B\\u0085C\\u007fD" });
  });

  it("shows line breaks as codes, unless they're kept for text written in lines", () => {
    assert.deepEqual(displayText("A\nB\r\nC"), { flags: ["line_separator"], neutralized: true, text: "A\\u000aB\\u000d\\u000aC" });
    assert.deepEqual(displayText("A\nB\r\nC", { lineBreaks: true }), { flags: [], neutralized: false, text: "A\nB\r\nC" });
    // These two are never line breaks a person expects.
    assert.deepEqual(displayText("A\u2028B\u2029C", { lineBreaks: true }), { flags: ["line_separator"], neutralized: true, text: "A\\u2028B\\u2029C" });
    // What's kept doesn't keep controls with it.
    assert.deepEqual(displayText("A\n\u202eB", { lineBreaks: true }), { flags: ["bidi_control"], neutralized: true, text: "A\n\\u202eB" });
  });

  it("leaves text that hides nothing alone, whatever its language", () => {
    for (const plain of ["Factura 33, abril", "Paiement pour Amélie", "שלום עולם", "مرحبا بالعالم", "हिन्दी", "日本語のメモ", "1 000,50 €", "❤\ufe0f", "😀", "\\u202e typed out", ""]) {
      assert.deepEqual(displayText(plain), { flags: [], neutralized: false, text: plain }, plain);
    }
  });

  it("flags combining marks without changing them, as they hide nothing", () => {
    assert.deepEqual(displayText("e\u0301"), { flags: ["non_nfc"], neutralized: false, text: "e\u0301" });
  });

  it("shows half a character as the replacement mark", () => {
    assert.deepEqual(displayText("\ud800X\udfff"), { flags: ["invalid_surrogate"], neutralized: true, text: "\ufffdX\ufffd" });
  });

  it("cuts long text between characters, never through one or a code", () => {
    assert.deepEqual(displayText("😀X", { maxChars: 1 }), { flags: ["truncated"], neutralized: false, text: "😀" });
    assert.deepEqual(displayText("A\u202eB", { maxChars: 2 }), { flags: ["bidi_control", "truncated"], neutralized: true, text: "A\\u202e" });
    assert.deepEqual(displayText("short", { maxChars: 5 }), { flags: [], neutralized: false, text: "short" });
  });

  it("sets right-to-left words and Arabic digits apart where asked, so the rest reads in the order of its bytes", () => {
    const [open, close, line] = ["⁨", "⁩", "⁦"];
    const apart = (/** @type {string} */ text) => `${open}${text}${close}`;
    const ltr = (/** @type {string} */ text) => `${line}${text}${close}`;
    const ALEF = "א";

    // Marek's: on a screen this reads "Pay א 1000 א 10 א DUSK".
    assert.deepEqual(displayText(`Pay ${ALEF} 10 ${ALEF} 1000 ${ALEF} DUSK`, { isolate: true }), {
      flags: [],
      neutralized: false,
      text: ltr(`Pay ${apart(ALEF)} 10 ${apart(ALEF)} 1000 ${apart(ALEF)} DUSK`),
    });
    // Unassigned points of the right-to-left blocks read right to left too.
    assert.equal(displayText("Pay \ufefd 10 \ufefe 1000 DUSK", { isolate: true }).text, ltr(`Pay ${apart("\ufefd")} 10 ${apart("\ufefe")} 1000 DUSK`));
    // A line with a run set apart reads left to right whatever is around it; a break ends every isolate;
    // a line with none is left as it is, so what's copied from it is what was given.
    assert.equal(displayText(`${ALEF} 10\r\n\n1000 DUSK\n0xAbC 1`, { isolate: true, lineBreaks: true }).text, `${ltr(`${apart(ALEF)} 10`)}\r\n\n1000 DUSK\n0xAbC 1`);
    // Digits of two blocks are set apart from each other: N'Ko's read right to left, Arabic-Indic's don't.
    assert.equal(displayText("Pay ١٠߀١٠٠٠ DUSK", { isolate: true }).text, ltr(`Pay ${apart("١٠")}${apart("߀")}${apart("١٠٠٠")} DUSK`));
    // So are numerals that aren't digits, as Rumi's: one and ten stay where they were.
    assert.equal(displayText("Pay \u{10e60}א\u{10e69} DUSK", { isolate: true }).text, ltr(`Pay ${apart("\u{10e60}")}${apart("א")}${apart("\u{10e69}")} DUSK`));
    // Arabic digits move what's between them as letters do: each number on its own.
    assert.equal(displayText("Pay ١٠ב١٠٠٠ DUSK", { isolate: true }).text, ltr(`Pay ${apart("١٠")}${apart("ב")}${apart("١٠٠٠")} DUSK`));
    // A word keeps its marks, and controls show as their codes as ever.
    assert.equal(displayText("pay ‮0001‬ שָׁלוֹם א́", { isolate: true }).text, ltr(`pay \\u202e0001\\u202c ${apart("שָׁלוֹם")} ${apart("א́")}`));
    // Cut first, by the characters given.
    assert.deepEqual(displayText(`${ALEF}בג x`, { isolate: true, maxChars: 2 }), { flags: ["truncated"], neutralized: false, text: ltr(apart(`${ALEF}ב`)) });

    // Whatever mixes them, nothing outside a run set apart reads right to left, and no run holds digits and letters both.
    const rightToLeft = /[֐-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
    for (const mixed of [`=HYPERLINK(1) pay ‮0001‬ ${ALEF} 10 ${ALEF} 1000`, "المبلغ ١٫٥ و 10", "Pay ߁ 10 ߂ 1000 DUSK", "١٠߀١٠٠٠ ۱۲߃", "Pay \u{10e60}א\u{10e69} DUSK", "שׁﭐ 9 \u{10800} 8 \u{1e900}"]) {
      const { text } = displayText(mixed, { isolate: true });
      const runs = [...text.matchAll(/⁨([^⁩]*)⁩/gu)].map(([, run]) => run);

      assert.doesNotMatch(text.replace(/⁨[^⁩]*⁩/gu, ""), rightToLeft, mixed);
      for (const run of runs) assert.ok(/^\p{N}+$/u.test(run) || !/\p{N}/u.test(run), `${mixed}: ${run}`);
      // A run of numerals holds one block's: one bidi class.
      for (const run of runs.filter((run) => /^\p{N}+$/u.test(run))) {
        assert.equal(new Set([...run].map((digit) => Math.floor(/** @type {number} */ (digit.codePointAt(0)) / 16))).size, 1, `${mixed}: ${run}`);
      }
    }
    // Text with nothing right to left in it stays as it was, asked or not.
    assert.equal(displayText("Pay 10 to 0xAbC", { isolate: true }).text, "Pay 10 to 0xAbC");
    // Asked for nothing, text that hides nothing stays as it was.
    assert.equal(displayText(`Pay ${ALEF} 10`).text, `Pay ${ALEF} 10`);
  });

  it("flags a number whose digits read right to left, or mix digit systems, and changes nothing", () => {
    // Marek's: N'Ko's 0001 shows as "߁000", and an Arabic-Indic zero makes 105 look like 1·5.
    assert.deepEqual(displayText("Pay ߀߀߀߁ DUSK"), { flags: ["rtl_digits"], neutralized: false, text: "Pay ߀߀߀߁ DUSK" });
    assert.deepEqual(displayText("Pay ١٠ DUSK, or 1٠5 DUSK"), { flags: ["mixed_digits"], neutralized: false, text: "Pay ١٠ DUSK, or 1٠5 DUSK" });
    assert.deepEqual(displayText("Invoice ߀߀߀߁ paid 1٠5").flags, ["mixed_digits", "rtl_digits"]);
    // Adlam's digits read right to left too, and a single one turns what's beside it around.
    assert.deepEqual(displayText("Pay \u{1e951}\u{1e950} DUSK").flags, ["rtl_digits"]);
    assert.deepEqual(displayText("Pay ߁ 10 ߂ 1000 DUSK").flags, ["rtl_digits"]);
    // An emoji's selector or a keycap's mark is part of the number it's on: it shows as the digits do.
    for (const mixed of ["1\ufe0f\u0660\ufe0f5", "1\ufe0f\u20e3\u0660\ufe0f\u20e35\ufe0f\u20e3", "1\ufe0e\u0660"]) assert.deepEqual(displayText(mixed).flags, ["mixed_digits"], mixed);
    // A number goes on past a decimal or group mark, not past a space.
    for (const mixed of ["1.٠5", "1,٠٠٠", "1'٠00", "١٢٣۴", "𝟏𝟙", "1½", "١0"]) assert.deepEqual(displayText(mixed).flags, ["mixed_digits"], mixed);
    // With what else it flags, as it's shown.
    assert.deepEqual(displayText("pay \u202e1٠5\u202c", { isolate: true }), { flags: ["bidi_control", "mixed_digits"], neutralized: true, text: `⁦pay \\u202e1⁨٠⁩5\\u202c⁩` });
  });

  it("leaves numbers of one system alone, in any script, and numbers of two kept apart", () => {
    // Arabic-Indic and Persian digits read left to right; a math font's digits are one system across its code points.
    for (const one of ["Factura 33", "1 000,50 €", "١٠٠٠", "۱۲۳۴", "１０００", "𝟏𝟐𝟑", "𝟗𝟖", "१,२३४.५", "10 or ١٠", "Pay 10, ١٠", "3.5 DUSK", "Ⅻ", "\u{10e60}\u{10e69}"]) {
      assert.deepEqual(displayText(one).flags, [], one);
    }
  });

  it("reads what isn't text as its text", () => {
    assert.deepEqual(displayText(null), { flags: [], neutralized: false, text: "" });
    assert.deepEqual(displayText(undefined), { flags: [], neutralized: false, text: "" });
    assert.deepEqual(displayText(12), { flags: [], neutralized: false, text: "12" });
  });
});
