/* @ts-self-types="./payment-links.d.ts" */
/**
 * Links that ask for a payment: a `dusk:` link for a wallet that reads them,
 * as in a QR code, and an https link to the web wallet's Send, which survives
 * email and chat. One function reads both, and a link is only made for what
 * Send will take.
 *
 * @module
 */

import { blockedReason, networkFor, networks } from "@dusk-network/networks";
import { decodeBase58, isAccount } from "@dusk-network/networks/account";

import { amountForField, decimalSeparator, formatDuskPlain, parseDusk, readAmount, unclearAmount } from "./amounts.js";
import { looksAlike, nameDuskNames, sameName } from "./names.js";
import { ownerOf } from "./owners.js";
import { displayText } from "./text.js";

/** @typedef {import("./payment-links.js").PaymentLink} PaymentLink */
/** @typedef {import("./payment-links.js").PaymentRequest} PaymentRequest */
/** @typedef {import("./payment-links.js").MadePaymentLink} MadePaymentLink */
/** @typedef {import("./payment-links.js").LinkRead} LinkRead */
/** @typedef {import("./payment-links.js").PastedLinkRead} PastedLinkRead */
/** @typedef {import("@dusk-network/networks").Network} Network */

export const MAX_MEMO_BYTES = 512;

/** Where the web wallet's Send is, under the wallet's address. */
const SEND_PATH = "/dashboard/send";
// A chain's number as it's written once: "dusk:02" isn't chain 2's.
const CHAIN_ID = /^dusk:(0|[1-9]\d{0,31})$/i;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// A .dusk name as it can be written: its labels' letters, digits and hyphens, which Send resolves or says more of.
const DUSK_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.dusk$/i;
const ACCOUNT_BYTES = 96;
const SHIELDED_BYTES = 64;
const MAX_U64 = (1n << 64n) - 1n;

/** What a link may say, each once: the recipient, what's asked, and the network. */
const SAID_ONCE = Object.freeze(["to", "amount", "amountLux", "memo", "label", "network"]);

/** Each field by its name in lower case: a field is read by its name in any case, as a reader that ignores case reads it. */
const FIELD_NAMED = new Map(SAID_ONCE.map((name) => [name.toLowerCase(), name]));

// A field's name as links write it, every field's among them: printable ASCII, no space.
const PLAIN_NAME = /^[\x21-\x7e]*$/;

// An amount as a link writes it, after its percent-encoding: digits, with decimals after one point or comma.
const PLAIN_AMOUNT = /^(\d+([.,]\d*)?|[.,]\d+)$/;
// An amount in lux: digits alone.
const PLAIN_LUX = /^\d+$/;
// A line break of any kind.
const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/;

/** Why a link fills in nothing, in the words both wallets use. */
export const LINK_UNREADABLE = "That link can't be read. Ask for a new one.";
export const LINK_TWO_AMOUNTS = "This link asks for two different amounts. Ask for a new one.";
export const LINK_BAD_ADDRESS = "This link's address isn't valid. Ask for a new one.";
export const LINK_BAD_AMOUNT = "This link's amount can't be read. Ask for a new one.";
export const LINK_MEMO_LINE_BREAK = "This link's memo has a line break. Ask for a new one.";
/** Why pasted text fills in nothing, in the words both wallets use. */
export const LINK_SEVERAL = "That has more than one payment link. Paste just the one to pay.";
export const LINK_UNCLEAR = "The words after that link may be part of it. Paste the link alone.";
export const LINK_DISAGREES = "The message and its link don't agree.";
const LINK_NO_RECIPIENT = "This link doesn't say who to pay. Ask for a new one.";
const LINK_USER_PART = "This link has something before the site's address. Ask for a new one.";
const LINK_NETWORK_UNREAD = "This link's network can't be read. Ask for a new one.";
const LINK_SHIELDED_TO_PUBLIC = "This link asks for a shielded payment to a public account. Ask for a new one.";
const LINK_PUBLIC_TO_SHIELDED = "This link asks for a public payment to a shielded address. Ask for a new one.";

/** A field a link says twice, as a refusal names it. */
const FIELD_WORDS = Object.freeze({ amount: "the amount", amountLux: "the amount", label: "the label", memo: "the memo", network: "the network", to: "the recipient" });

/** What the apps say of a recipient they won't send to, by the network file's reason. */
const BLOCKED = Object.freeze({
  compromised: "Transfer restricted: this recipient address has been reported as compromised.",
  scam: "Transfer restricted: this recipient address is associated with reported fraud/scam activity.",
});

/**
 * @param {unknown} value
 */
const textOf = (value) => String(value ?? "").trim();

/**
 * A chain ID as a link writes it, "dusk:2", from a network, its number or
 * that text: "" for anything else.
 *
 * @param {unknown} network
 * @returns {string}
 */
function chainIdOf(network) {
  if (network && typeof network === "object") return chainIdOf(/** @type {Network} */ (network).chainId);
  if (typeof network === "number" && Number.isSafeInteger(network) && network >= 0) return `dusk:${network}`;
  if (typeof network === "bigint" && network >= 0n) return `dusk:${network}`;

  const text = textOf(network);

  if (CHAIN_ID.test(text)) return text;
  if (CHAIN_ID.test(`dusk:${text}`)) return `dusk:${text}`;

  const named = Object.values(networks).find((each) => each.name === text.toLowerCase());

  return named ? `dusk:${named.chainId}` : "";
}

/**
 * @param {unknown} chain
 * @returns {string}
 */
const referenceOf = (chain) => CHAIN_ID.exec(textOf(chain))?.[1] ?? "";

/**
 * A chain by its network's name: "Mainnet", "Local" for 0, "Chain 42" for one
 * there's no file for, and "" for what isn't a chain ID.
 *
 * @param {unknown} chain
 * @returns {string}
 */
export function chainLabel(chain) {
  const reference = referenceOf(chain);

  if (reference === "0") return "Local";

  return reference ? (networkFor(reference)?.label ?? `Chain ${reference}`) : "";
}

/**
 * @param {unknown} linkChain
 * @param {unknown} walletChain
 * @returns {string}
 */
export function networkMismatch(linkChain, walletChain) {
  const want = referenceOf(chainIdOf(linkChain));
  const have = referenceOf(chainIdOf(walletChain));

  if (!want || !have || want === have) return "";

  return `This request is for ${chainLabel(`dusk:${want}`)}. You are on ${chainLabel(`dusk:${have}`)}.`;
}

/**
 * @param {unknown} recipient
 * @returns {"public" | "shielded" | "unknown"}
 */
export function recipientKind(recipient) {
  const length = decodeBase58(textOf(recipient))?.length;

  return length === ACCOUNT_BYTES ? "public" : length === SHIELDED_BYTES ? "shielded" : "unknown";
}

/**
 * A query with each field named as links write it, whatever its case: "To"
 * and "AMOUNT" are `to` and `amount`. A field said in two cases is said
 * twice, and one said once in another case is still that field, never left
 * out.
 *
 * @param {URLSearchParams} params
 */
function fieldsOf(params) {
  const named = new URLSearchParams();

  params.forEach((value, name) => named.append(FIELD_NAMED.get(name.toLowerCase()) ?? name, value));

  return named;
}

/**
 * Whether a query's names say what a reader won't read them as: one that
 * isn't printable ASCII, as every field's name is (what can't be seen, a
 * space or a control, which one reader reads past and another drops, as
 * `am\u200bount`, `to\u0000` or `to `, and letters of another script or
 * form, as fullwidth `\uff54\uff4f`, a small capital in `\u0274etwork` or a
 * Cyrillic `\u0442o`), and one in ASCII that looks like a field's name but
 * isn't one, as `amountIux` with a capital I for the l of `amountLux`, or
 * `Iabel`. A person reading the link would take either for a field no
 * reader reads as one.
 *
 * @param {URLSearchParams} params As given, before `fieldsOf`
 */
function namesHide(params) {
  let hides = false;

  params.forEach((_, name) => {
    hides ||= !PLAIN_NAME.test(name) || (!FIELD_NAMED.has(name.toLowerCase()) && SAID_ONCE.some((field) => looksAlike(name, field)));
  });

  return hides;
}

/**
 * Whether a link's recipient is one Send can pay, or says more of: an
 * account, a shielded address, a `.dusk` name or an EVM address. Anything
 * else is no one to pay, as two addresses in one, or one with a line break
 * or a hidden character in it, though a field that drops what's in the way
 * would leave an address to pay.
 *
 * @param {string} to
 */
function payable(to) {
  const kind = recipientKind(to);

  return kind === "public" ? isAccount(to) : kind === "shielded" || DUSK_NAME.test(to) || EVM_ADDRESS.test(to);
}

/**
 * The amounts a link's query says: an exact amount in lux decides, and the
 * amount in DUSK is what it comes to.
 *
 * @param {URLSearchParams} params
 */
function amountsOf(params) {
  const amountLux = textOf(params.get("amountLux"));
  const amount = textOf(params.get("amount"));
  const amountDusk = /^\d+$/.test(amountLux) ? formatDuskPlain(amountLux) : amount || amountLux;

  return { amountDusk, amountLux, lux: parseDusk(amountDusk) };
}

/**
 * Why a query can't be read: a field it says more than once, in any case
 * (`fieldsOf`), as the link could be read two ways. "" for none.
 *
 * @param {URLSearchParams} params
 * @returns {string}
 */
function saidTwice(params) {
  const field = SAID_ONCE.find((name) => params.getAll(name).length > 1);

  return field ? twiceWords(/** @type {keyof typeof FIELD_WORDS} */ (field)) : "";
}

/** @param {keyof typeof FIELD_WORDS} field */
const twiceWords = (field) => `This link says ${FIELD_WORDS[field]} twice. Ask for a new one.`;

/**
 * @param {string} a A chain ID, "dusk:1"
 * @param {string} b
 */
const twoNetworks = (a, b) => `This link names two networks, ${chainLabel(a)} and ${chainLabel(b)}. Ask for a new one.`;

/**
 * A `dusk:` link: `dusk:public-<recipient>[@dusk:<chain>][?amount=…&memo=…&network=…]`,
 * or `shielded-`, or `dusk:<recipient>` with an account or a shielded
 * address as it is, with `//` after the scheme or not, and its query, its
 * network after the `@` or in its query, as an https link's; why it's
 * refused where it names two networks, one that can't be read, says a field
 * twice (a recipient in its query too) or no recipient, asks for one kind of
 * payment to the other kind's recipient, or has a `#`; and null for any other.
 *
 * @param {string} raw
 * @returns {{ link: PaymentLink, params: URLSearchParams } | { problem: string } | null}
 */
function duskForm(raw) {
  // Readers differ on what follows a #, a fragment to leave out or more of the query: it's read as neither.
  if (raw.includes("#")) return { problem: LINK_UNREADABLE };

  const rest = raw.replace(/^dusk:/i, "").replace(/^\/+/, "");
  const q = rest.indexOf("?");
  const given = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : "");
  const params = fieldsOf(given);
  let head = (q >= 0 ? rest.slice(0, q) : rest).trim();
  let atChain = "";
  const at = head.lastIndexOf("@");

  if (at > 0) {
    atChain = head.slice(at + 1).trim();
    head = head.slice(0, at).trim();
  }

  const named = /^public-/i.test(head) ? "public" : /^shielded-/i.test(head) ? "shielded" : null;
  // Without its kind, the recipient is all there is: an account or a shielded address, as it's written.
  const bare = named ? null : recipientKind(head);
  const kind = named ?? (bare === "unknown" ? null : bare);

  if (!kind) return null;

  // The link names its recipient already: one in its query says it twice.
  const twice = saidTwice(params) || (params.has("to") ? twiceWords("to") : "");
  const network = textOf(params.get("network"));
  const queryChain = chainIdOf(network);

  if (twice) return { problem: twice };
  if (namesHide(given)) return { problem: LINK_UNREADABLE };
  if ((atChain && !referenceOf(atChain)) || (network && !queryChain)) return { problem: LINK_NETWORK_UNREAD };
  if (atChain && queryChain && referenceOf(atChain) !== referenceOf(queryChain)) return { problem: twoNetworks(atChain, queryChain) };

  let to = named ? head.slice(named.length + 1) : head;

  try {
    if (named) to = decodeURIComponent(to);
  } catch {
    // Not percent-encoding after all: as it is.
  }

  to = to.trim();

  if (!to) return { problem: LINK_NO_RECIPIENT };

  // The kind it names is the payment it asks for: a recipient of the other kind would be paid the other way.
  const actual = recipientKind(to);

  if (named === "shielded" && actual === "public") return { problem: LINK_SHIELDED_TO_PUBLIC };
  if (named === "public" && actual === "shielded") return { problem: LINK_PUBLIC_TO_SHIELDED };

  return { link: { ...amountsOf(params), chainId: atChain || queryChain, form: "dusk", kind, label: textOf(params.get("label")), memo: textOf(params.get("memo")), raw, to }, params };
}

/**
 * An address without its trailing slashes.
 *
 * @param {string} url
 */
const trimmed = (url) => url.replace(/\/+$/, "");

/**
 * An https link to the web wallet's Send, and its query: `undefined` when it's
 * no such link; why it's refused where it has a user part before its host,
 * which makes it read as another address than the one it goes to, says a
 * field more than once, names a network that can't be read or another than
 * its wallet's, or no recipient.
 *
 * @param {string} raw
 * @param {string | undefined} walletUrl
 * @returns {{ link: PaymentLink, params: URLSearchParams } | { problem: string } | undefined}
 */
function walletForm(raw, walletUrl) {
  /** @type {URL} */
  let url;

  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  const page = `${url.origin}${trimmed(url.pathname)}`;
  const ours = Object.values(networks).find((net) => net.apps.wallet && `${trimmed(net.apps.wallet)}${SEND_PATH}` === page);

  if (!ours && (!walletUrl || `${trimmed(walletUrl)}${SEND_PATH}` !== page)) return undefined;

  // Its fragment is the browser's: the page it opens leaves it out, and so does this.
  const params = fieldsOf(url.searchParams);
  const said = textOf(params.get("network"));
  const chainId = chainIdOf(said);
  const to = textOf(params.get("to"));
  const twice = saidTwice(params);

  if (url.username || url.password) return { problem: LINK_USER_PART };
  if (twice) return { problem: twice };
  if (namesHide(url.searchParams)) return { problem: LINK_UNREADABLE };
  if (said && !chainId) return { problem: LINK_NETWORK_UNREAD };
  // A link that says one network, on another network's wallet.
  if (ours && chainId && referenceOf(chainId) !== String(ours.chainId)) return { problem: twoNetworks(`dusk:${ours.chainId}`, chainId) };
  if (!to) return { problem: LINK_NO_RECIPIENT };

  return {
    link: {
      ...amountsOf(params),
      chainId: chainId || (ours ? `dusk:${ours.chainId}` : ""),
      form: "https",
      kind: recipientKind(to),
      label: textOf(params.get("label")),
      memo: textOf(params.get("memo")),
      raw,
      to,
    },
    params,
  };
}

/**
 * A link and its query, as given, or why it's refused: null for nothing, and
 * for a `dusk:` link of no form a payment's has; a recipient as it is with no
 * query.
 *
 * @param {string} raw
 * @param {string | undefined} walletUrl
 * @returns {{ link: PaymentLink, params: URLSearchParams | null } | { problem: string } | null}
 */
function readLink(raw, walletUrl) {
  if (!raw) return null;
  if (/^dusk:/i.test(raw)) return duskForm(raw);

  const https = walletForm(raw, walletUrl);

  // Anything else may be a recipient, as a QR code holds just the address.
  return https === undefined ? { link: { amountDusk: "", amountLux: "", chainId: "", form: "raw", kind: "unknown", label: "", lux: null, memo: "", raw, to: raw }, params: null } : https;
}

/**
 * @param {unknown} input
 * @param {{ walletUrl?: string }} [options]
 * @returns {PaymentLink | null}
 */
export function parsePaymentLink(input, { walletUrl } = {}) {
  const read = readLink(textOf(input), walletUrl);

  return read && "link" in read ? read.link : null;
}

// A tab or a line break, which the URL parser drops from anywhere in a link.
const DROPPED = /[\t\n\r]/g;
// A control or a space at either end of a link, which the URL parser drops too.
const LINK_ENDS = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;

/**
 * A link's query as it's written, its fields named in any case: all after
 * its first `?` up to its first `#`, which a `dusk:` link's reading refuses
 * and an https link's fragment is. An https link's is read as the URL parser
 * reads it, but for the tabs and line breaks in its values, which it drops,
 * so joining what's around them: an amount of "0.001", a tab and "5" is
 * 0.0015 to it, and here it's as written. Its fields' names are the
 * parser's, what it drops dropped before they're decoded, so a name it reads
 * as a field's, as "%6", a tab and "1mount" for `amount`, is that field's
 * here too.
 *
 * @param {string} raw
 */
function queryOf(raw) {
  const dusk = /^dusk:/i.test(raw);
  const [link] = (dusk ? raw : raw.replace(LINK_ENDS, "")).split("#");
  const q = link.indexOf("?");
  const query = q >= 0 ? link.slice(q + 1) : "";

  if (dusk) return fieldsOf(new URLSearchParams(query));

  // Each field's name without what the parser drops; the tabs and line breaks in its value kept, encoded.
  const written = query
    .split("&")
    .map((field) => {
      const is = field.indexOf("=");

      return is < 0 ? field.replace(DROPPED, "") : `${field.slice(0, is).replace(DROPPED, "")}=${field.slice(is + 1).replace(DROPPED, encodeURIComponent)}`;
    })
    .join("&");

  // An empty fragment after it, so the parser keeps what's at the query's end, as in the link it's read from.
  return fieldsOf(new URL(`https://link.invalid/?${written}#`).searchParams);
}

/**
 * Whether a link says amounts that differ: in DUSK and in lux, or one of them
 * twice. The one in lux would be paid, unlike what's read.
 *
 * @param {URLSearchParams} params
 */
function amountsDiffer(params) {
  const lux = [
    ...params.getAll("amount").map((text) => parseDusk(textOf(text))),
    ...params.getAll("amountLux").map((text) => (/^\d+$/.test(textOf(text)) ? BigInt(textOf(text)) : null)),
  ];

  return new Set(lux.map(String)).size > 1;
}

/**
 * Whether a link's amount, as its percent-encoding gives it, is no plain
 * number: anything in it or around it but digits and one point or comma,
 * as a `#` it encodes (`%23`), what can't be seen or a space. A field that
 * drops what's in the way would show an amount the link doesn't say.
 *
 * @param {URLSearchParams} params
 */
const amountUnread = (params) => params.getAll("amount").some((text) => text !== "" && !PLAIN_AMOUNT.test(text)) || params.getAll("amountLux").some((text) => text !== "" && !PLAIN_LUX.test(text));

/**
 * A link read, with the name of the network it's for.
 *
 * @param {Omit<LinkRead, "network">} read
 * @returns {LinkRead}
 */
const said = (read) => ({ ...read, network: chainLabel(read.chainId) });

/**
 * @param {unknown} input
 * @param {{ network?: unknown, walletUrl?: string }} [options]
 * @returns {LinkRead | null}
 */
export function readPaymentLink(input, { network, walletUrl } = {}) {
  const raw = textOf(input);
  const read = readLink(raw, walletUrl);
  const link = read && "link" in read ? read.link : null;

  if (!raw || link?.form === "raw") return null;

  const chainId = link?.chainId ?? "";
  const query = queryOf(raw);

  if (amountUnread(query)) return said({ chainId, link: null, problem: LINK_BAD_AMOUNT, reason: "unreadable" });
  if (amountsDiffer(query)) return said({ chainId, link: null, problem: LINK_TWO_AMOUNTS, reason: "two-amounts" });
  if (!link) return said({ chainId, link: null, problem: (read && "problem" in read && read.problem) || LINK_UNREADABLE, reason: "unreadable" });
  // A recipient that can't be paid on any network, before which network the link is for.
  if (!payable(link.to)) return said({ chainId, link: null, problem: LINK_BAD_ADDRESS, reason: "unreadable" });
  // A memo is one line, as both wallets' requests write it: one with a line break would be read one way by one and another by the other.
  if (LINE_BREAK.test(link.memo)) return said({ chainId, link: null, problem: LINK_MEMO_LINE_BREAK, reason: "unreadable" });

  const otherNetwork = networkMismatch(chainId, network);

  return said(otherNetwork ? { chainId, link: null, problem: otherNetwork, reason: "other-network" } : { chainId, link, problem: "", reason: "" });
}

// A space or a line break of any kind, which ends a link in text, as a chat ends one: a next line (U+0085) among
// them, which `\s` leaves out.
const SPACES = /[\s\u0085]+/;
const SPACE = /^[\s\u0085]$/;
// A line break of any kind, Windows' among them.
const LINES = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;
// "You're", as a request's line starts without a name, with a typographic apostrophe too.
const YOURE = /^you['\u2019]re$/i;
// The isolates a line sets right-to-left words apart with (`displayText`), which a chat may drop.
const ISOLATES = /[\u2066-\u2069]/g;

/**
 * Text without the spaces and line breaks of any kind at its ends.
 *
 * @param {string} text
 */
function withinSpaces(text) {
  let start = 0;
  let end = text.length;

  while (start < end && SPACE.test(text[start])) start += 1;
  while (end > start && SPACE.test(text[end - 1])) end -= 1;

  return text.slice(start, end);
}

/**
 * A link read from what was pasted, with the link as it's written there.
 *
 * @param {LinkRead | null} read
 * @param {string} text
 * @returns {PastedLinkRead | null}
 */
const readFrom = (read, text) => read && { ...read, text };

/**
 * What pasted text refused for `problem` fills in: nothing, from no link.
 *
 * @param {string} problem
 * @param {"several-links" | "words-after" | "disagrees"} reason
 * @returns {PastedLinkRead}
 */
const pasteRefused = (problem, reason) => ({ chainId: "", link: null, network: "", problem, reason, text: "" });

/**
 * Pasted text's one payment link, its last word, as it's written there, and
 * the words before it; why it's refused, with two links or more, or with
 * words after its one, which a space or a line break of any kind parts from
 * it, as a chat parts them; null for none.
 *
 * @param {unknown} input
 * @param {{ walletUrl?: string }} options
 * @returns {{ before: string, link: string } | { refused: PastedLinkRead } | null}
 */
function pastedParts(input, { walletUrl }) {
  const pasted = textOf(input);
  const words = pasted.split(SPACES).filter(Boolean);
  const links = words.filter((word) => readPaymentLink(word, { walletUrl }));

  // Two links, wherever they are: read whole, one would carry the other in its memo.
  if (links.length > 1) return { refused: pasteRefused(LINK_SEVERAL, "several-links") };
  if (!links.length) return null;
  // A link ends at a space: what's after it may be part of it, or words that aren't, never its memo's or its network's.
  if (words[words.length - 1] !== links[0]) return { refused: pasteRefused(LINK_UNCLEAR, "words-after") };

  return { before: pasted.slice(0, pasted.lastIndexOf(links[0])), link: links[0] };
}

/**
 * Text without "Pay here:" at its end, as a shared request has it before its
 * link (`requestMessage`), in any case and spacing: "Pay", a space or a line
 * break of any kind, "here", and a colon, a space before it or not; and
 * without the spaces before it.
 *
 * @param {string} text Without spaces at its end
 */
function withoutPayHere(text) {
  let end = text.length - 1;

  if (text[end] !== ":") return text;

  while (end > 0 && SPACE.test(text[end - 1])) end -= 1;

  let at = end - 4;

  if (at < 0 || text.slice(at, end).toLowerCase() !== "here") return text;

  const here = at;

  while (at > 0 && SPACE.test(text[at - 1])) at -= 1;

  return at < here && at >= 3 && text.slice(at - 3, at).toLowerCase() === "pay" ? withinSpaces(text.slice(0, at - 3)) : text;
}

/**
 * The words of the line of a request as both wallets share it
 * (`requestMessage`), from the words before its link: its last line, without
 * "Pay here:", in NFC and without the isolates that set right-to-left words
 * apart, which a chat may drop; null for none.
 *
 * @param {string} before
 * @returns {string[] | null}
 */
function lineWords(before) {
  const lines = withoutPayHere(withinSpaces(before)).split(LINES);
  const words = lines[lines.length - 1].normalize("NFC").replace(ISOLATES, "").split(SPACES).filter(Boolean);

  return words.length ? words : null;
}

// How many ways a line can be the wallet's own for its link: a name holding "asks you to pay … DUSK on …" makes
// one more each time it does. A line read in more ways than this is no line the wallet writes.
const READINGS = 4;
// How many words a known network's name has at most: "Testnet", "Chain 2". A longer one names no network known.
const NAMED_WORDS = Math.max(2, ...Object.values(networks).flatMap((net) => [net.label, net.name].map((name) => String(name).trim().split(/\s+/).length)));

/**
 * Whether a line's words are a request's as both wallets share it, read in
 * any of the ways they can be: "<name> asks you to pay <amount> DUSK" or
 * "<name> asks you for a payment in DUSK", or "You're asked …" without a
 * name, then " on <network>" and " · <memo>" where it says them, in any case
 * and spacing. A name or a memo may hold any of those words: "Alice asks you
 * to pay asks you to pay 0.03 DUSK" is one, from a profile named "Alice asks
 * you to pay".
 *
 * @param {string[]} words
 */
function isSharedLine(words) {
  const said = words.map((word) => word.toLowerCase());
  const count = said.length;
  // What may follow what's asked: nothing, a network, or a memo.
  const ends = (/** @type {number} */ at) => at >= count || said[at] === "\u00b7" || (said[at] === "on" && at + 1 < count && said[at + 1] !== "\u00b7");
  // Whether a "DUSK" at or after a word ends what's asked, for each word.
  const duskFrom = Array.from({ length: count + 2 }, () => false);

  for (let at = count - 1; at >= 0; at -= 1) duskFrom[at] = duskFrom[at + 1] || (said[at] === "dusk" && ends(at + 1));

  /** @param {number} at */
  const asks = (at) => (said[at] === "to" && said[at + 1] === "pay" && duskFrom[at + 3]) || (["for", "a", "payment", "in", "dusk"].every((word, i) => said[at + i] === word) && ends(at + 5));

  return (YOURE.test(words[0]) && said[1] === "asked" && asks(2)) || said.some((word, at) => at > 0 && word === "asks" && said[at + 1] === "you" && asks(at + 2));
}

/**
 * The names a line's words give who asks by, read the one way that's the
 * wallet's own line for a link: its memo as the line shows it, its last
 * words; the network it's paid on, by its name, or none, before; and its
 * amount, or any amount, before that. Each name is what's before "asks you",
 * "" for "You're asked"; none where no reading says what the link does, and
 * more than `READINGS` where it can be read in more ways than the wallet's
 * own line is.
 *
 * @param {string[]} words
 * @param {PaymentLink} link
 * @param {string} paidOn The chain it's paid on, "dusk:2", or ""
 * @returns {string[]}
 */
function namesSaying(words, link, paidOn) {
  const said = words.map((word) => word.toLowerCase());
  const shown = shownAs(displayText(link.memo, { isolate: true }).text);
  const memo = shown ? shown.split(" ") : [];
  const end = memo.length ? words.length - memo.length - 1 : words.length;

  if (end < 0 || (memo.length && (words[end] !== "\u00b7" || memo.some((word, i) => words[end + 1 + i] !== word)))) return [];

  const asked = PLAIN_LUX.test(link.amountLux) ? [BigInt(link.amountLux)] : link.amountDusk ? amountsIn(link.amountDusk) : [];
  /** @type {string[]} */
  const names = [];

  // Where what's asked ends: at the memo, or before " on " and a network's name, of any length, with no " · " in it.
  for (let on = end; on >= 1; on -= 1) {
    if (on < end && said[on] === "\u00b7") break;
    if ((on < end && (said[on] !== "on" || on + 1 === end)) || said[on - 1] !== "dusk") continue;
    if (on < end && end - on - 1 <= NAMED_WORDS && otherNetwork(words.slice(on + 1, end).join(" "), paidOn)) continue;

    // "to pay <amount> DUSK", or "for a payment in DUSK", and what's before it.
    for (const [from, amount] of /** @type {const} */ ([[on - 4, words[on - 2]], [on - 5, null]])) {
      const asks = amount === null ? ["for", "a", "payment", "in"].every((word, i) => said[from + i] === word) : said[from] === "to" && said[from + 1] === "pay";
      const fits = amount === null ? asked.length === 0 : sameAmount(amountsIn(amount), asked);

      if (!asks || !fits) continue;
      if (from === 2 && YOURE.test(words[0]) && said[1] === "asked") names.push("");
      if (from >= 3 && said[from - 2] === "asks" && said[from - 1] === "you") names.push(words.slice(0, from - 2).join(" "));
      if (names.length > READINGS) return names;
    }
  }

  return names;
}

/**
 * The amounts in lux an amount as it's written can be: one, or two where a
 * lone point or comma could mark decimals or part thousands, as "1.000"
 * (`unclearAmount`); null for one that isn't a plain amount.
 *
 * @param {string} text
 * @returns {(bigint | null)[]}
 */
function amountsIn(text) {
  const plain = textOf(text);

  if (!PLAIN_AMOUNT.test(plain)) return [null];

  const either = unclearAmount(plain, ".");

  return either ? [parseDusk(either.grouped), parseDusk(either.decimal)] : [parseDusk(plain.replace(",", "."))];
}

/**
 * Whether two lists of amounts (`amountsIn`) say one and the same amount, or
 * both none.
 *
 * @param {(bigint | null)[]} a
 * @param {(bigint | null)[]} b
 */
const sameAmount = (a, b) => (a.length === 0 && b.length === 0) || (a.length === 1 && b.length === 1 && a[0] !== null && a[0] === b[0]);

/**
 * Text as a line of a shared request shows it, for comparing: in NFC,
 * without the isolates that set right-to-left words apart, its spaces as one.
 *
 * @param {string} text
 */
const shownAs = (text) => text.normalize("NFC").replace(ISOLATES, "").replace(/[\s\u0085]+/g, " ").trim();

/**
 * The chain a network's name in a line names, "2" for "Testnet", by a
 * network's own name or label, "Local" or "Chain 2", in any case; "" for a
 * name of no network known, as a node's.
 *
 * @param {string} said
 */
function chainNamed(said) {
  const named = said.trim().toLowerCase();
  const net = Object.values(networks).find((each) => each.label.toLowerCase() === named || each.name.toLowerCase() === named);

  return net ? String(net.chainId) : named === "local" ? "0" : (/^chain (0|[1-9]\d{0,31})$/.exec(named)?.[1] ?? "");
}

/**
 * Whether a line names another network than the one it's paid on: the
 * link's, or for a link that names none, the wallet's, by which network it
 * is, not what it's called: "Chain 2" is Testnet. A name of no network
 * known says nothing, and nor does a network not known to be paid on.
 *
 * @param {string} said
 * @param {string} chainId Where it's paid, "dusk:2"
 */
function otherNetwork(said, chainId) {
  const named = chainNamed(said);
  const paidOn = referenceOf(chainId);

  return named !== "" && paidOn !== "" && named !== paidOn;
}

/**
 * Whether a line's name is another than its link's: the link's label it
 * isn't, as written or in any case, spacing or accents; a .dusk name it pays that isn't
 * among the line's; or, for an account or a shielded address it pays, the
 * .dusk names in the line as the name service says whose they are (`owners`):
 * another account's or address's of that kind, or no one's, and none of
 * them its own. A name that isn't looked up says nothing.
 *
 * @param {string} name
 * @param {PaymentLink} link
 * @param {unknown} owners
 */
function otherName(name, link, owners) {
  if (!shownAs(name)) return false;
  const label = shownAs(displayText(link.label, { isolate: true }).text);

  // As written, though it has no letters or digits to compare, as an emoji's; else as the look-alike rules read it.
  if (label && shownAs(name) !== label && !sameName(shownAs(name), label)) return true;

  const named = DUSK_NAME.test(link.to);

  // Its .dusk names say something only of a .dusk name it pays, or as the name service says whose they are.
  if (!named && (!owners || typeof owners !== "object")) return false;

  const dusk = nameDuskNames(name);

  if (!dusk.length) return false;
  if (named) return !dusk.includes(link.to.toLowerCase());

  const kind = recipientKind(link.to);
  let other = false;

  for (const each of dusk) {
    const owner = ownerOf(owners, each);
    // What it resolves to of the link's recipient's kind: a shielded address for a shielded one.
    const same = owner ? [...owner].filter((id) => recipientKind(id) === kind) : [];

    if (same.includes(link.to)) return false;

    other ||= owner === null || same.length > 0;
  }

  return other;
}

/**
 * The link pasted text's line is checked against: the one it fills in, or
 * one for another network, which the wallet of that network would; null for
 * one the link alone refuses.
 *
 * @param {LinkRead | null} read
 * @param {string} text The link
 * @param {string | undefined} walletUrl
 */
const linkSaid = (read, text, walletUrl) => read?.link ?? (read?.reason === "other-network" ? parsePaymentLink(text, { walletUrl }) : null);

/**
 * @param {unknown} input
 * @param {{ network?: unknown, walletUrl?: string, owners?: unknown }} [options]
 * @returns {PastedLinkRead | null}
 */
export function readPastedLink(input, { network, owners, walletUrl } = {}) {
  const parts = pastedParts(input, { walletUrl });

  if (!parts || "refused" in parts) return parts?.refused ?? null;

  const read = readPaymentLink(parts.link, { network, walletUrl });
  const words = parts.before ? lineWords(parts.before) : null;
  // What the link alone refuses, it refuses as the link alone says it; one that can be paid, here or on its own
  // network's wallet, only where its line, if it's a request's, is the wallet's own for it: another amount, network,
  // memo or name refuses it.
  const link = linkSaid(read, parts.link, walletUrl);
  const names = words && link && isSharedLine(words) ? namesSaying(words, link, link.chainId || chainIdOf(network)) : null;
  const disagrees = names && link && (names.length > READINGS || !names.some((name) => !otherName(name, link, owners)));

  return disagrees ? pasteRefused(LINK_DISAGREES, "disagrees") : readFrom(read, parts.link);
}

/**
 * @param {unknown} input
 * @param {{ network?: unknown, walletUrl?: string }} [options]
 * @returns {string[]}
 */
export function pastedDuskNames(input, { network, walletUrl } = {}) {
  const parts = pastedParts(input, { walletUrl });

  if (!parts || "refused" in parts || !parts.before) return [];

  const words = lineWords(parts.before);
  const link = linkSaid(readPaymentLink(parts.link, { network, walletUrl }), parts.link, walletUrl);

  const names = words && link && isSharedLine(words) ? namesSaying(words, link, link.chainId || chainIdOf(network)) : [];

  return names.length > READINGS ? [] : [...new Set(names.flatMap((name) => nameDuskNames(name)))];
}

/**
 * @param {PaymentLink | null | undefined} link
 * @param {string} [language] The browser's, unless given
 * @returns {{ field: string } & import("./amounts.js").AmountRead}
 */
export function linkAmount(link, language) {
  const decimal = decimalSeparator(language);
  // As Send's field holds it once filled in from the link, and reads it back, as typing reads it: an amount in DUSK as
  // the link writes it, its point the language's mark, so "2.125" asks as typed 2.125 does; an exact one in lux as
  // the amount it is, which a fourth decimal keeps from asking.
  const field = !link?.amountDusk ? "" : PLAIN_LUX.test(textOf(link.amountLux)) ? amountForField(link.amountDusk, decimal) : link.amountDusk.replace(".", decimal);

  return { field, ...readAmount(field, language) };
}

/**
 * An amount given in lux, as `readAmount` reads a typed one.
 *
 * @param {bigint | number | string} amount
 * @returns {{ lux: bigint | null, problem: string | null }}
 */
function readLux(amount) {
  // A number past the safe integers has already lost its last digits.
  if (typeof amount === "number" && !Number.isSafeInteger(amount)) return { lux: null, problem: "That amount is too large." };

  const text = String(amount).trim();
  const lux = /^\d+$/.test(text) ? BigInt(text) : null;

  if (lux === null || lux === 0n) return { lux: null, problem: "Enter an amount greater than 0." };

  return lux > MAX_U64 ? { lux: null, problem: "That amount is too large." } : { lux, problem: null };
}

/**
 * What's wrong with a recipient a link would pay, in the words of Send.
 *
 * @param {string} to
 * @param {Network | null} net
 * @returns {string | null}
 */
function recipientProblem(to, net) {
  if (EVM_ADDRESS.test(to)) return "That's an EVM address, not a Dusk account.";

  const kind = recipientKind(to);

  if (kind === "unknown" || (kind === "public" && !isAccount(to))) return "Not a valid address. Check it and try again.";

  const blocked = kind === "public" ? (net ? [net] : Object.values(networks)).map((each) => blockedReason(each, to)).find(Boolean) : null;

  return blocked ? BLOCKED[blocked] : null;
}

/**
 * @param {PaymentRequest} request
 * @returns {MadePaymentLink}
 */
export function makePaymentLink({ amount, amountLux, label, language, memo, network, to, walletUrl }) {
  const recipient = textOf(to);
  const chainId = chainIdOf(network);
  const reference = referenceOf(chainId);
  const net = reference ? networkFor(reference) : null;
  const message = textOf(memo);
  const read = amountLux === undefined || amountLux === null || amountLux === "" ? readAmount(String(amount ?? ""), language) : readLux(amountLux);
  /** @type {MadePaymentLink["problems"]} */
  const problems = {};
  const toProblem = recipientProblem(recipient, net);

  if (toProblem) problems.to = toProblem;
  if (read.problem) problems.amount = read.problem;
  if (new TextEncoder().encode(message).length > MAX_MEMO_BYTES) problems.memo = `That memo is too long: ${MAX_MEMO_BYTES} bytes at most.`;
  // A link's memo is one line, as Send reads one (`readPaymentLink`).
  else if (LINE_BREAK.test(message)) problems.memo = "Write the memo on one line.";

  if (Object.keys(problems).length) return { dusk: "", https: null, lux: read.lux, ok: false, problems };

  /** @type {[string, string][]} */
  const asked = [
    // Read as typing reads it, as Send reads a link's: three decimals have a fourth, a zero, so 2.125 isn't asked about.
    ["amount", read.lux === null ? "" : amountForField(formatDuskPlain(read.lux), ".")],
    ["memo", message],
    ["label", textOf(label)],
  ];
  const says = asked.filter(([, value]) => value);
  const tail = new URLSearchParams(says).toString();
  const dusk = `dusk:${recipientKind(recipient)}-${encodeURIComponent(recipient)}${chainId ? `@${chainId}` : ""}${tail ? `?${tail}` : ""}`;
  const walletAt = walletUrl ?? net?.apps.wallet ?? null;
  // The network last, so a link cut at its last punctuation still reads whole.
  const wallet = new URLSearchParams([["to", recipient], ...says, ["network", net?.name ?? chainId]]);

  return { dusk, https: walletAt && chainId ? `${trimmed(walletAt)}${SEND_PATH}?${wallet}` : null, lux: read.lux, ok: true, problems };
}

/**
 * @param {{ link: string, name?: string | null, lux?: bigint | number | string | null, memo?: string | null, network?: string | null, language?: string }} request
 * @returns {string}
 */
export function requestMessage({ language, link, lux, memo, name, network }) {
  const amount = typeof lux === "bigint" || (typeof lux === "number" && Number.isSafeInteger(lux)) || (typeof lux === "string" && /^\d+$/.test(lux.trim())) ? BigInt(typeof lux === "string" ? lux.trim() : lux) : null;
  // As a field writes it, which every reader reads as that amount: no groups, and three decimals with a fourth, a zero.
  const asked = amount !== null && amount > 0n ? `${amountForField(formatDuskPlain(amount), decimalSeparator(language))} DUSK` : "";
  // Right-to-left words set apart, and what can't be seen as its codes, as on a screen.
  const who = displayText(textOf(name), { isolate: true }).text;
  const on = textOf(network) ? ` on ${textOf(network)}` : "";
  const asks = who ? (asked ? `${who} asks you to pay ${asked}` : `${who} asks you for a payment in DUSK`) : asked ? `You're asked to pay ${asked}` : "You're asked for a payment in DUSK";
  const words = textOf(memo) ? ` · ${displayText(textOf(memo), { isolate: true }).text}` : "";

  return `${asks}${on}${words}\nPay here: ${textOf(link)}`;
}
