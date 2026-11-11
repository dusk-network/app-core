/**
 * Links that ask for a payment, for the Dusk apps: a `dusk:` link for a wallet
 * that reads them, as in a QR code, and an https link to the web wallet's
 * Send, which survives email and chat and says which network it's for. One
 * function reads both. A link is only made for what Send will take: a
 * recipient that is one, an amount above 0 with 9 decimals at most, and a memo
 * of 512 bytes at most, and what's wrong is said in plain words.
 *
 * @example
 * ```js
 * import { makePaymentLink, networkMismatch, parsePaymentLink } from "@dusk/app-core/payment-links";
 *
 * const made = makePaymentLink({ to: account, amount: "0,15", memo: "Factura 33", network: 1, language: "es-ES" });
 * // { ok: true, lux: 150000000n, dusk: "dusk:public-…@dusk:1?amount=0.15&memo=Factura+33",
 * //   https: "https://apps.dusk.network/wallet/dashboard/send?to=…&amount=0.15&memo=Factura+33&network=mainnet", problems: {} }
 * makePaymentLink({ to: account, amount: "1.234", network: 1, language: "es-ES" }).problems;
 * // { amount: "Is that about 1,23 or 1234? Write the one you mean." }
 *
 * const link = parsePaymentLink(made.https); // { form: "https", kind: "public", to, amountDusk: "0.15", memo: "Factura 33", chainId: "dusk:1", … }
 * networkMismatch(link.chainId, 2); // "This request is for Mainnet. You are on Testnet."
 *
 * // In Send, as a link is pasted, scanned or opened: on the wallet's network.
 * readPaymentLink(pasted, { network: 2 });
 * // { link: null, problem: "This request is for Mainnet. You are on Testnet.", reason: "other-network", chainId: "dusk:1", network: "Mainnet" }
 * ```
 *
 * @module
 */

import type { Network } from "@dusk-network/networks";

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
  /** The amount in plain DUSK, as the link says it; `amountForField` writes it for a field. */
  amountDusk: string;
  /** An exact amount in lux, when the link says one: then `amountDusk` is what it comes to. */
  amountLux: string;
  /** What `amountDusk` is in lux, or null where it isn't one. */
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
   * address), `LINK_BAD_ADDRESS` for a recipient Send can't pay, or
   * `LINK_UNREADABLE` for what has no form a payment link's has, as a `dusk:`
   * link with a `#`; "" when it fills in `link`.
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
 * fills in. Refused, in this order: amounts that differ (in DUSK and in lux,
 * or one of them twice, in any case); what `parsePaymentLink` can't read,
 * saying why; a recipient Send can't pay (`LINK_BAD_ADDRESS`): one that isn't
 * an account, a shielded address, a `.dusk` name or an EVM address, as two
 * addresses in one, or one with a line break or a hidden character in it,
 * which a field that drops them would make an address to pay; and a link for
 * another network, a `dusk:` link's by its `@` or its query alike.
 */
export declare function readPaymentLink(input: unknown, options?: { network?: unknown; walletUrl?: string }): LinkRead | null;

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
 */
export declare function makePaymentLink(request: PaymentRequest): MadePaymentLink;

/** A chain by its network's name: "Mainnet", "Local" for 0, "Chain 42" for one there's no file for, and "" for what isn't "dusk:" and a number. */
export declare function chainLabel(chain: unknown): string;

/** "This request is for Mainnet. You are on Testnet.", from a link's network and the wallet's, or "" when they agree or either isn't known. */
export declare function networkMismatch(linkChain: unknown, walletChain: unknown): string;

/** Which a recipient looks like, by its length in base58: "public", "shielded" or "unknown". An account's key is checked by `makePaymentLink`. */
export declare function recipientKind(recipient: unknown): "public" | "shielded" | "unknown";
