import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";

import { activityRows } from "../src/activity.js";
import { amountForField, parseDusk, normalizeAmount, decimalSeparator } from "../src/amounts.js";
import { MAX_MEMO_BYTES, chainLabel, makePaymentLink, networkMismatch, parsePaymentLink, recipientKind } from "../src/payment-links.js";
import { A, B, recorded } from "./fixtures/activity.js";
import { like } from "./fixtures/helpers.js";

// A real shielded address, as a shield of the recording names it.
const SHIELDED = /** @type {string} */ (activityRows({ public: [recorded(B, 2517213)], account: B, network: 2 })[0].counterparty);

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

  it("carries a memo through email and chat, whatever's in it", () => {
    for (const memo of ["Factura 33, \"abril\" & mayo", "a+b=c?d#e%f", "Línea 1\nLínea 2", "€ 12,50 🧾", "ends with a dot.", "gnp.exe \u202E"]) {
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
    assert.equal(makePaymentLink({ amount: "1.234", language: "es-ES", network: 1, to: A }).problems.amount, "Is that 1234 or 1,234? Write the one you mean.");
    assert.equal(makePaymentLink({ amount: "abc", language: "es-ES", network: 1, to: A }).problems.amount, "Enter an amount such as 10 or 10,5.");
    // And reads what each language writes.
    assert.equal(makePaymentLink({ amount: "1 000,5", language: "fr-FR", network: 1, to: A }).lux, 1_000_500_000_000n);
    assert.equal(makePaymentLink({ amount: "1.234", language: "en-GB", network: 1, to: A }).lux, 1_234_000_000n);
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
