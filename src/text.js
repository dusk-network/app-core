/* @ts-self-types="./text.d.ts" */
/**
 * Text a person must trust, such as a memo or a message to sign, made safe to
 * show: nothing in it can reorder or hide what it says. What's hidden is made
 * visible, never left out.
 *
 * @module
 */

/** @typedef {import("./text.js").TextFlag} TextFlag */

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

/** The flags that say the text shown isn't the text given, a cut aside. */
const NEUTRALIZING = new Set(["bidi_control", "control_chars", "invalid_surrogate", "invisible_format", "line_separator"]);

/**
 * A character as its code units, each as a backslash, u and four hex digits.
 *
 * @param {string} char
 */
const visible = (char) => Array.from({ length: char.length }, (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");

/**
 * @param {unknown} raw
 * @param {{ maxChars?: number, lineBreaks?: boolean }} [options]
 * @returns {{ text: string, neutralized: boolean, flags: TextFlag[] }}
 */
export function displayText(raw, { lineBreaks = false, maxChars = Infinity } = {}) {
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

  return { flags: [...flags], neutralized, text: out.slice(0, maxChars).join("") };
}
