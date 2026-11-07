/* @ts-self-types="./text.d.ts" */
/**
 * Text a person must trust, such as a memo or a message to sign, made safe to
 * show: nothing in it can reorder or hide what it says. What's hidden is made
 * visible, never left out.
 *
 * @module
 */

/** @typedef {import("./text.js").TextFlag} TextFlag */
/** @typedef {string} Run What's set apart: "letters", a run of right-to-left letters; "digits" and the first of their block, a run of digits of one script; or "", nothing */

const BIDI_CONTROL = /\p{Bidi_Control}/u;
const FORMAT_CONTROL = /\p{Cf}/u;
// What renders as nothing though it isn't a format control: Hangul fillers,
// the combining grapheme joiner and most variation selectors.
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
// What picks an emoji's look, and hides nothing.
const EMOJI_SELECTOR = /[\ufe0e\ufe0f]/u;
const LINE_SEPARATOR = /[\n\r\u2028\u2029]/u;
const LINE_BREAK = /[\n\r]/u;
const CONTROL = /\p{Cc}/u;
const REPLACEMENT = "\ufffd";
// What the scripts written right to left have, which turns what's beside it
// around: the blocks Unicode keeps for them, their unassigned points too,
// which read right to left as well. U+FEFF is a format control, shown as its
// code.
const RIGHT_TO_LEFT = /^[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefe\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]$/u;
const NUMBER = /^\p{N}$/u;

/**
 * The run a right-to-left numeral belongs to: one of its own sixteen code
 * points. Numerals differ in how they read (Arabic-Indic digits and Rumi
 * numerals don't turn around, N'Ko's and Adlam's read right to left), but a
 * block of sixteen never holds two kinds: a run of one block can't turn a
 * number around, and isn't one with the letters.
 *
 * @param {string} numeral
 * @returns {Run}
 */
const numeralsOf = (numeral) => `digits ${Math.floor(/** @type {number} */ (numeral.codePointAt(0)) / 16)}`;
const MARK = /^\p{M}$/u;
const DIGIT = /^\p{Nd}$/u;
// The numerals of the right-to-left blocks that read left to right: the
// Arabic-Indic digits and Persian's, Hanifi Rohingya's and Garay's digits, and
// Rumi's numerals. Every other numeral there reads right to left, as N'Ko's
// and Adlam's digits do (Unicode 18's bidi classes).
const LEFT_TO_RIGHT_NUMERALS = /^[\u0660-\u0669\u06f0-\u06f9\u{10d30}-\u{10d49}\u{10e60}-\u{10e7e}]$/u;
// The digits that look like another Latin digit than they are, by Unicode's
// confusables (UTS #39, 18.0.0): Bengali's 4 and 7, which look like 8 and 9,
// Gurmukhi's 1 and 4, like 9 and 8, Oriya's 2, Malayalam's 7 and Wancho's 2,
// like 9. Its test checks them against the table.
const MISREAD_DIGIT = /^[\u09ea\u09ed\u0a67\u0a6a\u0b68\u0d6d\u{1e2f2}]$/u;
// What goes between a number's digits: a decimal point or comma, a group's
// mark or its narrow space. A space ends a number.
const NUMBER_SEPARATOR = /^[.,'\u2019\u066b\u066c\u00a0\u202f\u2009]$/u;
const LEFT_TO_RIGHT_ISOLATE = "\u2066";
const FIRST_STRONG_ISOLATE = "\u2068";
const POP_DIRECTIONAL_ISOLATE = "\u2069";

/** The flags that say the text shown isn't the text given, a cut aside. */
const NEUTRALIZING = new Set(["bidi_control", "control_chars", "invalid_surrogate", "invisible_format", "line_separator"]);

/** Each decimal digit's system, by the code point of its zero, as it's found. */
const zeros = new Map();

/**
 * The system a decimal digit is of, as its zero's code point: a run of
 * decimal digits is always whole sets of ten, each from its zero.
 *
 * @param {string} digit
 */
function zeroOf(digit) {
  const code = /** @type {number} */ (digit.codePointAt(0));
  let zero = zeros.get(code);

  if (zero === undefined) {
    let start = code;

    while (start > 0 && DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;

    zero = start + Math.floor((code - start) / 10) * 10;
    zeros.set(code, zero);
  }

  return zero;
}

/**
 * What the numbers in a text show that their bytes don't say: one whose
 * digits are of more than one system, as 1٠5 with an Arabic-Indic zero that
 * looks like a point, one in numerals that read right to left, as N'Ko's
 * 0001 that shows as 1000, and one with digits that look like other digits,
 * as Bengali's ৪, a 4 that looks like an 8. A number goes on past one
 * separator between its numerals, and holds the selectors and marks on them;
 * a numeral that's no decimal digit is a system of its own.
 *
 * @param {string} source
 */
function numberFlags(source) {
  const found = { lookalike: false, mixed: false, rightToLeft: false };
  /** @type {Set<number | string> | null} */
  let systems = null;
  let separated = false;

  for (const char of source) {
    if (NUMBER.test(char)) {
      systems ??= new Set();
      systems.add(DIGIT.test(char) ? zeroOf(char) : "other");
      found.mixed ||= systems.size > 1;
      found.rightToLeft ||= RIGHT_TO_LEFT.test(char) && !LEFT_TO_RIGHT_NUMERALS.test(char);
      found.lookalike ||= MISREAD_DIGIT.test(char);
      separated = false;
    } else if (systems && (EMOJI_SELECTOR.test(char) || MARK.test(char))) {
      // An emoji's selector or a keycap's mark, kept as it is: part of the numeral it's on.
      continue;
    } else if (systems && !separated && NUMBER_SEPARATOR.test(char)) {
      separated = true;
    } else {
      systems = null;
      separated = false;
    }
  }

  return found;
}

/**
 * A character as its code units, each as a backslash, u and four hex digits.
 *
 * @param {string} char
 */
const visible = (char) => Array.from({ length: char.length }, (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");

/**
 * What's shown, with each run of right-to-left letters, and each run of their
 * digits, in an isolate of its own: a mark keeps to the run it follows. A line
 * with a run set apart is in a left-to-right isolate too, so it reads in the
 * order of its bytes inside right-to-left text as well. A line without one
 * stays as it is.
 *
 * @param {string[]} shown Its characters, and the codes in place of hidden ones
 */
function isolated(shown) {
  let text = "";
  let line = "";
  /** @type {Run} */
  let open = "";
  let setApart = false;

  const endLine = () => {
    const closed = `${line}${open ? POP_DIRECTIONAL_ISOLATE : ""}`;

    text += setApart ? `${LEFT_TO_RIGHT_ISOLATE}${closed}${POP_DIRECTIONAL_ISOLATE}` : closed;
    line = "";
    open = "";
    setApart = false;
  };

  for (const piece of shown) {
    // A line break ends every isolate: each line has its own.
    if (LINE_BREAK.test(piece)) {
      endLine();
      text += piece;
      continue;
    }

    /** @type {Run} */
    const kind = MARK.test(piece) ? open : !RIGHT_TO_LEFT.test(piece) ? "" : NUMBER.test(piece) ? numeralsOf(piece) : "letters";

    if (kind !== open) {
      line += `${open ? POP_DIRECTIONAL_ISOLATE : ""}${kind ? FIRST_STRONG_ISOLATE : ""}`;
      open = kind;
    }

    setApart ||= kind !== "";
    line += piece;
  }

  endLine();

  return text;
}

/**
 * @param {unknown} raw
 * @param {{ maxChars?: number, lineBreaks?: boolean, isolate?: boolean }} [options]
 * @returns {{ text: string, neutralized: boolean, flags: TextFlag[] }}
 */
export function displayText(raw, { isolate = false, lineBreaks = false, maxChars = Infinity } = {}) {
  const source = typeof raw === "string" ? raw : String(raw ?? "");
  /** @type {Set<TextFlag>} */
  const flags = new Set();
  /** @type {string[]} */
  const out = [];

  for (const char of source) {
    const code = /** @type {number} */ (char.codePointAt(0));

    if (code >= 0xd800 && code <= 0xdfff) {
      flags.add("invalid_surrogate");
      out.push(REPLACEMENT);
    } else if (BIDI_CONTROL.test(char)) {
      flags.add("bidi_control");
      out.push(visible(char));
    } else if (LINE_SEPARATOR.test(char)) {
      if (lineBreaks && LINE_BREAK.test(char)) {
        out.push(char);
      } else {
        flags.add("line_separator");
        out.push(visible(char));
      }
    } else if (CONTROL.test(char)) {
      flags.add("control_chars");
      out.push(visible(char));
    } else if (FORMAT_CONTROL.test(char) || (IGNORABLE.test(char) && !EMOJI_SELECTOR.test(char))) {
      flags.add("invisible_format");
      out.push(visible(char));
    } else {
      out.push(char);
    }
  }

  const neutralized = [...flags].some((flag) => NEUTRALIZING.has(flag));
  const numbers = numberFlags(source);

  if (numbers.mixed) flags.add("mixed_digits");
  if (numbers.rightToLeft) flags.add("rtl_digits");
  if (numbers.lookalike) flags.add("lookalike_digits");
  if (source.normalize("NFC") !== source) flags.add("non_nfc");
  if (out.length > maxChars) flags.add("truncated");

  const shown = out.slice(0, maxChars);

  return { flags: [...flags], neutralized, text: isolate ? isolated(shown) : shown.join("") };
}
