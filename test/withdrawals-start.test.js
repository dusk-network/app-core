import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { duskRecipientOf } from "@dusk-network/networks/duskevm";
import { decodeFunctionData, parseAbi } from "viem";

import { WITHDRAWAL_MIN_GAS_LIMIT, withdrawalCall } from "../src/duskevm-withdrawals.js";
import { readFixture } from "./fixtures/helpers.js";
import { PAID, TESTNET, USER2, WITHDRAWER } from "./fixtures/withdrawals.js";

const { starts } = readFixture("duskevm-withdrawal-starts.json");
const BRIDGE_ETH_TO = parseAbi(["function bridgeETHTo(address _to, uint32 _minGasLimit, bytes _extraData)"]);
const U64_LUX = (1n << 64n) - 1n;

describe("a withdrawal's start on DuskEVM", () => {
  it("is what the web wallet and the bridge site send today, byte for byte", () => {
    assert.ok(starts.length >= 4);

    for (const start of starts) {
      const call = withdrawalCall(TESTNET, { amountWei: BigInt(start.amountWei), sender: start.sender, to: start.to });
      const sent = { data: call.data, to: call.to, value: call.value.toString() };

      assert.deepEqual(sent, start.webWallet, start.amountWei);
      assert.deepEqual(sent, start.bridgeSite, start.amountWei);
    }
  });

  it("is the bridge's bridgeETHTo, paying the account in its extra data, the sender named as its address", () => {
    const call = withdrawalCall(TESTNET, { amountWei: 10n ** 18n, sender: WITHDRAWER, to: USER2 });
    const { args, functionName } = decodeFunctionData({ abi: BRIDGE_ETH_TO, data: call.data });

    assert.equal(functionName, "bridgeETHTo");
    assert.equal(call.to, TESTNET.duskEvm?.predeploys.l2StandardBridge);
    assert.equal(call.value, 10n ** 18n);
    assert.equal(args[0], WITHDRAWER);
    assert.equal(args[1], WITHDRAWAL_MIN_GAS_LIMIT);
    assert.deepEqual(duskRecipientOf(args[2]), { account: USER2, kind: "account" });
    // Another gas for its message on Dusk, as asked.
    assert.equal(decodeFunctionData({ abi: BRIDGE_ETH_TO, data: withdrawalCall(2, { amountWei: 10n ** 9n, minGasLimit: 300_000, sender: WITHDRAWER, to: PAID }).data }).args[1], 300_000);
  });

  it("moves whole lux, more than 0, at most a u64 of them", () => {
    const start = (/** @type {bigint} */ amountWei) => withdrawalCall(TESTNET, { amountWei, sender: WITHDRAWER, to: USER2 });

    assert.equal(start(1_000_000_001n * 10n ** 9n).value, 1_000_000_001n * 10n ** 9n);
    assert.equal(start(U64_LUX * 10n ** 9n).value, U64_LUX * 10n ** 9n);
    assert.throws(() => start(10n ** 18n + 1n), RangeError);
    assert.throws(() => start(1n), RangeError);
    assert.throws(() => start(0n), RangeError);
    assert.throws(() => start((U64_LUX + 1n) * 10n ** 9n), RangeError);
    assert.throws(() => withdrawalCall(TESTNET, { amountWei: 1.5, sender: WITHDRAWER, to: USER2 }), TypeError);
  });

  it("pays a Dusk account only, from an EVM address", () => {
    const start = (/** @type {Record<string, any>} */ input) => withdrawalCall(TESTNET, { amountWei: 10n ** 18n, sender: WITHDRAWER, to: USER2, ...input });

    // A typo, a contract, or nothing: no account.
    assert.throws(() => start({ to: `${USER2.slice(0, -1)}x` }), TypeError);
    assert.throws(() => start({ to: "ed7176a3a7845a577732395887494965ae49c0daf29672d4370121b51844a0af" }), TypeError);
    assert.throws(() => start({ to: "" }), TypeError);
    // A sender with its checksum wrong, or not an address.
    assert.throws(() => start({ sender: WITHDRAWER.replace("D", "d") }), TypeError);
    assert.throws(() => start({ sender: "0x1234" }), TypeError);
    assert.throws(() => start({ minGasLimit: 2 ** 32 }), RangeError);
    // On a network without DuskEVM's bridge, there's none to send.
    assert.throws(() => withdrawalCall(1, { amountWei: 10n ** 18n, sender: WITHDRAWER, to: USER2 }), TypeError);
  });
});
