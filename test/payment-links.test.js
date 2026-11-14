import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";

import { activityRows } from "../src/activity.js";
import { amountForField, parseDusk, normalizeAmount, decimalSeparator, readAmount } from "../src/amounts.js";
import { LINK_TWO_AMOUNTS, LINK_UNREADABLE, MAX_MEMO_BYTES, chainLabel, linkAmount, makePaymentLink, networkMismatch, parsePaymentLink, readPaymentLink, recipientKind } from "../src/payment-links.js";
import { A, B, recorded } from "./fixtures/activity.js";
import { like } from "./fixtures/helpers.js";

/**
 * What Send's field holds of a link's amount and what it says of it, without the readings to choose from.
 *
 * @param {{ field: string, lux: bigint | null, problem: string | null }} read
 */
const said = ({ field, lux, problem }) => ({ field, lux, problem });

// A real shielded address, as a shield of the recording names it.
const SHIELDED = /** @type {string} */ (activityRows({ public: [recorded(B, 2517213)], account: B, network: 2 })[0].counterparty);

describe("an amount given in lux", () => {
  it("refuses a number that has already lost its last digits", () => {
    const made = makePaymentLink({ amountLux: 18_100_000_000_000_008, network: "mainnet", to: "public-abc" });

    assert.equal(made.ok, false);
    assert.equal(made.problems.amount, "That amount is too large.");
    assert.ok(makePaymentLink({ amountLux: 18_100_000_000_000_008n, network: "mainnet", to: "public-abc" }).lux === 18_100_000_000_000_008n);
  });
});

describe("a dusk: link, as wallets have read them", () => {
  it("reads a public link", () => {
    like(parsePaymentLink("dusk:public-abc123"), { amountDusk: "", chainId: "", form: "dusk", kind: "public", memo: "", to: "abc123" });
  });

  it("reads a shielded link", () => {
    like(parsePaymentLink("dusk:shielded-xyz789"), { kind: "shielded", to: "xyz789" });
  });

  it("reads its chain, and refuses one that isn't", () => {
    like(parsePaymentLink("dusk:public-abc@dusk:2"), { chainId: "dusk:2", kind: "public", to: "abc" });
    assert.equal(parsePaymentLink("dusk:public-abc@dusk:abc"), null);
    assert.equal(parsePaymentLink("dusk:public-abc@eip155:1"), null);
  });

  it("reads the network its query names, as an https link's, and refuses one naming two", () => {
    for (const named of ["testnet", "Testnet", "dusk:2", "2"]) {
      like(parsePaymentLink(`dusk:public-abc?amount=0.001&network=${named}`), { chainId: "dusk:2", form: "dusk", to: "abc" }, named);
    }

    like(parsePaymentLink("dusk:public-abc@dusk:2?network=testnet"), { chainId: "dusk:2" });
    assert.equal(parsePaymentLink("dusk:public-abc@dusk:1?network=testnet"), null);
    assert.equal(parsePaymentLink("dusk:public-abc?network=nowhere"), null);
  });

  it("reads its query", () => {
    like(parsePaymentLink("dusk:public-abc?amount=1.5&memo=Hello&label=Alice"), { amountDusk: "1.5", label: "Alice", lux: 1_500_000_000n, memo: "Hello", to: "abc" });
    like(parsePaymentLink("dusk:public-abc?memo=Payment+for+coffee"), { memo: "Payment for coffee" });
  });

  it("reads an exact amount in lux, which decides what the link asks", () => {
    like(parsePaymentLink("dusk:public-abc?amountLux=1500000000"), { amountDusk: "1.5", amountLux: "1500000000", lux: 1_500_000_000n });
    like(parsePaymentLink("dusk:public-abc?amount=99&amountLux=1500000000"), { amountDusk: "1.5", lux: 1_500_000_000n });
    like(parsePaymentLink("dusk:public-abc?amountLux=abc"), { amountDusk: "abc", lux: null });
  });

  it("takes a recipient as it is", () => {
    like(parsePaymentLink("someBase58Address"), { form: "raw", kind: "unknown", raw: "someBase58Address", to: "someBase58Address" });
    like(parsePaymentLink(`  ${A}\n`), { form: "raw", kind: "unknown", to: A });
  });

  it("reads nothing as nothing, and no other dusk: link", () => {
    assert.equal(parsePaymentLink(""), null);
    assert.equal(parsePaymentLink(null), null);
    assert.equal(parsePaymentLink("dusk:invalid-format"), null);
    assert.equal(parsePaymentLink("dusk:"), null);
    assert.equal(parsePaymentLink("dusk:public-"), null);
  });

  it("reads the scheme and the kind in any case, and with // after the scheme", () => {
    like(parsePaymentLink("DUSK:public-abc123"), { kind: "public", to: "abc123" });
    like(parsePaymentLink("dusk:PUBLIC-abc123"), { kind: "public", to: "abc123" });
    like(parsePaymentLink("dusk://public-abc123"), { to: "abc123" });
  });

  it("decodes a recipient, and keeps one that isn't encoded as it is", () => {
    like(parsePaymentLink("dusk:public-abc%2Fdef"), { to: "abc/def" });
    like(parsePaymentLink("dusk:public-%E0%A4"), { kind: "public", to: "%E0%A4" });
  });

  it("reads a plain dusk:<address> link, Sofia's, by its address alone: an account or a shielded address, as written", () => {
    like(parsePaymentLink(`dusk:${A}?amount=0.03&memo=Invoice%202026-114`), { amountDusk: "0.03", chainId: "", form: "dusk", kind: "public", lux: 30_000_000n, memo: "Invoice 2026-114", to: A });
    like(parsePaymentLink(`dusk://${A}?amount=0,01`), { amountDusk: "0,01", kind: "public", to: A });
    like(parsePaymentLink(`dusk:${SHIELDED}`), { kind: "shielded", to: SHIELDED });
    // Its network as the other shape's.
    like(parsePaymentLink(`dusk:${A}?amount=0.03&network=testnet`), { chainId: "dusk:2", to: A });
    like(parsePaymentLink(`dusk:${A}@dusk:1`), { chainId: "dusk:1", to: A });
    assert.equal(parsePaymentLink(`dusk:${A}@dusk:1?network=testnet`), null);
    // Nothing else is read as an address: no guessing at what a link means.
    for (const other of [`dusk:send?to=${A}`, `dusk:public:${A}`, `dusk:pay?to=${A}&amount=1`, "dusk:test", `dusk:${A}x`, `dusk:${encodeURIComponent(` ${A}`)}`]) {
      assert.equal(parsePaymentLink(other), null, other);
    }
  });
});

describe("a link to the web wallet's Send", () => {
  it("is on each network's own wallet, and says which network it's for", () => {
    for (const [name, chain] of /** @type {const} */ ([["mainnet", 1], ["testnet", 2], ["devnet", 3]])) {
      const { https } = makePaymentLink({ amount: "1.5", memo: "Factura 33", network: chain, to: A, language: "en-GB" });

      assert.equal(https, `${networks[name].apps.wallet}/dashboard/send?to=${A}&amount=1.5&memo=Factura+33&network=${name}`);
    }
  });

  it("reads as what it was made from, by the same function as a dusk: link", () => {
    const made = makePaymentLink({ amount: "0,15", label: "Estudio", memo: "Factura 33", network: 1, to: A, language: "es-ES" });
    const expected = { amountDusk: "0.15", chainId: "dusk:1", kind: "public", label: "Estudio", lux: 150_000_000n, memo: "Factura 33", to: A };

    like(parsePaymentLink(made.https), { ...expected, form: "https" });
    like(parsePaymentLink(made.dusk), { ...expected, form: "dusk" });
    // It fills the payer's amount field, in the payer's language.
    assert.equal(amountForField(/** @type {any} */ (parsePaymentLink(made.https)).amountDusk, ","), "0,15");
    assert.equal(parseDusk(normalizeAmount("0,15", ",")), 150_000_000n);
  });

  it("carries a memo through email and chat, whatever's on its line", () => {
    for (const memo of ["Factura 33, \"abril\" & mayo", "a+b=c?d#e%f", "Línea 1 · Línea 2", "€ 12,50 🧾", "ends with a dot.", "gnp.exe \u202E"]) {
      const made = makePaymentLink({ memo, network: 1, to: A });
      const link = /** @type {string} */ (made.https);

      // One unbroken link, which no mail or chat client ends early.
      assert.doesNotMatch(link, /[\s"<>]/, memo);
      assert.match(link, /&network=mainnet$/, memo);
      assert.equal(/** @type {any} */ (parsePaymentLink(link)).memo, memo.trim(), memo);
      assert.equal(/** @type {any} */ (parsePaymentLink(made.dusk)).memo, memo.trim(), memo);
    }
  });

  it("reads a link whose network its wallet's address says, and refuses one saying two", () => {
    const wallet = networks.testnet.apps.wallet;

    like(parsePaymentLink(`${wallet}/dashboard/send?to=${A}`), { chainId: "dusk:2", form: "https", kind: "public", to: A });
    like(parsePaymentLink(`${wallet}/dashboard/send/?to=${A}&network=testnet`), { chainId: "dusk:2" });
    like(parsePaymentLink(`HTTPS://APPS.TESTNET.DUSK.NETWORK/wallet/dashboard/send?to=${A}`), { chainId: "dusk:2", form: "https" });
    assert.equal(parsePaymentLink(`${wallet}/dashboard/send?to=${A}&network=mainnet`), null);
    assert.equal(parsePaymentLink(`${wallet}/dashboard/send?to=${A}&network=dusk:1`), null);
    assert.equal(parsePaymentLink(`${wallet}/dashboard/send?to=${A}&network=nowhere`), null);
    assert.equal(parsePaymentLink(`${wallet}/dashboard/send?amount=1`), null);
  });

  it("reads no one else's page as one: it stays a recipient, which Send refuses", () => {
    for (const elsewhere of [
      `https://evil.example/wallet/dashboard/send?to=${A}&amount=1`,
      `https://apps.dusk.network.evil.example/wallet/dashboard/send?to=${A}&amount=1`,
      `https://apps.dusk.network@evil.example/wallet/dashboard/send?to=${A}&amount=1`,
      `https://apps.dusk.network/elsewhere?to=${A}&amount=1`,
      `http://apps.dusk.network/wallet/dashboard/send?to=${A}&amount=1`,
    ]) {
      like(parsePaymentLink(elsewhere), { form: "raw", kind: "unknown", lux: null, memo: "", to: elsewhere }, elsewhere);
      assert.ok(makePaymentLink({ to: elsewhere }).problems.to, elsewhere);
    }
  });

  it("reads the app's own address where it's told it, and makes a link for it", () => {
    const walletUrl = "http://localhost:5173/";
    const made = makePaymentLink({ amount: "2", language: "en-GB", network: "testnet", to: A, walletUrl });

    assert.equal(made.https, `http://localhost:5173/dashboard/send?to=${A}&amount=2&network=testnet`);
    like(parsePaymentLink(made.https, { walletUrl }), { chainId: "dusk:2", form: "https", lux: 2_000_000_000n, to: A });
    assert.equal(/** @type {any} */ (parsePaymentLink(made.https)).form, "raw");
  });

  it("has no https link without a wallet to open or a network to name, though a dusk: link is made", () => {
    const local = makePaymentLink({ network: "dusk:0", to: A });

    assert.equal(local.https, null);
    assert.equal(local.dusk, `dusk:public-${A}@dusk:0`);
    assert.equal(makePaymentLink({ to: A, walletUrl: "https://wallet.example" }).https, null);
    like(makePaymentLink({ to: A }), { dusk: `dusk:public-${A}`, https: null, ok: true });
    // A custom node's chain, with the wallet's address given, is named as it is.
    const custom = makePaymentLink({ network: "dusk:3735928559", to: A, walletUrl: "https://wallet.example" });

    assert.equal(custom.https, `https://wallet.example/dashboard/send?to=${A}&network=dusk%3A3735928559`);
    like(parsePaymentLink(custom.https, { walletUrl: "https://wallet.example" }), { chainId: "dusk:3735928559", form: "https" });
  });
});

describe("a link as Send reads it, pasted, scanned or opened", () => {
  const testnetSend = `${networks.testnet.apps.wallet}/dashboard/send`;
  const mainnetSend = `${networks.mainnet.apps.wallet}/dashboard/send`;

  it("says at once that a request is for another network, the same as a QR code's dusk: link as pasted", () => {
    // Nandini's and Chen's: a mainnet request, on testnet.
    const made = makePaymentLink({ amount: "0.0013", language: "en-GB", memo: "Order 1044", network: 1, to: A });
    const refused = { chainId: "dusk:1", link: null, network: "Mainnet", problem: "This request is for Mainnet. You are on Testnet.", reason: "other-network" };

    assert.deepEqual(readPaymentLink(made.https, { network: 2 }), refused);
    assert.deepEqual(readPaymentLink(made.dusk, { network: "testnet" }), refused);
  });

  it("fills in a request for the wallet's network, and says which that is", () => {
    const made = makePaymentLink({ amount: "0.0013", language: "en-GB", memo: "Order 1044", network: 2, to: A });
    const read = /** @type {any} */ (readPaymentLink(made.https, { network: networks.testnet }));

    like(read, { chainId: "dusk:2", network: "Testnet", problem: "", reason: "" });
    assert.deepEqual(read.link, parsePaymentLink(made.https));
    like(readPaymentLink(made.dusk, { network: 2 })?.link, { amountDusk: "0.0013", form: "dusk", memo: "Order 1044", to: A });
    // A dusk: link that names no network fills in on any.
    like(readPaymentLink(`dusk:public-${A}?amount=1`, { network: 1 }), { chainId: "", network: "", reason: "" });
  });

  it("refuses a link that says a field twice, saying which: it could be read two ways", () => {
    // Marek's, and Sofia's: the same amount twice, and the memo twice.
    for (const [twice, what] of [
      [`to=${A}&amount=0.001&network=testnet&network=mainnet`, "the network"],
      [`to=${A}&to=${B}&amount=0.001`, "the recipient"],
      [`to=${A}&memo=One&memo=Two`, "the memo"],
      [`to=${A}&label=A&label=B`, "the label"],
      [`to=${A}&amount=0.001&amount=0.001`, "the amount"],
      [`to=${A}&amountLux=1000000&amountLux=1000000`, "the amount"],
    ]) {
      const link = `${testnetSend}?${twice}`;

      assert.equal(parsePaymentLink(link), null, twice);
      like(readPaymentLink(link, { network: 2 }), { link: null, problem: `This link says ${what} twice. Ask for a new one.`, reason: "unreadable" }, twice);
    }

    assert.equal(parsePaymentLink(`dusk:public-${A}?memo=One&memo=Two`), null);
    like(readPaymentLink(`dusk:public-${A}?memo=One&memo=Two`, { network: 2 }), { problem: "This link says the memo twice. Ask for a new one.", reason: "unreadable" });
  });

  it("refuses a field said twice in two cases, in every shape: Marek's To= beside to=, and Amount= beside amount=", () => {
    // Each was filled in with the field in its own case, the other dropped without a word: a reader that
    // ignores case would have paid the other recipient, or 0.15.
    for (const [twice, problem] of [
      [`To=${B}&to=${A}&amount=0.001`, "This link says the recipient twice. Ask for a new one."],
      [`to=${A}&TO=${B}`, "This link says the recipient twice. Ask for a new one."],
      [`to=${A}&amount=0.001&Amount=0.15`, LINK_TWO_AMOUNTS],
      [`to=${A}&amount=0.001&amountlux=150000000`, LINK_TWO_AMOUNTS],
      [`to=${A}&amount=0.001&AMOUNT=0.001`, "This link says the amount twice. Ask for a new one."],
      [`to=${A}&memo=One&Memo=One`, "This link says the memo twice. Ask for a new one."],
      [`to=${A}&label=A&LABEL=B`, "This link says the label twice. Ask for a new one."],
      // A Kelvin sign is a K in lower case, as any reader that ignores case reads it.
      [`to=${A}&network=testnet&NETWOR%E2%84%AA=mainnet`, "This link says the network twice. Ask for a new one."],
    ]) {
      const link = `${testnetSend}?${twice}`;
      const reason = problem === LINK_TWO_AMOUNTS ? "two-amounts" : "unreadable";

      if (reason === "unreadable") assert.equal(parsePaymentLink(link), null, twice);
      like(readPaymentLink(link, { network: 2 }), { link: null, problem, reason }, twice);
    }

    for (const [link, problem] of [
      [`dusk:public-${A}?To=${B}`, "This link says the recipient twice. Ask for a new one."],
      [`dusk:${A}?amount=0.001&Amount=0.15`, LINK_TWO_AMOUNTS],
      [`dusk:${A}?amount=0.001&AMOUNTLUX=150000000`, LINK_TWO_AMOUNTS],
      [`dusk:shielded-${SHIELDED}?memo=One&MEMO=Two`, "This link says the memo twice. Ask for a new one."],
      [`dusk://public-${A}@dusk:2?network=testnet&Network=testnet`, "This link says the network twice. Ask for a new one."],
    ]) {
      like(readPaymentLink(link, { network: 2 }), { link: null, problem }, link);
    }

    // Said once, in any case, it's that field: nothing a link says is dropped.
    like(readPaymentLink(`${testnetSend}?To=${A}&Amount=0.15&MEMO=Factura+33`, { network: 2 })?.link, { amountDusk: "0.15", lux: 150_000_000n, memo: "Factura 33", to: A });
    like(readPaymentLink(`dusk:${A}?AmountLux=1500000000&Network=testnet`, { network: 2 })?.link, { chainId: "dusk:2", lux: 1_500_000_000n });
    like(readPaymentLink(`${testnetSend}?to=${A}&Network=mainnet`, { network: 2 }), { link: null, problem: "This link names two networks, Testnet and Mainnet. Ask for a new one." });
  });

  it("refuses a link whose recipient is no address, as the web wallet does: a second address in it, a line break, a hidden character", () => {
    // Marek's: the extension filled these into To, under "Filled in from the link", one backspace from paying.
    const badAddress = { link: null, problem: "This link's address isn't valid. Ask for a new one.", reason: "unreadable" };

    for (const to of [
      `${A},${B}`,
      `${A}%2C${B}`,
      `${A}%20${B}`,
      `${A}+${B}`,
      `${A};${B}`,
      `${A}%00`,
      `${A.slice(0, 40)}%0A${A.slice(40)}`,
      `${A.slice(0, 40)}%0D${A.slice(40)}`,
      `${A.slice(0, 40)}%E2%80%AE${A.slice(40)}`,
      `${A}%E2%80%8B`,
      `${A}%EF%B8%8F`,
      A.slice(0, -6),
      "1".repeat(96),
      "Wendy",
      "ali%E2%80%8Bce.dusk",
      "alice.dusk%0Abob.dusk",
    ]) {
      const link = `${testnetSend}?to=${to}&amount=0.001&network=testnet`;

      like(readPaymentLink(link, { network: 2 }), { ...badAddress, chainId: "dusk:2" }, to);
      // On any network: what can't be paid anywhere says so before which network it's for.
      like(readPaymentLink(link, { network: 1 }), badAddress, to);
      like(readPaymentLink(link), badAddress, to);
    }

    like(readPaymentLink(`dusk:public-${A}%2C${B}?amount=0.001`, { network: 2 }), badAddress);
    like(readPaymentLink(`dusk:shielded-${SHIELDED}%E2%80%8B`, { network: 2 }), badAddress);

    // What Send takes, or says more of: an account, a shielded address, a .dusk name and an EVM address; the
    // ends' spaces and line breaks aren't the address's.
    for (const to of [A, SHIELDED, "alice.dusk", "Shop-2.Alice.dusk", "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F", `%0A${A}%20`]) {
      like(readPaymentLink(`${testnetSend}?to=${to}&amount=0.001`, { network: 2 }), { problem: "", reason: "" }, to);
    }

    // Read as a link, its form alone, it still is one: Send's reading is the one that refuses.
    like(parsePaymentLink(`${testnetSend}?to=${A},${B}`), { form: "https", to: `${A},${B}` });
  });

  it("refuses an amount that isn't a plain number once decoded: Marek's %23 and hidden characters, and anything else", () => {
    // Marek's: '%23' inside amount= filled Amount with '0.001#to=…', a whole other address; a zero-width space
    // in it made the page say 'Any amount' and the extension show '0.01' with a generic error.
    const badAmount = { link: null, problem: "This link's amount can't be read. Ask for a new one.", reason: "unreadable" };

    for (const amount of ["0.001%23to=" + B, "0.001%23", "0.0%E2%80%8B1", "0.01%E2%80%8B", "%E2%80%8F0.01", "0.01%00", "0.01%20", "%200.01", "0.01+", "0.01%0A", "0.01%EF%BB%BF", "1%C2%A0000", "1e3", "-1", "0x10", "1.2.3", "0,0,1", "١٢", "abc", ".", ","]) {
      for (const link of [`${testnetSend}?to=${A}&amount=${amount}&network=testnet`, `dusk:public-${A}@dusk:2?amount=${amount}`, `dusk:${A}?amount=${amount}`]) {
        like(readPaymentLink(link, { network: 2 }), badAmount, link);
      }
    }

    for (const amountLux of ["10000000%E2%80%8B", "1.5", "%2010000000", "1e7"]) {
      like(readPaymentLink(`${testnetSend}?to=${A}&amountLux=${amountLux}`, { network: 2 }), badAmount, amountLux);
    }

    // What a link writes, or a person: digits with one point or comma, and no amount at all, for Send to read as it reads a typed one.
    for (const amount of ["0.001", "0,01", "1,000", "1.000", ".5", "5.", "12", ""]) {
      like(readPaymentLink(`${testnetSend}?to=${A}&amount=${amount}`, { network: 2 }), { problem: "", reason: "" }, amount);
      like(readPaymentLink(`dusk:${A}?amount=${amount}`, { network: 2 })?.link, { amountDusk: amount, to: A }, amount);
    }
  });

  it("refuses a link whose field names hide something, or read as a field they aren't, rather than dropping them", () => {
    // Marek's: am‏ount=0.15 beside amount=0.001 filled in 0.001; a person reading the link sees both.
    for (const query of [
      `to=${B}&am%E2%80%8Fount=0.15&amount=0.001`,
      `to=${B}&amount%00=0.15&amount=0.001`,
      `to%20=${A}&to=${B}`,
      `%20to=${A}&to=${B}`,
      `+to=${A}&to=${B}`,
      `to=${B}&amount=0.001&memo%E2%80%8B=Order%201`,
      `to=${B}&am%E2%80%8Bount=0.15`,
      // Fullwidth ｔｏ, and a Cyrillic а in amount: they read as fields, and no reader reads them so.
      `to=${B}&%EF%BD%94%EF%BD%8F=${A}`,
      `to=${B}&%D0%B0mount=0.15&amount=0.001`,
      `to=${B}&net%E2%80%8Bwork=mainnet`,
      `to=${B}&ref%E2%80%8B=x`,
      `to=${B}&utm%20source=x`,
      // The review's: small capitals and Cyrillic letters Unicode's table takes for other small capitals, and marks
      // on a field's name, none of them ASCII as every field's name is.
      `to=${A}&${encodeURIComponent("ᴛo")}=${B}&amount=0.001`,
      `to=${A}&${encodeURIComponent("тo")}=${B}&amount=0.001`,
      `to=${A}&${encodeURIComponent("ᴀmount")}=5&amount=0.001`,
      `to=${A}&amount=1000&${encodeURIComponent("ɴetwork")}=mainnet`,
      `to=${A}&${encodeURIComponent("meмo")}=x`,
      `to=${A}&amount%CC%85=5&amount=0.001`,
      `to=${A}&amount%E2%81%84=5`,
      `to=${A}&caf%C3%A9=1`,
      // And names in ASCII that look like a field's: a capital I for the l of amountLux or label, rn, vv, a zero.
      `to=${A}&amount=5&amountIux=1000000`,
      `to=${A}&Iabel=Alice&amount=0.001`,
      `to=${A}&arnount=5&amount=0.001`,
      `to=${A}&amount=1000&netvvork=mainnet`,
      `to=${A}&t0=${B}`,
      `to=${A}&memo_=x`,
    ]) {
      const https = `${testnetSend}?${query}`;

      assert.equal(parsePaymentLink(https), null, query);
      like(readPaymentLink(https, { network: 2 }), { link: null, problem: LINK_UNREADABLE, reason: "unreadable" }, query);
    }

    like(readPaymentLink(`dusk:public-${A}@dusk:2?am%E2%80%8Fount=0.15&amount=0.001`, { network: 2 }), { link: null, problem: LINK_UNREADABLE, reason: "unreadable" });
    like(readPaymentLink(`dusk:${A}?%EF%BD%8D%EF%BD%85%EF%BD%8D%EF%BD%8F=x`, { network: 2 }), { link: null, problem: LINK_UNREADABLE, reason: "unreadable" });
    like(readPaymentLink(`dusk:${A}?amount=5&amountIux=1000000`, { network: 2 }), { link: null, problem: LINK_UNREADABLE, reason: "unreadable" });

    // The review's: on mainnet's wallet, a network= in other letters would have filled 1000 DUSK on Mainnet; named as written, it's two networks.
    const mainnetSend = `${networks.mainnet.apps.wallet.replace(/\/+$/, "")}/dashboard/send`;

    like(readPaymentLink(`${mainnetSend}?to=${A}&amount=1000&${encodeURIComponent("ɴetwork")}=testnet`, { network: 1 }), { link: null, problem: LINK_UNREADABLE });
    like(readPaymentLink(`${mainnetSend}?to=${A}&amount=1000&network=testnet`, { network: 1 }), { link: null, problem: "This link names two networks, Mainnet and Testnet. Ask for a new one." });

    // Other fields than a link's are the browser's or a sender's: left out, as before. A field in another case is that field.
    like(readPaymentLink(`${testnetSend}?to=${A}&amount=0.001&utm_source=chat&ref=abc&fbclid=x1&=5&%25=1`, { network: 2 })?.link, { amountDusk: "0.001", to: A });
    like(readPaymentLink(`${testnetSend}?to=${A}&AMOUNT=0.001&Memo=x&LABEL=Shop&amountlux=1000000`, { network: 2 })?.link, { amountDusk: "0.001", amountLux: "1000000", label: "Shop", memo: "x", to: A });
  });

  it("refuses a link whose memo has a line break, as both wallets read it alike, and makes none", () => {
    // Marek's: the web wallet filled in 'line one\nline two', the extension refused it.
    const lineBreak = { link: null, problem: "This link's memo has a line break. Ask for a new one.", reason: "unreadable" };

    for (const memo of ["line%20one%0Aline%20two", "a%0Db", "a%0D%0Ab", "a%E2%80%A8b", "a%E2%80%A9b", "a%C2%85b", "a%0Bb", "a%0Cb"]) {
      like(readPaymentLink(`${testnetSend}?to=${A}&amount=0.001&memo=${memo}`, { network: 2 }), { ...lineBreak, chainId: "dusk:2" }, memo);
      like(readPaymentLink(`dusk:${A}?amount=0.001&memo=${memo}`, { network: 2 }), lineBreak, memo);
    }

    // Spaces and line breaks at its ends aren't the memo's, as a field's aren't.
    like(readPaymentLink(`${testnetSend}?to=${A}&memo=Order%201%0A`, { network: 2 })?.link, { memo: "Order 1" });
    // And a request's memo goes on one line.
    assert.deepEqual(makePaymentLink({ memo: "line one\nline two", network: 2, to: A }).problems, { memo: "Write the memo on one line." });
    assert.equal(makePaymentLink({ memo: "line one\u2028line two", network: 2, to: A }).https, null);
  });

  it("gives nothing of a refused link to fill in or show: no recipient, no amount, only why and its network", () => {
    // Marek's: the locked 'Payment request' preview of a refused link showed a To made of two addresses.
    for (const link of [`${testnetSend}?to=${B},${A}&amount=0.001&network=testnet`, `${testnetSend}?to=${A}&amount=0.0%E2%80%8B1&network=testnet`, `${testnetSend}?to=${A}&am%E2%80%8Fount=0.15&amount=0.001&network=testnet`, `${testnetSend}?to=${A}&amount=0.001&memo=a%0Ab&network=testnet`]) {
      const read = /** @type {any} */ (readPaymentLink(link, { network: 2 }));

      assert.equal(read.link, null, link);
      assert.notEqual(read.problem, "", link);
      assert.deepEqual(Object.keys(read).sort(), ["chainId", "link", "network", "problem", "reason"], link);
    }
  });

  it("reads a link's amount as Send does, for a preview to say the same: Marek's 1.000 asks, never 1 DUSK", () => {
    // Marek's: the locked 'Payment request' card said '1 DUSK' and '10 DUSK' while Send asked which was meant.
    for (const [amount, problem] of [
      ["1.000", "Is that 1 or 1000? Write the one you mean."],
      ["10.000", "Is that 10 or 10000? Write the one you mean."],
      ["1,000", "Is that 1 or 1000? Write the one you mean."],
    ]) {
      const link = /** @type {any} */ (readPaymentLink(`${testnetSend}?to=${A}&amount=${amount}&network=testnet`, { network: 2 })).link;

      // The link's own lux is a plain number's, 1 DUSK of "1.000": not what Send reads.
      assert.equal(link.lux, parseDusk(amount));
      assert.deepEqual(said(linkAmount(link, "en-GB")), { field: amount, lux: null, problem }, amount);
    }

    // In Polish, where 1.000 is a thousand: the field has the language's mark, and asks the same.
    const polish = /** @type {any} */ (readPaymentLink(`${testnetSend}?to=${A}&amount=1.000&network=testnet`, { network: 2 })).link;

    assert.deepEqual(said(linkAmount(polish, "pl-PL")), { field: "1,000", lux: null, problem: "Is that 1 or 1000? Write the one you mean." });
  });

  it("reads a link's amount as typing reads it: Chen's and Nandini's 2.125 asks as typed 2.125 does, with the two to choose from", () => {
    /** @param {string} query */
    const linkOf = (query) => /** @type {any} */ (readPaymentLink(`${testnetSend}?to=${A}${query}&network=testnet`, { network: 2 })).link;
    const choices = [
      { field: "2.1250", lux: 2_125_000_000n },
      { field: "2125", lux: 2_125_000_000_000n },
    ];

    // Chen's: the link's 2.125 was filled in as 2.1250 without a word, while typing 2.125 asked.
    assert.deepEqual(linkAmount(linkOf("&amount=2.125"), "en-SG"), { field: "2.125", ...readAmount("2.125", "en-SG") });
    assert.deepEqual(linkAmount(linkOf("&amount=2.125"), "en-SG"), { choices, field: "2.125", lux: null, problem: "Is that 2.1250 or 2125? Write the one you mean.", question: "Is that 2.1250 or 2125?" });
    assert.deepEqual(linkAmount(linkOf("&amount=2.125"), "de-DE").choices, [{ field: "2,1250", lux: 2_125_000_000n }, choices[1]]);

    // A link a wallet makes for 2.125 DUSK, as Request reads it once the question's first choice fills its field, says
    // 2.1250, which reads as that amount without a question, in every language.
    const typed = /** @type {NonNullable<ReturnType<typeof readAmount>["choices"]>} */ (readAmount("2,125", "de-DE").choices)[0].field;
    const made = makePaymentLink({ amount: typed, language: "de-DE", network: 2, to: A });

    assert.equal(typed, "2,1250");
    assert.deepEqual(makePaymentLink({ amountLux: 2_125_000_000n, network: 2, to: A }), made);

    assert.match(String(made.https), /&amount=2\.1250&/);
    assert.match(made.dusk, /\?amount=2\.1250$/);

    for (const language of ["en-GB", "de-DE", "fr-FR", "pl-PL"]) {
      for (const link of [made.https, made.dusk]) assert.deepEqual(said(linkAmount(/** @type {any} */ (readPaymentLink(link, { network: 2 })).link, language)).lux, 2_125_000_000n, `${language}: ${link}`);
    }

    // So does one in lux, which is exact.
    assert.deepEqual(linkAmount(linkOf("&amountLux=2125000000"), "en-GB"), { field: "2.1250", lux: 2_125_000_000n, problem: null });
    // A link's amount and the one typed are read alike: none asks that the other doesn't.
    for (const amount of ["0.5", "1.25", "1.2345", "1234.567", "1.000", "12.050", "0,5", "2,125"]) {
      const { field, ...read } = linkAmount(linkOf(`&amount=${encodeURIComponent(amount)}`), "en-GB");

      assert.deepEqual(read, readAmount(amount, "en-GB"), amount);
      assert.equal(field, amount, amount);
    }
  });

  it("gives the amount Send fills in and reads, in the person's language, and any amount for none", () => {
    /** @param {string} query */
    const linkOf = (query) => /** @type {any} */ (readPaymentLink(`${testnetSend}?to=${A}${query}&network=testnet`, { network: 2 })).link;

    // As a wallet writes 2.125 DUSK: Send fills it in so it reads back as it is, without a question.
    assert.deepEqual(linkAmount(linkOf("&amount=2.1250"), "en-GB"), { field: "2.1250", lux: 2_125_000_000n, problem: null });
    assert.deepEqual(linkAmount(linkOf("&amount=2.1250"), "de-DE"), { field: "2,1250", lux: 2_125_000_000n, problem: null });
    assert.deepEqual(linkAmount(linkOf("&amount=0.15"), "es-ES"), { field: "0,15", lux: 150_000_000n, problem: null });
    assert.deepEqual(linkAmount(linkOf("&amountLux=1000000000"), "en-GB"), { field: "1", lux: 1_000_000_000n, problem: null });
    // What Send won't take, it says: as the field would.
    assert.deepEqual(linkAmount(linkOf("&amount=0"), "en-GB"), { field: "0", lux: null, problem: "Enter an amount greater than 0." });
    // No amount asked: any.
    assert.deepEqual(linkAmount(linkOf(""), "en-GB"), { field: "", lux: null, problem: null });
    assert.deepEqual(linkAmount(null, "en-GB"), { field: "", lux: null, problem: null });
    // The language's mark, as each wallet fills a field.
    assert.equal(linkAmount(linkOf("&amount=1.5"), "fr-FR").field, amountForField("1.5", decimalSeparator("fr-FR")));
  });

  it("refuses a dusk: link that asks for a shielded payment to a public account, or a public one to a shielded address", () => {
    // Marek's: dusk:shielded- with his public account filled in a public send, without a word of what it asked.
    like(readPaymentLink(`dusk:shielded-${A}?amount=0.001`, { network: 2 }), {
      link: null,
      problem: "This link asks for a shielded payment to a public account. Ask for a new one.",
      reason: "unreadable",
    });
    like(readPaymentLink(`dusk:public-${SHIELDED}@dusk:2?amount=0.001`, { network: 2 }), {
      link: null,
      problem: "This link asks for a public payment to a shielded address. Ask for a new one.",
      reason: "unreadable",
    });
    assert.equal(parsePaymentLink(`dusk:shielded-${A}`), null);
    assert.equal(parsePaymentLink(`DUSK:SHIELDED-${A}`), null);
    // Each to its own kind, as it asks.
    like(readPaymentLink(`dusk:shielded-${SHIELDED}?amount=0.001`, { network: 2 })?.link, { kind: "shielded", to: SHIELDED });
    like(readPaymentLink(`dusk:public-${A}?amount=0.001`, { network: 2 })?.link, { kind: "public", to: A });
  });

  it("refuses a dusk: link with a # in it, rather than reading what follows it into a field", () => {
    // Marek's: a second recipient after the # landed in Amount.
    for (const link of [`dusk:${A}?amount=0.001#to=${B}`, `dusk:public-${A}?amount=0.001#`, `dusk:public-${A}#amount=5`, `dusk:${A}?amount=0.001#&amount=0.15`, `dusk:public-${A}@dusk:2#x`]) {
      assert.equal(parsePaymentLink(link), null, link);
      like(readPaymentLink(link, { network: 2 }), { link: null, problem: LINK_UNREADABLE, reason: "unreadable" }, link);
    }

    // An https link's fragment is the browser's, as the page it opens leaves it out: never read into a field.
    like(readPaymentLink(`${testnetSend}?to=${A}&amount=0.001#to=${B}`, { network: 2 })?.link, { amountDusk: "0.001", to: A });
    like(readPaymentLink(`dusk:${A}?amount=0.001&memo=Order%20%2312`, { network: 2 })?.link, { amountDusk: "0.001", memo: "Order #12" });
  });

  it("refuses a dusk: link that names a recipient in its query too, as an https link naming two", () => {
    // Marek's: it filled in the first and dropped the other without a word.
    for (const link of [`dusk:public-${A}?to=${B}&amount=0.001`, `dusk:${A}?to=${B}&amount=0.001`, `dusk:public-${A}?to=${A}`, `dusk:public-${A}@dusk:2?amount=0.001&to=`]) {
      assert.equal(parsePaymentLink(link), null, link);
      like(readPaymentLink(link, { network: 2 }), { link: null, problem: "This link says the recipient twice. Ask for a new one.", reason: "unreadable" }, link);
    }
  });

  it("refuses a dusk: link for another network than the wallet's by its query too, as an https link", () => {
    // Marek's: a link that says testnet filled in a mainnet send, and one that says mainnet a testnet send.
    like(readPaymentLink(`dusk:public-${A}?amount=0.001&network=testnet`, { network: 1 }), {
      chainId: "dusk:2",
      link: null,
      network: "Testnet",
      problem: "This request is for Testnet. You are on Mainnet.",
      reason: "other-network",
    });
    like(readPaymentLink(`dusk:public-${A}?amount=0.001&network=mainnet`, { network: 2 }), { problem: "This request is for Mainnet. You are on Testnet.", reason: "other-network" });
    like(readPaymentLink(`dusk:public-${A}?amount=0.001&network=testnet`, { network: 2 })?.link, { amountDusk: "0.001", chainId: "dusk:2", to: A });
    like(readPaymentLink(`dusk:public-${A}@dusk:1?amount=0.001&network=testnet`, { network: 2 }), {
      link: null,
      problem: "This link names two networks, Mainnet and Testnet. Ask for a new one.",
      reason: "unreadable",
    });
  });

  it("says why it refuses a link whose network can't be read, or that says nobody to pay", () => {
    const unknown = { link: null, problem: "This link's network can't be read. Ask for a new one.", reason: "unreadable" };

    like(readPaymentLink(`${testnetSend}?to=${A}&network=nowhere`, { network: 2 }), unknown);
    like(readPaymentLink(`dusk:public-${A}?network=nowhere`, { network: 2 }), unknown);
    like(readPaymentLink(`dusk:public-${A}@dusk:abc`, { network: 2 }), unknown);
    // Marek's: a chain's number with a zero before it is no network's, not "Testnet and Testnet".
    for (const link of [`${testnetSend}?to=${A}&amount=0.001&network=dusk:02`, `dusk:public-${A}?network=dusk:02`, `dusk:${A}?network=02`, `dusk:public-${A}@dusk:02`]) {
      like(readPaymentLink(link, { network: 2 }), unknown, link);
    }
    like(readPaymentLink(`${testnetSend}?amount=1`, { network: 2 }), { link: null, problem: "This link doesn't say who to pay. Ask for a new one.", reason: "unreadable" });
  });

  it("says amounts that differ, in DUSK and in lux or one of them twice, as two amounts", () => {
    for (const amounts of ["amount=0.001&amount=0.15", "amount=1&amountLux=1500000000", "amountLux=1&amountLux=2"]) {
      like(readPaymentLink(`${testnetSend}?to=${A}&${amounts}`, { network: 2 }), { link: null, problem: LINK_TWO_AMOUNTS, reason: "two-amounts" }, amounts);
      like(readPaymentLink(`dusk:public-${A}@dusk:2?${amounts}`, { network: 2 }), { reason: "two-amounts" }, amounts);
    }

    // The same amount, in DUSK and in lux, is one.
    like(readPaymentLink(`${testnetSend}?to=${A}&amount=1.5&amountLux=1500000000`, { network: 2 })?.link, { lux: 1_500_000_000n });
  });

  it("refuses a user part before the host, which makes a mainnet link read as testnet's", () => {
    // Marek's: it goes to mainnet's wallet.
    const disguised = `https://apps.testnet.dusk.network@apps.dusk.network/wallet/dashboard/send?to=${A}&amount=0.001`;

    assert.equal(parsePaymentLink(disguised), null);
    // Sofia's: it says what's wrong, for whoever sent it to fix.
    like(readPaymentLink(disguised, { network: 1 }), { chainId: "", link: null, problem: "This link has something before the site's address. Ask for a new one.", reason: "unreadable" });
    assert.equal(parsePaymentLink(`https://user:pass@apps.dusk.network/wallet/dashboard/send?to=${A}`), null);
    assert.equal(parsePaymentLink(`${mainnetSend}?to=${A}`)?.form, "https");
  });

  it("refuses a testnet link that says mainnet, rather than filling in nothing without a word", () => {
    // Marek's.
    like(readPaymentLink(`${testnetSend}?to=${A}&amount=0.001&network=mainnet`, { network: 2 }), {
      link: null,
      problem: "This link names two networks, Testnet and Mainnet. Ask for a new one.",
      reason: "unreadable",
    });
  });

  it("is nothing for what isn't a link, which Send reads as a recipient", () => {
    for (const text of ["", "  ", A, "name.dusk", `https://evil.example/wallet/dashboard/send?to=${A}`, `https://apps.dusk.network@evil.example/wallet/dashboard/send?to=${A}`]) {
      assert.equal(readPaymentLink(text, { network: 1 }), null, text);
    }

    like(readPaymentLink("dusk:invalid", { network: 1 }), { problem: LINK_UNREADABLE, reason: "unreadable" });
  });
});

describe("a request a payer can use", () => {
  it("is made for a recipient alone, and for a shielded one with its own kind", () => {
    like(makePaymentLink({ network: 2, to: A }), { lux: null, ok: true, problems: {} });
    like(makePaymentLink({ network: 2, to: SHIELDED }), { dusk: `dusk:shielded-${SHIELDED}@dusk:2`, ok: true });
    like(parsePaymentLink(makePaymentLink({ network: 2, to: SHIELDED }).https), { kind: "shielded", to: SHIELDED });
    assert.equal(recipientKind(A), "public");
    assert.equal(recipientKind(SHIELDED), "shielded");
    assert.equal(recipientKind("name.dusk"), "unknown");
  });

  it("refuses an amount of 0, as Send would when the payer gets there", () => {
    for (const amount of ["0", "0.0", "0,000"]) {
      like(makePaymentLink({ amount, language: "en-GB", network: 1, to: A }), { dusk: "", https: null, ok: false, problems: { amount: "Enter an amount greater than 0." } });
    }
    for (const amountLux of [0n, 0, "0", "abc", -1n]) {
      assert.equal(makePaymentLink({ amountLux, network: 1, to: A }).problems.amount, "Enter an amount greater than 0.", String(amountLux));
    }
  });

  it("says 1.234 is unclear, not that it has too many decimals", () => {
    assert.equal(makePaymentLink({ amount: "1.234", language: "es-ES", network: 1, to: A }).problems.amount, "Is that 1,2340 or 1234? Write the one you mean.");
    assert.equal(makePaymentLink({ amount: "abc", language: "es-ES", network: 1, to: A }).problems.amount, "Enter an amount such as 10 or 10,5.");
    // In English too: a point before three digits could be a thousands' group.
    assert.equal(makePaymentLink({ amount: "1.234", language: "en-GB", network: 1, to: A }).problems.amount, "Is that 1.2340 or 1234? Write the one you mean.");
    // And reads what each language writes.
    assert.equal(makePaymentLink({ amount: "1 000,5", language: "fr-FR", network: 1, to: A }).lux, 1_000_500_000_000n);
    assert.equal(makePaymentLink({ amount: "1.25", language: "en-GB", network: 1, to: A }).lux, 1_250_000_000n);
  });

  it("refuses more than 9 decimals, and more than a u64 of lux", () => {
    assert.equal(makePaymentLink({ amount: "0.1234567891", language: "en-GB", network: 1, to: A }).problems.amount, "DUSK has 9 decimals at most.");
    assert.equal(makePaymentLink({ amount: "18446744074", language: "en-GB", network: 1, to: A }).problems.amount, "That amount is too large.");
    assert.equal(makePaymentLink({ amountLux: 1n << 64n, network: 1, to: A }).problems.amount, "That amount is too large.");
    assert.equal(makePaymentLink({ amountLux: "123456789", network: 1, to: A }).https, `${networks.mainnet.apps.wallet}/dashboard/send?to=${A}&amount=0.123456789&network=mainnet`);
  });

  it("refuses a memo past 512 bytes, counted as bytes", () => {
    const tooLong = `That memo is too long: ${MAX_MEMO_BYTES} bytes at most.`;

    assert.equal(makePaymentLink({ memo: "x".repeat(512), network: 1, to: A }).ok, true);
    like(makePaymentLink({ memo: "x".repeat(600), network: 1, to: A }), { dusk: "", https: null, ok: false, problems: { memo: tooLong } });
    // Three bytes each.
    assert.equal(makePaymentLink({ memo: "€".repeat(170), network: 1, to: A }).ok, true);
    assert.equal(makePaymentLink({ memo: "€".repeat(171), network: 1, to: A }).problems.memo, tooLong);
    // As Send counts it: its ends' spaces aren't kept.
    assert.equal(makePaymentLink({ memo: `  ${"x".repeat(512)}  `, network: 1, to: A }).ok, true);
  });

  it("refuses what isn't a recipient, in the words of Send", () => {
    const notOne = "Not a valid address. Check it and try again.";

    for (const to of ["", "abc", "name.dusk", `${A}x`, A.slice(0, -1)]) {
      like(makePaymentLink({ network: 1, to }), { dusk: "", https: null, ok: false, problems: { to: notOne } }, to);
    }

    // The right length, but no key: DUSK sent there could never be spent.
    const noKey = "1".repeat(96);

    assert.equal(recipientKind(noKey), "public");
    assert.equal(makePaymentLink({ network: 1, to: noKey }).problems.to, notOne);
    assert.equal(makePaymentLink({ network: 1, to: "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F" }).problems.to, "That's an EVM address, not a Dusk account.");
  });

  it("refuses a recipient the apps won't send to", () => {
    const [compromised, scam] = networks.mainnet.display.blocklist;

    assert.equal(makePaymentLink({ network: 1, to: compromised.account }).problems.to, "Transfer restricted: this recipient address has been reported as compromised.");
    assert.equal(makePaymentLink({ network: 1, to: scam.account }).problems.to, "Transfer restricted: this recipient address is associated with reported fraud/scam activity.");
    // On any network, while it isn't known which, as on a chain there's no file for.
    assert.ok(makePaymentLink({ to: scam.account }).problems.to);
    assert.ok(makePaymentLink({ network: "dusk:77", to: scam.account }).problems.to);
  });

  it("says each thing that's wrong at once", () => {
    assert.deepEqual(makePaymentLink({ amount: "0", language: "en-GB", memo: "x".repeat(513), network: 1, to: "abc" }).problems, {
      amount: "Enter an amount greater than 0.",
      memo: "That memo is too long: 512 bytes at most.",
      to: "Not a valid address. Check it and try again.",
    });
  });

  it("makes links that read back, in every language", () => {
    for (const language of ["en-US", "en-GB", "nl-NL", "de-DE", "fr-FR", "es-ES", "de-CH", "hi-IN", "ar-EG"]) {
      const decimal = decimalSeparator(language);

      for (const [typed, lux] of /** @type {const} */ ([[`0${decimal}15`, 150_000_000n], [`1234${decimal}5`, 1_234_500_000_000n], ["7", 7_000_000_000n]])) {
        const made = makePaymentLink({ amount: typed, language, network: 1, to: A });

        assert.equal(made.lux, lux, `${language} ${typed}`);
        assert.equal(/** @type {any} */ (parsePaymentLink(made.https)).lux, lux, `${language} ${typed}`);
        assert.equal(/** @type {any} */ (parsePaymentLink(made.dusk)).lux, lux, `${language} ${typed}`);
      }
    }
  });
});

describe("the network a link is for", () => {
  it("is named as the apps name it", () => {
    assert.equal(chainLabel("dusk:1"), "Mainnet");
    assert.equal(chainLabel("dusk:2"), "Testnet");
    assert.equal(chainLabel("dusk:3"), "Devnet");
    assert.equal(chainLabel("dusk:0"), "Local");
    assert.equal(chainLabel("dusk:42"), "Chain 42");
    assert.equal(chainLabel(""), "");
    assert.equal(chainLabel(null), "");
    assert.equal(chainLabel("eip155:1"), "");
  });

  it("says when it isn't the wallet's", () => {
    assert.equal(networkMismatch("dusk:1", "dusk:2"), "This request is for Mainnet. You are on Testnet.");
    assert.equal(networkMismatch("dusk:2", 1), "This request is for Testnet. You are on Mainnet.");
    assert.equal(networkMismatch("dusk:7", "dusk:1"), "This request is for Chain 7. You are on Mainnet.");
    assert.equal(networkMismatch("dusk:1", "dusk:1"), "");
    assert.equal(networkMismatch("", "dusk:1"), "");
    assert.equal(networkMismatch("dusk:1", null), "");
  });
});
