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

  it("reads the receipt on DuskEVM in lower case, through the app's client, after DuskEVM's finalized block", async () => {
    const chain = fakeChain({ l2: { eth_getTransactionReceipt: () => receiptOf(LOG_1008) } });

    await createWithdrawals(withdrawalsOn(chain)).receipt(TX.toUpperCase().replace("0X", "0x"));
    assert.deepEqual(chain.rpc, [
      { method: "eth_getBlockByNumber", params: ["finalized", false] },
      { method: "eth_getTransactionReceipt", params: [TX] },
    ]);
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

describe("a withdrawal's receipt, kept once its DuskEVM block is final", () => {
  const SUBMITTER = `0x${"2c".repeat(20)}`;
  const OTHER_TX = LOG_CONTRACT_CREDIT.transactionHash;

  /**
   * DuskEVM giving the receipts and its finalized block: at `finalized`, a
   * hex height; `finalized` as a function answers in its place.
   *
   * @param {{ finalized?: string | (() => any), receipt?: (params: any[]) => any }} [options]
   */
  const chainWith = ({ finalized = LOG_1008.blockNumber, receipt = ([hash]) => receiptOf(hash === OTHER_TX ? LOG_CONTRACT_CREDIT : LOG_1008) } = {}) =>
    fakeChain({
      l2: {
        eth_getBlockByNumber: (/** @type {any[]} */ [tag]) => {
          if (tag !== "finalized") throw new Error(`Block ${tag} isn't answered here`);

          return typeof finalized === "function" ? finalized() : { number: finalized };
        },
        eth_getTransactionReceipt: receipt,
      },
    });
  /** @param {ReturnType<typeof fakeChain>} chain @param {string} [hash] */
  const receiptsAsked = (chain, hash = TX) => chain.rpc.filter(({ method, params }) => method === "eth_getTransactionReceipt" && params[0] === hash).length;
  /** @param {ReturnType<typeof fakeChain>} chain */
  const finalizedAsked = (chain) => chain.rpc.filter(({ method }) => method === "eth_getBlockByNumber").length;

  it("is read once: a later status, proof or claim asks DuskEVM for no receipt, and reads the same withdrawal", async () => {
    const chain = chainWith();
    const withdrawals = createWithdrawals(withdrawalsOn(chain));
    const first = await withdrawals.receipt(TX);

    // Dusk answers nothing here: each step refuses further on, after its receipt.
    await Promise.allSettled([withdrawals.status(TX), withdrawals.prepareProof(TX, { submitter: SUBMITTER }), withdrawals.claimCall(TX, { submitter: SUBMITTER })]);
    assert.deepEqual(await withdrawals.receipt(TX), first);
    assert.equal(receiptsAsked(chain), 1);
    assert.equal(finalizedAsked(chain), 1);
  });

  it("stays kept for another session with the app's cache, and apart from another network's", async () => {
    const cache = new Map();
    const chain = chainWith();

    await createWithdrawals(withdrawalsOn(chain, { cache })).receipt(TX);
    await createWithdrawals(withdrawalsOn(chain, { cache })).receipt(TX);
    assert.equal(receiptsAsked(chain), 1);

    // The same network with another Portal: another deployment's receipts aren't its own.
    const contracts = /** @type {any} */ (TESTNET.duskEvm).contracts;
    const other = { ...TESTNET, duskEvm: { ...TESTNET.duskEvm, contracts: { ...contracts, optimism_portal: { ...contracts.optimism_portal, contractId: "ab".repeat(32) } } } };
    const elsewhere = chainWith();

    like(await createWithdrawals(withdrawalsOn(elsewhere, { cache, network: other })).receipt(TX), { transactionHash: TX });
    assert.equal(receiptsAsked(elsewhere), 1);
  });

  it("is read again while its block is over DuskEVM's finalized one, and kept once it isn't", async () => {
    let finalized = "0x2f265c";
    const chain = chainWith({ finalized: () => ({ number: finalized }) });
    const withdrawals = createWithdrawals(withdrawalsOn(chain));

    await withdrawals.receipt(TX);
    await withdrawals.receipt(TX);
    assert.equal(receiptsAsked(chain), 2);

    finalized = LOG_1008.blockNumber;
    await withdrawals.receipt(TX);
    await withdrawals.receipt(TX);
    assert.equal(receiptsAsked(chain), 3);
  });

  it("is read again where DuskEVM's finalized block can't be read, and the withdrawal is still read", async () => {
    for (const finalized of [
      () => {
        throw new Error("unknown block tag");
      },
      () => null,
      () => ({ number: "latest" }),
    ]) {
      const chain = chainWith({ finalized });
      const withdrawals = createWithdrawals(withdrawalsOn(chain));

      like(await withdrawals.receipt(TX), { blockNumber: 3_090_013n, transactionHash: TX });
      await withdrawals.receipt(TX);
      assert.equal(receiptsAsked(chain), 2);
    }
  });

  it("is never kept for a missing or failed transaction, one that isn't a withdrawal, or another transaction's", async () => {
    const answers = {
      missing: () => null,
      failed: () => receiptOf(LOG_1008, { status: "0x0" }),
      other: () => receiptOf(LOG_OFF_ROUTE),
      another: () => receiptOf(LOG_CONTRACT_CREDIT),
    };

    for (const [name, receipt] of Object.entries(answers)) {
      const chain = chainWith({ finalized: "0xffffffff", receipt });
      const withdrawals = createWithdrawals(withdrawalsOn(chain));

      for (let i = 0; i < 2; i += 1) await withdrawals.receipt(TX).catch(() => null);
      assert.equal(receiptsAsked(chain), 2, name);
    }

    // A transaction found only later is read once it's there.
    let mined = false;
    const chain = chainWith({ receipt: () => (mined ? receiptOf(LOG_1008) : null) });
    const withdrawals = createWithdrawals(withdrawalsOn(chain));

    await assert.rejects(withdrawals.receipt(TX), { code: "not-found" });
    mined = true;
    like(await withdrawals.receipt(TX), { transactionHash: TX });
    await withdrawals.receipt(TX);
    assert.equal(receiptsAsked(chain), 2);
  });

  it("is read with the others read at the same time after one read of DuskEVM's finalized block, each receipt once", async () => {
    const chain = chainWith();
    const withdrawals = createWithdrawals(withdrawalsOn(chain));
    const [a, b, c] = await Promise.all([withdrawals.receipt(TX), withdrawals.receipt(TX), withdrawals.receipt(OTHER_TX)]);

    assert.deepEqual(a, b);
    like(c, { transactionHash: OTHER_TX });
    assert.equal(finalizedAsked(chain), 1);
    assert.equal(receiptsAsked(chain), 1);
    assert.equal(receiptsAsked(chain, OTHER_TX), 1);
    // The finalized block, then the receipts.
    assert.equal(chain.rpc[0].method, "eth_getBlockByNumber");
  });
});
