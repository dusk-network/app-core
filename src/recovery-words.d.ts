/**
 * Checking the recovery words a person wrote down, for both wallets: whether
 * the words typed are the recovery phrase's at the places asked. A check says
 * yes or no, and nothing else: a wrong answer shows no word, and doesn't say
 * which word was wrong, so typing anything, made-up words or one slip of the
 * pen, never puts the phrase on the screen.
 *
 * @example
 * ```js
 * import { RECOVERY_WORDS_MISMATCH, RECOVERY_WORDS_SHOW, recoveryWordsMatch } from "@dusk/app-core/recovery-words";
 *
 * // Words 3, 7 and 10, as the screen numbers them, as typed in their boxes.
 * recoveryWordsMatch(phrase, [[3, " Thank"], [7, "worth"], [10, "WINNER"]]); // true
 * recoveryWordsMatch(phrase, [[3, "maison"], [7, "velo"], [10, "gateau"]]); // false: say RECOVERY_WORDS_MISMATCH, and nothing more
 * ```
 *
 * @module
 */

/**
 * "That doesn't match your recovery words. Check the words you wrote down.":
 * all a check that doesn't match says, in both wallets, with Try again, which
 * asks again, and apart from it `RECOVERY_WORDS_SHOW`. Never a word of the
 * phrase, nor which word was wrong.
 */
export declare const RECOVERY_WORDS_MISMATCH: "That doesn't match your recovery words. Check the words you wrote down.";

/**
 * "Show my recovery words": what shows the phrase, for rewriting the paper,
 * apart from a check and never as its answer, behind the password, as
 * showing it always is.
 */
export declare const RECOVERY_WORDS_SHOW: "Show my recovery words";

/**
 * Whether each word typed is the recovery phrase's word at its place: true
 * only where every one is, false otherwise, and nothing else, whichever word
 * is wrong. `phrase` is the phrase as text, as the wallet keeps it, or its
 * words in order. `typed` is each word typed by its place as the screen
 * numbers it, from 1 ("Word 5" is 5): pairs, `[[5, "sausage"], …]`, or a
 * `Map` of them. Words are compared as BIP-39 reads them, in compatibility
 * forms as plain letters (NFKD), in any case, the spaces around them aside.
 * False for a place that isn't the phrase's, one given twice, a word left
 * empty, nothing typed, or a phrase of no words; it never throws. It keeps
 * nothing, logs nothing and gives back nothing of the phrase; each word is
 * compared, a wrong one or not.
 */
export declare function recoveryWordsMatch(phrase: string | readonly string[], typed: Iterable<readonly [place: number, word: string]>): boolean;
