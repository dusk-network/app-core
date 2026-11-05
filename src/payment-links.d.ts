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
 * // { amount: "Is that 1234 or 1,234? Write the one you mean." }
 *
 * const link = parsePaymentLink(made.https); // { form: "https", kind: "public", to, amountDusk: "0.15", memo: "Factura 33", chainId: "dusk:1", … }
 * networkMismatch(link.chainId, 2); // "This request is for Mainnet. You are on Testnet."
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
 * Reads a `dusk:` link (`dusk:public-…`, `dusk:shielded-…`, with `//` or not,
 * and `@dusk:2` for its network), an https link to the web wallet's Send on
 * any network there's a file for (or at `walletUrl`, the app's own address),
 * or a recipient as it is, as a QR code may hold. Null for nothing, for a
 * `dusk:` link that isn't one of those, for a wallet link without a recipient,
 * and for one that says one network on another network's wallet. An https link
 * to anywhere else is no payment link: it reads as a recipient, which Send
 * refuses. Nothing is checked here but its form: Send checks what it fills in.
 */
export declare function parsePaymentLink(input: unknown, options?: { walletUrl?: string }): PaymentLink | null;

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
