/**
 * Links that ask for a payment, for the Dusk apps: a `dusk:` link for a wallet
 * that reads them, as in a QR code, and an https link to the web wallet's
 * Send, which survives email and chat and says which network it's for. One
 * function reads both. A link is only made for what Send will take: a
 * recipient that is one, an amount above 0 with 9 decimals at most, and a memo
 * of 512 bytes at most, on one line, and what's wrong is said in plain words.
 *
 * @example
 * ```js
 * import { makePaymentLink, networkMismatch, parsePaymentLink } from "@dusk/app-core/payment-links";
 *
 * const made = makePaymentLink({ to: account, amount: "0,15", memo: "Factura 33", network: 1, language: "es-ES" });
 * // { ok: true, lux: 150000000n, dusk: "dusk:public-…@dusk:1?amount=0.15&memo=Factura+33",
 * //   https: "https://apps.dusk.network/wallet/dashboard/send?to=…&amount=0.15&memo=Factura+33&network=mainnet", problems: {} }
 * makePaymentLink({ to: account, amount: "1.234", network: 1, language: "es-ES" }).problems;
 * // { amount: "Is that 1,2340 or 1234? Write the one you mean." }
 *
 * const link = parsePaymentLink(made.https); // { form: "https", kind: "public", to, amountDusk: "0.15", memo: "Factura 33", chainId: "dusk:1", … }
 * networkMismatch(link.chainId, 2); // "This request is for Mainnet. You are on Testnet."
 *
 * // In Send, as a link is pasted, scanned or opened: on the wallet's network.
 * readPaymentLink(pasted, { network: 2 });
 * // { link: null, problem: "This request is for Mainnet. You are on Testnet.", reason: "other-network", chainId: "dusk:1", network: "Mainnet" }
 *
 * // What's pasted in To: a link alone, or a request as both wallets share it, its link taken out.
 * readPastedLink("sofiadesign.dusk asks you to pay 0,03 DUSK · Factura 71\nPay here: https://…", { network: 2 });
 * // { link: { to, amountDusk: "0.03", memo: "Factura 71", … }, problem: "", reason: "", chainId: "dusk:2", network: "Testnet", text: "https://…" }
 * // Its line saying 0,03 above a link for 0,15, or any line saying so, or words after the link:
 * // { link: null, problem: "The message and its link don't agree.", reason: "disagrees", chainId: "", network: "", text: "" }
 * // { link: null, problem: "The words after that link may be part of it. Paste the link alone.", reason: "words-after", … }
 *
 * // The .dusk names it gives, wherever they are, as the name service says whose they are.
 * const owners = new Map(await Promise.all(pastedDuskNames(pasted).map(async (name) => [name, await lookUp(name)])));
 * readPastedLink(pasted, { network: 2, owners }); // refused where one is another account's than the link pays
 *
 * // Its amount as Send fills it in and reads it, for a preview to say the same: here amount=1.000.
 * linkAmount(readPaymentLink(opened, { network: 2 })?.link, "pl-PL");
 * // { field: "1,000", lux: null, problem: "Is that 1 or 1000? Write the one you mean.", question: "Is that 1 or 1000?",
 * //   choices: [{ field: "1", lux: 1_000_000_000n }, { field: "1000", lux: 1_000_000_000_000n }] }
 * ```
 *
 * @module
 */

import type { Network } from "@dusk-network/networks";
import type { AmountRead } from "./amounts.js";
import type { DuskNameOwners } from "./names.js";

/** The longest memo the network takes, in bytes. */
export declare const MAX_MEMO_BYTES: 512;

/** A link read: what it asks for, its fields as text, "" for those it doesn't say. */
export type PaymentLink = {
  /** What was read, as it was given. */
  raw: string;
  /** "dusk": a `dusk:` link; "https": a link to the web wallet's Send; "raw": anything else, taken for a recipient as it is. */
  form: "dusk" | "https" | "raw";
  /** "public" or "shielded" where the link says, or the recipient shows; "unknown" otherwise. */
  kind: "public" | "shielded" | "unknown";
  to: string;
  /** The network it's for, "dusk:1": a wallet's link says its network's. */
  chainId: string;
  /** The amount in plain DUSK, as the link says it; `linkAmount` writes it for a field, as Send reads it. */
  amountDusk: string;
  /** An exact amount in lux, when the link says one: then `amountDusk` is what it comes to. */
  amountLux: string;
  /**
   * What `amountDusk` is in lux as a plain number, a point its decimal mark,
   * or null where it isn't one: for checking amounts agree, not for showing.
   * Send reads `amountDusk` in the person's language, and asks which is meant
   * of "1.000", where this is 1 DUSK: what it fills in and reads is
   * `linkAmount`'s.
   */
  lux: bigint | null;
  memo: string;
  label: string;
};

/**
 * Reads a `dusk:` link (`dusk:public-…`, `dusk:shielded-…`, or `dusk:<address>`
 * with an account or a shielded address as it's written, with `//` or not,
 * and its network as `@dusk:2` or, as an https link says it, `network=` in
 * its query), an https link to the web wallet's Send on any network there's a
 * file for (or at `walletUrl`, the app's own address), or a recipient as it
 * is, as a QR code may hold. A field is read by its name in any case: `To=`
 * is `to=`, and `AMOUNT=` is `amount=`. Null for nothing, for a `dusk:` link
 * that isn't one of those, for a link that says one of its fields (`to`,
 * `amount`, `amountLux`, `memo`, `label`, `network`) more than once, in any
 * case, or a `dusk:` link that names a recipient in its query too, for one
 * whose field names hide something or read as a field they aren't: a name
 * that isn't printable ASCII, as every field's is (what can't be seen or a
 * space, as `am\u200bount=` or `to =`, or letters of another script or form,
 * as fullwidth `ｔｏ=`, a small capital in `ɴetwork=` or a Cyrillic т in
 * `тo=`), or one in ASCII that looks like a field's name but isn't one, as
 * `amountIux=` with a capital I or `Iabel=`, which a person reading the link
 * takes for a field no reader reads, for one
 * without a recipient, for one that names a network that can't be read (as
 * "dusk:02", a number with a zero before it), for one that names two (a
 * `dusk:` link's `@` and query, or a network on another network's wallet),
 * for one with a user part before its host
 * (`https://apps.testnet.dusk.network@apps.dusk.network/…`, which goes to the
 * host after the `@`), for a `dusk:shielded-` link to a public account or a
 * `dusk:public-` link to a shielded address, and for a `dusk:` link with a
 * `#` in it, which readers read in different ways. An https link's fragment
 * is the browser's: left out, as the page it opens leaves it out. An https
 * link to anywhere else is no payment link: it reads as a recipient, which
 * Send refuses. Nothing is checked here but its form: Send checks what it
 * fills in. `readPaymentLink` says why a link is refused, and refuses one
 * whose recipient is no address too.
 */
export declare function parsePaymentLink(input: unknown, options?: { walletUrl?: string }): PaymentLink | null;

/** "That link can't be read. Ask for a new one." */
export declare const LINK_UNREADABLE: "That link can't be read. Ask for a new one.";

/** "This link asks for two different amounts. Ask for a new one." */
export declare const LINK_TWO_AMOUNTS: "This link asks for two different amounts. Ask for a new one.";

/** "This link's address isn't valid. Ask for a new one.": a link whose recipient Send can't pay, as `readPaymentLink` refuses it. */
export declare const LINK_BAD_ADDRESS: "This link's address isn't valid. Ask for a new one.";

/** "This link's amount can't be read. Ask for a new one.": a link whose amount isn't a plain number once decoded, as `readPaymentLink` refuses it. */
export declare const LINK_BAD_AMOUNT: "This link's amount can't be read. Ask for a new one.";

/** "This link's memo has a line break. Ask for a new one.": a link whose memo is on more than one line, as `readPaymentLink` refuses it. */
export declare const LINK_MEMO_LINE_BREAK: "This link's memo has a line break. Ask for a new one.";

/**
 * A link as Send reads it on the wallet's network: what it fills in, or why it
 * fills in nothing, and the network it's for either way.
 */
export type LinkRead = {
  /** What it asks of Send; null where it's refused. */
  link: PaymentLink | null;
  /**
   * Why it fills in nothing, in plain words, for whoever sent it to fix: "This
   * link says the memo twice. Ask for a new one." (or the recipient, as a
   * `dusk:` link with `to=` says it, or `To=` beside `to=`), "This link has
   * something before the site's address. Ask for a new one.", "This link
   * names two networks, Testnet and Mainnet. Ask for a new one.", "This
   * link's network can't be read. Ask for a new one.", "This link doesn't say
   * who to pay. Ask for a new one.", "This link asks for a shielded payment to
   * a public account. Ask for a new one." (or a public one to a shielded
   * address), `LINK_BAD_ADDRESS` for a recipient Send can't pay,
   * `LINK_BAD_AMOUNT` for an amount that isn't a plain number,
   * `LINK_MEMO_LINE_BREAK` for a memo on more than one line, or
   * `LINK_UNREADABLE` for what has no form a payment link's has, as a `dusk:`
   * link with a `#`, or field names that hide something; "" when it fills in
   * `link`.
   */
  problem: string;
  /**
   * "unreadable": not a link that can be read, `problem` saying why;
   * "two-amounts": it says amounts that differ (`LINK_TWO_AMOUNTS`);
   * "other-network": it's for another network than the wallet's
   * (`networkMismatch`'s words); "" when it fills in `link`.
   */
  reason: "" | "unreadable" | "two-amounts" | "other-network";
  /** The network it's for, "dusk:1", where it says one; "" otherwise. */
  chainId: string;
  /** That network's name, "Mainnet", as `chainLabel` says it; "" for none. */
  network: string;
};

/**
 * What a link asks of Send, the same whether it's pasted, scanned, opened or
 * handed over by a site, so a wallet says at once what's wrong with it:
 * before Review, and never as a recipient. Null for what isn't a link, as an
 * address, a name or an https link to anywhere but the web wallet's Send:
 * Send reads that as a recipient. `network` is the wallet's (a network, its
 * chain ID, "dusk:2" or its name), and `walletUrl` the app's own address, as
 * `parsePaymentLink` takes it; without `network`, a link for any network
 * fills in. Refused, in this order: an amount that isn't a plain number once
 * decoded (`LINK_BAD_AMOUNT`): anything in it or around it but digits and one
 * point or comma, as a `#` it encodes (`%23`), a hidden character or a space
 * of any kind, a tab and a line break among them, as it's written in the
 * link, which a field that drops them would show as an amount the link
 * doesn't say: a browser's reading of an https link drops tabs and line
 * breaks, and "0.001", a tab and "5" would be 0.0015;
 * amounts that differ (in DUSK and in lux, or one of them twice, in any case);
 * what `parsePaymentLink` can't read, saying why, field names that hide
 * something among it; a recipient Send can't pay (`LINK_BAD_ADDRESS`): one that isn't
 * an account, a shielded address, a `.dusk` name or an EVM address, as two
 * addresses in one, or one with a line break or a hidden character in it,
 * which a field that drops them would make an address to pay; a memo with a
 * line break of any kind in it (`LINK_MEMO_LINE_BREAK`), as both wallets'
 * requests write a memo on one line, the line breaks at its ends aside; and a
 * link for another network, a `dusk:` link's by its `@` or its query alike.
 * A link refused gives nothing to fill in or show (`link` is null): a
 * preview of it, as before a wallet opens, says why and nothing else.
 */
export declare function readPaymentLink(input: unknown, options?: { network?: unknown; walletUrl?: string }): LinkRead | null;

/** "That has more than one payment link. Paste just the one to pay.": pasted text with two payment links or more, as `readPastedLink` refuses it. */
export declare const LINK_SEVERAL: "That has more than one payment link. Paste just the one to pay.";

/** "The words after that link may be part of it. Paste the link alone.": pasted text with words after its link, as `readPastedLink` refuses it. */
export declare const LINK_UNCLEAR: "The words after that link may be part of it. Paste the link alone.";

/** "The message and its link don't agree.": what `readPastedLink` says of a message whose words say what its link doesn't where no one part does (`Disagreement` "other"). */
export declare const LINK_DISAGREES: "The message and its link don't agree.";

/**
 * What in a pasted message isn't its link's, as `readPastedLink` refuses it,
 * with the message's and the link's, each as given, what can't be seen as
 * its codes (`displayText`), for a wallet that shows more than its words.
 */
export type Disagreement = {
  /**
   * "amount": an amount the message states, or none, as "for a payment in
   * DUSK", that isn't the one the link asks; "network": a network it names
   * that isn't the one the link pays on; "memo": a request's line's memo that
   * isn't the link's; "name": who a request's line says asks, which isn't
   * the link's label, or a .dusk name it gives that isn't who the link pays,
   * as the name service says (`owners`); "address": a Dusk address it gives,
   * a public account or a shielded address, that isn't the one the link
   * pays; "other": no one part, as a message that turns what's shown around,
   * one longer than any the wallets write, or a request's line that isn't
   * the wallet's own for its link in some other way.
   */
  part: "amount" | "network" | "memo" | "name" | "address" | "other";
  /**
   * What the message says: an amount as it's written, " DUSK" after it where
   * it's beside "DUSK" ("0.002 DUSK", or "0.15" for "Total 0.15"); a
   * network's name ("Mainnet"); a memo; who asks, or the .dusk name, as it
   * reads ("sofiadesign.dusk" for "sofiadesign . dusk"); an address whole;
   * "" for none, as no amount or memo, and for "other".
   */
  message: string;
  /**
   * What its link says of it: the amount it asks ("0.15 DUSK"), the network
   * it pays on ("Testnet"), its memo, its label where who asks or a name not
   * looked up is held to that, else who it pays, a .dusk name or an address
   * whole; "" for none, and for "other".
   */
  link: string;
};

/** What's pasted in Send's To as Send reads it: a link as `readPaymentLink` reads it, or why the text fills in nothing. */
export type PastedLinkRead = Omit<LinkRead, "reason"> & {
  /**
   * As `readPaymentLink`'s, and "several-links": the text has more than one
   * payment link (`LINK_SEVERAL`); "words-after": words after its link may
   * be part of it (`LINK_UNCLEAR`); "disagrees": it's a message whose words
   * say what its link doesn't, `problem` saying what (`disagrees`). For
   * those three, `link` is null, and `chainId`, `network` and `text` are "".
   */
  reason: LinkRead["reason"] | "several-links" | "words-after" | "disagrees";
  /** The link read, as it's written in what was pasted: its last word. */
  text: string;
  /** Where `reason` is "disagrees", and only there: what isn't the link's, `problem` saying it. */
  disagrees?: Disagreement;
};

/**
 * What text pasted in Send's To asks of Send, the same in every wallet's
 * Send, as `readPaymentLink` reads a link: what it fills in, or why it fills
 * in nothing. A link ends at its first space or line break of any kind, as a
 * chat ends one. Text with more than one payment link is refused, wherever
 * they are (`LINK_SEVERAL`): read whole, one link's memo would carry the
 * other; a "DUSK:" ending a sentence is no link. Text with words after its
 * link is refused (`LINK_UNCLEAR`), whatever the link ends with, its memo,
 * its network or its amount: they may be part of it, as a link broken at a
 * line break before "&amount=0.15", or not, as "danke!" or a chat page's
 * time copied with its message, and never join its memo; so is a link with
 * a space in it. Its one link, its last word, is read alone, as
 * `readPaymentLink` reads it, and what that refuses, it refuses as the link
 * alone says it.
 *
 * The words before it, a link for another network's too, are read whole,
 * every line, as a reader reads them: without what can't be seen, as a
 * zero-width space or a mark that sets words' direction, and in the letters
 * they look like, by Unicode's confusables, as `/names` reads names, so
 * "DUSК" with a Cyrillic К, "tо pay" with a Cyrillic о, fullwidth letters
 * and small capitals read as a person takes them. They're refused
 * (`reason` "disagrees") where they state another amount, network, .dusk
 * name or address than the link, anywhere, saying which and what each says
 * (`disagrees`), in `problem`: "The message says 0.002 DUSK; its link asks
 * 0.15 DUSK.", "The message says Mainnet; its link pays on Testnet.", "The
 * message says sofiadesign.dusk; its link pays 26dtBf…xSS93z.", where an
 * amount reads two ways, "The message says 1.000 DUSK, which could be 1 or
 * 1000 DUSK; its link asks 1 DUSK. Ask for the amount written one way.", or
 * `LINK_DISAGREES` where no one part is another's:
 * - an amount before or after "DUSK", after "pay", "send" or "transfer",
 *   "me" or "us" between or not, or after "Total", "Subtotal", "Amount" or
 *   "Sum", "due" or "to pay" after it or not, and a colon, an equals sign or
 *   a space, where no word follows it, as "Total 0.15" ("Total 2 coffees"
 *   and "Total 15 EUR" count or price something else), that isn't the
 *   amount the link asks, read
 *   in either decimal mark or in groups of thousands, by a point, a comma,
 *   an apostrophe or a space of any width ("1 234.5"), or any amount where
 *   the link asks none. An amount is read from the digits written, NFKC
 *   aside (a fullwidth "１" is a 1), never from what they look like: one that
 *   could be two, as "1.000", one written in letters that look like digits,
 *   as "2OO", one in digits of another script, as "1٠5" with an
 *   Arabic-Indic zero, which looks like a point, one with a mark over a
 *   digit, as "0̣002", and one with what can't be seen between its digits,
 *   which can show it turned around, are none. A
 *   word that starts with another letter, as "Li", is a .dusk name, as
 *   "oliver2.dusk", or an address's characters, is no amount, though an
 *   amount beside one in a word is ("Pay 0.15,<address>"); digits of
 *   another script after "Total" are an amount that can't be read;
 * - a network, by a known network's name or label, as "Testnet", or as
 *   "Chain 2", that isn't the one it's paid on: the link's, or for a link
 *   that names none, the wallet's (`network`); a label of a .dusk name, as
 *   in "testnet·dusk", names none;
 * - a .dusk name, as `nameDuskNames` of `/names` reads them ("alice·dusk"
 *   with a middle dot is alice.dusk), that isn't the link's recipient's: the
 *   .dusk name it pays, or for an account or a shielded address it pays, what
 *   the name service says of it (`owners`, as `profileNameCheck` of `/names`
 *   takes them, by the names `pastedDuskNames` gives): registered to another
 *   account or shielded address of the kind the link pays, or to no one. One
 *   not looked up, as one whose lookup failed, says nothing, or where the
 *   link has a label, must be among the label's. Who asks, before "asks
 *   you" in a request's line, is read as a name, which holds no sentence: a
 *   full stop with spaces around it or after it, or "dot" between two
 *   words, is a point there, so "sofiadesign . dusk asks you…",
 *   "sofiadesign. dusk" and "sofiadesign dot dusk" give sofiadesign.dusk, as
 *   a link's label is read too, and the names as written are kept
 *   ("sofiadesign.dusk. Studio" gives sofiadesign.dusk), as
 *   "sofiadesign[.]dusk", "sofiadesign⸰dusk" with a ring point and
 *   "sofiadesigṇdusk" with a dot below its n do anywhere;
 * - a Dusk address, a public account or a shielded address, in letters
 *   that look like its own or with what can't be seen in it too, that isn't
 *   the one the link pays, or for a .dusk name it pays, isn't one the name
 *   service says is that name's (`owners`), where it says whose it is.
 * Text holding an override or an embedding (U+202A to U+202E), which turns
 * what's shown around, "200" shown as "002", is refused too: the wallets'
 * own messages show one as its code (`displayText`). So are words before
 * the link longer than any message the wallets write, over 8192 UTF-16
 * units, which aren't read.
 *
 * A line worded as a request as both wallets share it (`requestMessage`),
 * "<name> asks you to pay <amount> DUSK" or "<name> asks you for a payment
 * in DUSK", "You're asked …" without a name, or as people write it, "You
 * are asked …", "Please pay <amount> DUSK" or "Pay <amount> DUSK", then
 * " on <network>" and " · <memo>", then "Pay here:", in any case and spacing,
 * and the link, its line break there or dropped, as a phone's one-line field
 * drops it ("… · Factura 71Pay here: https://…"), must also be the wallet's
 * own for the link, read from its end, or it's refused: the same memo as the
 * line shows it (`displayText`), right-to-left isolates and spacing aside,
 * which is the link's and states nothing else; where it names a network, by
 * one of the networks' names or labels, "Local" or "Chain 2", the one it's
 * paid on, and a name of no network known, of any length, says nothing; the
 * same amount, or any amount for a link that asks none; and all before
 * "asks you" is who asks, whatever the name holds, "asks you to pay" or a
 * " · " too, the link's label where it has one, as written, or read as
 * `sameName` reads names. A line read as the wallet's own in more ways than
 * a few, as one whose name says the request again and again, is refused
 * too. Words that state none of these, as "Hi Marek," or "Thanks!", say
 * nothing of the link, and nor does a name the link can't be held to, as
 * "Sofía" over a link with no label.
 *
 * Null for text with no link, as an address, a `.dusk` name or words: Send
 * reads it as a recipient. `network` and `walletUrl` are
 * `readPaymentLink`'s. `text` is the link read, for a wallet that does more
 * with it, as opening a link for another network on that network's wallet.
 */
export declare function readPastedLink(input: unknown, options?: { network?: unknown; walletUrl?: string; owners?: DuskNameOwners }): PastedLinkRead | null;

/**
 * The `.dusk` names the words before a pasted link give, wherever they are,
 * as `nameDuskNames` of `/names` gives them, to look up before
 * `readPastedLink` reads the text (`owners`): "sofiadesign.dusk asks you to
 * pay…", "You're asked to pay 0.012 DUSK to alice.dusk…" or "alice.dusk:"
 * before it, "sofiadesign·dusk" with a middle dot or "ѕofiadesign.dusk"
 * with a Cyrillic ѕ among them, as "sofiadesign.dusk", and who asks read as
 * a name, "sofiadesign . dusk asks you…" too; not those in a request's
 * memo, which is its link's. With them, the .dusk name the link pays, where
 * the words give a Dusk address, to say whether it's that name's. None for
 * text without a link, for
 * text `readPastedLink` refuses for its links or for another amount, memo or
 * network, and for words naming none. `network` and `walletUrl` are
 * `readPastedLink`'s.
 */
export declare function pastedDuskNames(input: unknown, options?: { network?: unknown; walletUrl?: string }): string[];

/**
 * A link's amount as Send reads it, in `language` (the browser's, unless
 * given), the same in a preview before a wallet opens: what Send's amount
 * field holds once it's filled in from the link (`field`: `amountDusk` as
 * the link writes it, its point the language's mark; an exact amount in lux
 * as `amountForField` of `/amounts` writes it), and what the field reads, as
 * typing reads it (`readAmount`): the amount in lux, or the question it asks
 * of one that could mean two, as "1.000" or "2.125" (`problem`: "Is that
 * 2.1250 or 2125? Write the one you mean.", with `question` and the two
 * `choices`, for a button each), or what's wrong with one Send won't take
 * ("Enter an amount greater than 0."). Never one of the two amounts for the
 * other: a preview shows the question where there's one, not `link.lux`. A
 * link `makePaymentLink` made asks nothing. A link without an amount, or
 * none, is `{ field: "", lux: null, problem: null }`: any amount.
 */
export declare function linkAmount(link: PaymentLink | null | undefined, language?: string): { field: string } & AmountRead;

/** What `makePaymentLink` takes. */
export type PaymentRequest = {
  /** The account or shielded address that's paid. */
  to: string;
  /** The amount as a person typed it, read in `language`: optional, the payer fills it in then. */
  amount?: string | null;
  /** The amount in lux, in place of `amount`. */
  amountLux?: bigint | number | string | null;
  memo?: string | null;
  label?: string | null;
  /** The network it's for: a network, its chain ID, "dusk:2", or its name. */
  network?: Network | number | bigint | string | null;
  /** The browser's, unless given. */
  language?: string;
  /** The web wallet's address, where it isn't the network's. */
  walletUrl?: string;
};

/** The links asked for, or what's wrong in plain words, by the field it's about. */
export type MadePaymentLink = {
  ok: boolean;
  problems: { to?: string; amount?: string; memo?: string };
  /** The amount read, in lux; null where there's none. */
  lux: bigint | null;
  /** The `dusk:` link, for a QR code: "" with a problem. */
  dusk: string;
  /** The https link: null with a problem, and where the network has no web wallet or none is named. */
  https: string | null;
};

/**
 * Both links for a request, once it's one a payer can use. An amount and a
 * memo are optional, and a request can be made from what's typed as it's typed.
 * An amount with three decimals has a fourth, a zero, as "2.1250", so Send
 * reads it as it is, without the question typing "2.125" asks.
 */
export declare function makePaymentLink(request: PaymentRequest): MadePaymentLink;

/**
 * A request as both wallets share it, by Share and Copy alike: a line a
 * person reads, then the link, unchanged. "<name> asks you to pay <amount>
 * DUSK · <memo>", then "Pay here: <link>": `name` the requesting profile's
 * verified .dusk name, else the name the person gave it ("You're asked to
 * pay …" without one); the amount in lux (`lux`), written as every reader
 * reads it as that amount, in the decimal mark of `language` (the browser's,
 * unless given), without groups and with three decimals as four ("2,1250
 * DUSK"), or "asks you for a payment in DUSK" where the request names none;
 * " on Testnet" where `network`, a test network's name, is given; the memo
 * only where there is one. Right-to-left words in the name and the memo are
 * set apart, and what can't be seen in them shows as its codes, as on a
 * screen (`displayText` of `/text`).
 *
 * @example
 * ```js
 * requestMessage({ name: "sofiadesign.dusk", lux: 30_000_000n, memo: "Factura F-2026-071", link: made.https, language: "es-ES" });
 * // "sofiadesign.dusk asks you to pay 0,03 DUSK · Factura F-2026-071\nPay here: https://apps.dusk.network/wallet/dashboard/send?…"
 * ```
 */
export declare function requestMessage(request: { link: string; name?: string | null; lux?: bigint | number | string | null; memo?: string | null; network?: string | null; language?: string }): string;

/** A chain by its network's name: "Mainnet", "Local" for 0, "Chain 42" for one there's no file for, and "" for what isn't "dusk:" and a number. */
export declare function chainLabel(chain: unknown): string;

/** "This request is for Mainnet. You are on Testnet.", from a link's network and the wallet's, or "" when they agree or either isn't known. */
export declare function networkMismatch(linkChain: unknown, walletChain: unknown): string;

/** Which a recipient looks like, by its length in base58: "public", "shielded" or "unknown". An account's key is checked by `makePaymentLink`. */
export declare function recipientKind(recipient: unknown): "public" | "shielded" | "unknown";
