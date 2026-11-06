/**
 * Text a person must trust, such as a memo or a message to sign, made safe to
 * show: nothing in it can reorder or hide what it says. What's hidden is made
 * visible, never left out, so a sign request that reads "I agree to pay 1000
 * DUSK" on screen while its bytes say 0001 shows its controls and its 0001.
 *
 * Show `text` with the app's text binding, never as HTML. It's for display
 * only: sign and send the original.
 *
 * @example
 * ```js
 * import { displayText } from "@dusk/app-core/text";
 *
 * displayText("I agree to pay \u202E0001\u202C DUSK");
 * // { text: "I agree to pay \\u202e0001\\u202c DUSK", neutralized: true, flags: ["bidi_control"] }
 * displayText("Factura 33, abril"); // { text: "Factura 33, abril", neutralized: false, flags: [] }
 * ```
 *
 * @module
 */

/**
 * What a text held:
 * - "bidi_control": a control that reorders what follows it;
 * - "invisible_format": a character that renders as nothing: a zero-width
 *   space or joiner, a soft hyphen, a tag, a Hangul filler;
 * - "line_separator": a line break, where line breaks aren't kept;
 * - "control_chars": another control character, a tab among them;
 * - "invalid_surrogate": half a character, shown as the replacement mark;
 * - "non_nfc": combining marks that look like one precomposed character. The
 *   text isn't changed: it's for the app to say;
 * - "truncated": it was cut at `maxChars`.
 */
export type TextFlag = "bidi_control" | "invisible_format" | "line_separator" | "control_chars" | "invalid_surrogate" | "non_nfc" | "truncated";

/**
 * The text as it's safe to show, and whether anything in it was neutralised.
 * Each hidden character shows as its code (a backslash, u and four hex
 * digits), and half a character as the replacement mark. Line breaks show as
 * codes too, unless `lineBreaks` keeps them for text that's written in lines,
 * as a message to sign. An emoji's own selector stays; a joiner between emoji
 * shows, as it can hide anything an emoji can't. `maxChars` cuts it at that
 * many characters of the text given, never through one. Anything that isn't
 * text reads as its text.
 *
 * `isolate`, for a screen: each run of right-to-left letters, and each run of
 * their digits, is set apart in an isolate (U+2068 to U+2069), so what's
 * beside them reads in the order of the bytes, as "Pay א 10 א 1000" does
 * rather than as "Pay א 1000 א 10". Within a run, a word reads as its script
 * writes it. A line with a run set apart is in a left-to-right isolate
 * (U+2066 to U+2069) as well, so it reads that way inside right-to-left text
 * too. A line without one gets nothing added, so an address copied from it
 * stays as it is: show text in an element of its own, isolated left to right
 * (`dir="ltr"`, `unicode-bidi: isolate`), for its digits to keep their order
 * beside right-to-left text around it. Not for a file: it adds characters.
 */
export declare function displayText(
  raw: unknown,
  options?: { maxChars?: number; lineBreaks?: boolean; isolate?: boolean }
): { text: string; neutralized: boolean; flags: TextFlag[] };
