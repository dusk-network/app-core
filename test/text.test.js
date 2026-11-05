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
    // Each line on its own left to right, whatever is around it; a break ends every isolate.
    assert.equal(displayText(`${ALEF} 10\r\n\n1000 ${ALEF}`, { isolate: true, lineBreaks: true }).text, `${ltr(`${apart(ALEF)} 10`)}\r\n\n${ltr(`1000 ${apart(ALEF)}`)}`);
    // Arabic digits move what's between them as letters do: each number on its own.
    assert.equal(displayText("Pay ١٠ב١٠٠٠ DUSK", { isolate: true }).text, ltr(`Pay ${apart("١٠")}${apart("ב")}${apart("١٠٠٠")} DUSK`));
    // A word keeps its marks, and controls show as their codes as ever.
    assert.equal(displayText("pay ‮0001‬ שָׁלוֹם א́", { isolate: true }).text, ltr(`pay \\u202e0001\\u202c ${apart("שָׁלוֹם")} ${apart("א́")}`));
    // Cut first, by the characters given.
    assert.deepEqual(displayText(`${ALEF}בג x`, { isolate: true, maxChars: 2 }), { flags: ["truncated"], neutralized: false, text: ltr(apart(`${ALEF}ב`)) });

    // Whatever mixes them, nothing outside a run set apart reads right to left, and no run holds digits and letters both.
    const rightToLeft = /[֐-ࣿיִ-﷿ﹰ-ﻼ\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
    for (const mixed of [`=HYPERLINK(1) pay ‮0001‬ ${ALEF} 10 ${ALEF} 1000`, "المبلغ ١٫٥ و 10", "Pay ߁ 10 ߂ 1000 DUSK", "שׁﭐ 9 \u{10800} 8 \u{1e900}"]) {
      const { text } = displayText(mixed, { isolate: true });
      const runs = [...text.matchAll(/⁨([^⁩]*)⁩/gu)].map(([, run]) => run);

      assert.doesNotMatch(text.replace(/⁨[^⁩]*⁩/gu, ""), rightToLeft, mixed);
      for (const run of runs) assert.ok(/^\p{Nd}+$/u.test(run) || !/\p{Nd}/u.test(run), `${mixed}: ${run}`);
    }
    // Asked for nothing, text that hides nothing stays as it was.
    assert.equal(displayText(`Pay ${ALEF} 10`).text, `Pay ${ALEF} 10`);
  });

  it("reads what isn't text as its text", () => {
    assert.deepEqual(displayText(null), { flags: [], neutralized: false, text: "" });
    assert.deepEqual(displayText(undefined), { flags: [], neutralized: false, text: "" });
    assert.deepEqual(displayText(12), { flags: [], neutralized: false, text: "12" });
  });
});
