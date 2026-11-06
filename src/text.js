/* @ts-self-types="./text.d.ts" */
/**
 * Text a person must trust, such as a memo or a message to sign, made safe to
 * show: nothing in it can reorder or hide what it says. What's hidden is made
 * visible, never left out.
 *
 * @module
 */

/** @typedef {import("./text.js").TextFlag} TextFlag */
/** @typedef {"" | "digits" | "letters"} Run What's set apart: a run of right-to-left letters, of their digits, or nothing */

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
const DIGIT = /^\p{Nd}$/u;
const MARK = /^\p{M}$/u;
const LEFT_TO_RIGHT_ISOLATE = "\u2066";
const FIRST_STRONG_ISOLATE = "\u2068";
const POP_DIRECTIONAL_ISOLATE = "\u2069";

/** The flags that say the text shown isn't the text given, a cut aside. */
const NEUTRALIZING = new Set(["bidi_control", "control_chars", "invalid_surrogate", "invisible_format", "line_separator"]);

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
    const kind = MARK.test(piece) ? open : !RIGHT_TO_LEFT.test(piece) ? "" : DIGIT.test(piece) ? "digits" : "letters";

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

  if (source.normalize("NFC") !== source) flags.add("non_nfc");
  if (out.length > maxChars) flags.add("truncated");

  const shown = out.slice(0, maxChars);

  return { flags: [...flags], neutralized, text: isolate ? isolated(shown) : shown.join("") };
}
