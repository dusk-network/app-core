/**
 * Recovery words as every wallet's boxes take them. As a word is typed, the
 * words of the wallet's own BIP-39 list that start with it, for chips under
 * its box, and whether it's one of them, for the box to mark it at once: from
 * the list the app passes in, never the phone's keyboard, which learns what's
 * typed.
 *
 * And checking the recovery words a person wrote down: whether the words
 * typed are the recovery phrase's at the places asked. A check says yes or
 * no, and nothing else: a wrong answer shows no word, and doesn't say which
 * word was wrong, so typing anything, made-up words or one slip of the pen,
 * never puts the phrase on the screen.
 *
 * @example
 * ```js
 * import { wordlist } from "@scure/bip39/wordlists/english.js";
 * import { RECOVERY_WORDS_MISMATCH, RECOVERY_WORDS_SHOW, isRecoveryWord, recoveryWordsMatch, wordSuggestions } from "@dusk/app-core/recovery-words";
 *
 * wordSuggestions("ab", wordlist); // ["abandon", "ability", "able", "about"]
 * wordSuggestions("Zoo", wordlist); // ["zoo"]: the word typed, and the only one, needs no chip
 * isRecoveryWord("sausag", wordlist); // false: "Not a recovery word"
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
 * forms as plain letters (NFKD), accents aside ("légal" is "legal", as
 * `isRecoveryWord` reads it), in any case, the spaces around them aside.
 * False for a place that isn't the phrase's, one given twice, a word left
 * empty, nothing typed, or a phrase of no words; it never throws. It keeps
 * nothing, logs nothing and gives back nothing of the phrase; each word is
 * compared, a wrong one or not.
 */
export declare function recoveryWordsMatch(phrase: string | readonly string[], typed: Iterable<readonly [place: number, word: string]>): boolean;

/**
 * The words of `wordlist` that start with what's typed in a box, for chips
 * under it: in the list's order, at most `limit` (4 unless it's told; a
 * count that isn't a whole number of 0 or more is 4), and none before two
 * letters. What's typed is read as BIP-39 reads a word: in compatibility
 * forms as plain letters (NFKD: "ａｂ" is "ab"), accents aside ("abá" starts
 * "abandon", and "aba" "ábaco" in a list with accents), in any case, the
 * spaces around it aside. The words come back as the list has them.
 *
 * In a list in alphabetical order, as BIP-39's are, a word typed in full
 * comes first, before the words it starts ("act": act, action, actor,
 * actress), and one that's the only one comes alone ("zoo": just zoo), so
 * its box needs no chip. Nothing for what starts no word, for what isn't
 * text, or for a list that isn't an array; what in the list isn't text is
 * passed over. Give it `wordlist` from `@scure/bip39/wordlists/english.js`,
 * the list the wallet makes and reads phrases with. It never throws, keeps
 * nothing, logs nothing and asks nothing of the network; it gives a new
 * array each time and leaves the list as it is.
 */
export declare function wordSuggestions(prefix: string, wordlist: readonly string[], limit?: number): string[];

/**
 * Whether a word typed is one of `wordlist`'s, read as `wordSuggestions`
 * reads it: in compatibility forms (NFKD), accents aside, in any case, the
 * spaces around it aside, so " Zoo " and "abándon" are, and "sausag",
 * "aban" or "legal winner" aren't. False for nothing typed, for what isn't
 * text, or for a list that isn't an array. A word typed with an accent is
 * the list's word without it: hand on the list's, `wordSuggestions(word,
 * wordlist, 1)[0]`, as BIP-39 checks a phrase by the list's words exactly.
 * It never throws, keeps nothing and logs nothing.
 */
export declare function isRecoveryWord(word: string, wordlist: readonly string[]): boolean;
