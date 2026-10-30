import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evmAddressOf } from "@dusk-network/networks/duskevm";

import { WithdrawalError, createWithdrawals, parseWithdrawalReceipt } from "../src/duskevm-withdrawals.js";
import { like } from "./fixtures/helpers.js";
import {
  CREDITED,
  LOG_1008,
  LOG_CONTRACT_CREDIT,
  LOG_OFF_ROUTE,
  PAID,
  ROUTE,
  TESTNET,
  TX,
  USER,
  USER2,
  WITHDRAWER,
  fakeChain,
  paysAccount,
  paysContract,
  passedLog,
  receiptOf,
  tokenMessage,
  u256,
  withdrawalsOn,
} from "./fixtures/withdrawals.js";

/**
 * @param {() => unknown} run
 * @param {string} code
 */
function refuses(run, code) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof WithdrawalError, String(error));
    assert.equal(error.code, code);

    return true;
  });
}

describe("a DuskEVM receipt's withdrawal", () => {
  it("is its message passer's MessagePassed: the withdrawal, its hash and block, and what it pays whom", () => {
    const withdrawal = parseWithdrawalReceipt(TESTNET, receiptOf(LOG_1008));

    like(withdrawal, {
      blockNumber: 3_090_013n,
      transactionHash: TX,
      withdrawalHash: "0x4b3472cff93e5bbf3231165ad48c0f302cf597c212b7d0e14dc671b49dc4101a",
    });
    like(withdrawal.withdrawal, {
      gasLimit: 519_542n,
      nonce: BigInt(LOG_1008.topics[1]),
      sender: "0x4200000000000000000000000000000000000007",
      target: "0x8B6Aa15321d9656c91ad2d5fBc2AE8b750aD6F9a",
      value: 1_008n * 10n ** 18n,
    });
    assert.match(withdrawal.withdrawal.data, /^0xd764ad0b/);
    like(withdrawal.facts, {
      amountWei: 1_008n * 10n ** 18n,
      from: WITHDRAWER,
      hash: withdrawal.withdrawalHash,
      recipient: { account: PAID, kind: "account" },
      target: "0x8B6Aa15321d9656c91ad2d5fBc2AE8b750aD6F9a",
    });
  });

  it("credits a contract only whole lux, at the address DuskEVM gives it", () => {
    const credit = parseWithdrawalReceipt(2, receiptOf(LOG_CONTRACT_CREDIT));

    like(credit.facts, { amountWei: 10n ** 19n, recipient: { contractId: CREDITED, kind: "contract" } });

    // The same credit to another address, or with dust, isn't paid out: refused.
    const elsewhere = passedLog({ extraData: paysContract(CREDITED), to: USER });
    const dust = passedLog({ amount: 10n ** 19n + 1n, extraData: paysContract(CREDITED), to: evmAddressOf(CREDITED) });
    const paid = passedLog({ extraData: paysContract(CREDITED), to: evmAddressOf(CREDITED) });

    refuses(() => parseWithdrawalReceipt(TESTNET, receiptOf(elsewhere)), "not-a-withdrawal");
    refuses(() => parseWithdrawalReceipt(TESTNET, receiptOf(dust)), "not-a-withdrawal");
    like(parseWithdrawalReceipt(TESTNET, receiptOf(paid)).facts, { recipient: { contractId: CREDITED, kind: "contract" } });
  });

  it("pays an account up to a u64 of lux, dust past whole lux kept, and no more", () => {
    const u64 = ((1n << 64n) - 1n) * 10n ** 9n;

    like(parseWithdrawalReceipt(TESTNET, receiptOf(passedLog({ amount: u64 + 999_999_999n }))).facts, { amountWei: u64 + 999_999_999n });
    refuses(() => parseWithdrawalReceipt(TESTNET, receiptOf(passedLog({ amount: u64 + 10n ** 9n }))), "not-a-withdrawal");
  });

  it("is only the bridge's own DUSK withdrawal, to Dusk's messenger", () => {
    // The fixture and one built the same way are withdrawals of DUSK.
    assert.equal(parseWithdrawalReceipt(TESTNET, receiptOf(passedLog())).withdrawal.value, 10n ** 19n);

    const others = {
      // A token withdrawal through the same bridge and messenger.
      token: passedLog({ amount: 0n, message: tokenMessage() }),
      // A message sent to the passer directly, shaped like the bridge's.
      direct: passedLog({ sender: USER }),
      // The bridge's call, sent through the messenger by someone else.
      relayed: passedLog({ relaySender: USER }),
      // A message claiming more than it carries.
      inflated: passedLog({ value: 1n }),
      // The bridge's call, sent somewhere other than Dusk's messenger.
      elsewhere: passedLog({ target: USER }),
      // To Dusk's messenger, relayed to another bridge than Dusk's.
      bridge: passedLog({ relayTarget: USER }),
      // Paying no one Dusk knows.
      nobody: passedLog({ extraData: "0x0201" }),
      // A message whose hash isn't its own.
      tampered: passedLog({ hash: `0x${"ab".repeat(32)}` }),
      // The web wallet's old fixture: a 10 DUSK message to 0x04ffbC4C…, not Dusk's messenger.
      offRoute: LOG_OFF_ROUTE,
    };

    for (const [name, log] of Object.entries(others)) {
      assert.throws(() => parseWithdrawalReceipt(TESTNET, receiptOf(log)), { code: "not-a-withdrawal" }, name);
    }
  });

  it("is refused for its status, its proof and its claim when it isn't one", async () => {
    for (const log of [LOG_OFF_ROUTE, passedLog({ target: USER }), passedLog({ value: 1n })]) {
      const chain = fakeChain({ l2: { eth_getTransactionReceipt: () => receiptOf(log) } });
      const withdrawals = createWithdrawals(withdrawalsOn(chain));
      const submitter = `0x${"2c".repeat(20)}`;

      for (const step of [withdrawals.status(TX), withdrawals.prepareProof(TX, { submitter }), withdrawals.claimCall(TX, { submitter })]) {
        await assert.rejects(step, { code: "not-a-withdrawal" });
      }

      // Nothing was asked of Dusk.
      assert.deepEqual(chain.calls, []);
    }
  });

  it("ignores logs that aren't the message passer's MessagePassed", () => {
    // From the wrong contract, or another event of the message passer.
    refuses(() => parseWithdrawalReceipt(TESTNET, receiptOf({ ...LOG_1008, address: "0x4200000000000000000000000000000000000017" })), "not-a-withdrawal");
    refuses(
      () => parseWithdrawalReceipt(TESTNET, receiptOf({ ...LOG_1008, topics: [`0x${"00".repeat(32)}`, ...LOG_1008.topics.slice(1)] })),
      "not-a-withdrawal"
    );
    // A MessagePassed after another log is found.
    assert.equal(parseWithdrawalReceipt(TESTNET, { ...receiptOf(LOG_1008), logs: [{ ...LOG_1008, address: USER }, LOG_1008] }).transactionHash, TX);
  });

  it("refuses a malformed or tampered event", () => {
    refuses(() => parseWithdrawalReceipt(TESTNET, receiptOf({ ...LOG_1008, data: "0x1234" })), "not-a-withdrawal");
    refuses(() => parseWithdrawalReceipt(TESTNET, receiptOf({ ...LOG_1008, data: LOG_1008.data.replace("36a4cf636319c00000", "36a4cf636319c00001") })), "not-a-withdrawal");
  });

  it("is none for a transaction DuskEVM doesn't have, or one that failed there", async () => {
    refuses(() => parseWithdrawalReceipt(TESTNET, null), "not-found");
    refuses(() => parseWithdrawalReceipt(TESTNET, receiptOf(LOG_1008, { status: "0x0" })), "failed");
    // A viem client's receipt says so in words.
    refuses(() => parseWithdrawalReceipt(TESTNET, receiptOf(LOG_1008, { status: "reverted" })), "failed");

    const withdrawals = createWithdrawals(withdrawalsOn(fakeChain({ l2: { eth_getTransactionReceipt: () => null } })));

    await assert.rejects(withdrawals.receipt(TX), { code: "not-found" });
    await assert.rejects(withdrawals.receipt("0x1234"), { code: "bad-hash" });
    await assert.rejects(withdrawals.status(` ${TX}`), { code: "bad-hash" });
  });

  it("takes its block from the receipt when its log has none, and refuses one with neither", () => {
    const { blockNumber, ...log } = LOG_1008;

    assert.equal(parseWithdrawalReceipt(TESTNET, { blockNumber: "0x10", logs: [log], status: "0x1", transactionHash: TX }).blockNumber, 16n);
    refuses(() => parseWithdrawalReceipt(TESTNET, { logs: [log], status: "0x1", transactionHash: TX }), "not-a-withdrawal");
  });

  it("reads the receipt on DuskEVM in lower case, through the app's client", async () => {
    const chain = fakeChain({ l2: { eth_getTransactionReceipt: () => receiptOf(LOG_1008) } });

    await createWithdrawals(withdrawalsOn(chain)).receipt(TX.toUpperCase().replace("0X", "0x"));
    assert.deepEqual(chain.rpc, [{ method: "eth_getTransactionReceipt", params: [TX] }]);
  });

  it("works for a network the route of which is in its file only", () => {
    // Mainnet has no DuskEVM yet: nothing is its withdrawal.
    refuses(() => parseWithdrawalReceipt(1, receiptOf(LOG_1008)), "not-a-withdrawal");
    assert.throws(() => parseWithdrawalReceipt(99, receiptOf(LOG_1008)), TypeError);
  });

  it("is paid to whom its extra data names", () => {
    like(parseWithdrawalReceipt(TESTNET, receiptOf(passedLog({ extraData: paysAccount(USER2) }))).facts, { recipient: { account: USER2, kind: "account" } });
    assert.equal(ROUTE.l2Messenger, "0x4200000000000000000000000000000000000007");
    assert.equal(u256(1).length, 32);
  });
});
