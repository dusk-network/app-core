// Types only: `tsc -p test-types` checks that the .d.ts files give an app
// what the code returns. It isn't run.
import {
  DETAILS_BATCH,
  ENTRY_KIND,
  FINALITY_MARGIN,
  FIRST_WINDOW,
  NO_ARCHIVE_RETRY_MS,
  NoArchiveError,
  PAGE,
  RUN_DETAIL_REQUESTS,
  RUN_REQUESTS,
  STAKE_CONTRACT,
  StaleHistoryError,
  TRANSFER_CONTRACT,
  addCoverage,
  createArchive,
  createHistory,
  fetchTxDetails,
  fetchTxNonce,
  historyArchiveUrl,
  historyEntry,
  historyRange,
  parseHistoryEntry,
  shownDownTo,
  topGap,
  type Archive,
  type BridgeFacts,
  type CallFacts,
  type EntryDetails,
  type EntryKind,
  type HistoryEntry,
  type HistoryState,
  type HistoryStore,
  type KeptEntry,
  type ReadEntry,
  type RefusalStore,
  type StoreCheck,
} from "@dusk-network/app-core/history";
import { networks, type Route } from "@dusk-network/networks";
import {
  CLOCK_SLACK_MS,
  CREDIT_WINDOW_MS,
  DEPOSIT_HORIZON_MS,
  ETH_BRIDGE_FINALIZED_TOPIC,
  EXPLORER_PAGES,
  HISTORY_PAGES,
  LOG_WINDOW,
  LOG_WINDOWS,
  SERVICE_HORIZON_MS,
  TRANSFER_TOPIC,
  WAIT_MS,
  arrivalsOf,
  depositArrivals,
  depositOf,
  migrationPayoutOf,
  migrationPayouts,
  serviceArrivals,
  serviceTransferOf,
  type Arrival,
  type BlockTimes,
  type Deposit,
  type HistoryScan,
  type MigrationPayout,
  type NoPayout,
  type Scan,
  type ServiceTransferFacts,
  type UnknownReason,
  depositArrivalsFromExplorer as fromBridge,
} from "@dusk-network/app-core/bridge";
import { depositArrivalsFromExplorer, type ExplorerDepositOptions } from "@dusk-network/app-core/bridge-explorer";
import {
  DECOYS_PER_HEIGHT,
  HEIGHTS_PER_REQUEST,
  LEAF_BYTES,
  LEAF_HEIGHT_OFFSET,
  LEAF_POS_OFFSET,
  NOTE_BYTES,
  createLeafHeightTap,
  fetchShieldedBlocks,
  leafInfo,
  noteTreeHeights,
  pickHeights,
  readNoteHeights,
  shieldedEntries,
  shieldedHistory,
  type LeafHeightTap,
  type NoteTree,
  type OwnedNote,
  type ShieldedBlock,
  type ShieldedEntry,
  type ShieldedHistory,
  type ShieldedRecord,
  type ShieldedStore,
  type TreeHeights,
  type TreeHeightsStore,
} from "@dusk-network/app-core/shielded";

const url: string = historyArchiveUrl({ archiveUrl: "", chainIdOf: () => 2, nodeUrl: "https://testnet.nodes.dusk.network" });
const refusals: RefusalStore = { get: async () => null, put: async () => {} };
const archive: Archive = createArchive({ fetch, now: Date.now, refusals, timeoutMs: 8_000, url });
const viaCaller: Archive = createArchive({ query: async (text: string) => ({ text }), url });
const answer: Promise<any> = archive.query("query { pair: lastBlockPair { json } }", { timeoutMs: 1_000 });
const checked: Promise<void> = viaCaller.assertArchive();

let state: HistoryState | null = null;
const rows = new Map<string, KeptEntry>();
const store: HistoryStore = {
  clear: async () => {
    state = null;
    rows.clear();
  },
  commit: (entries, update) => {
    state = update(state);
    for (const entry of entries) rows.set(entry.hash, { ...rows.get(entry.hash), ...entry });

    return state;
  },
  getState: () => state,
  list: ({ before, limit }) => [...rows.values()].filter((row) => before === undefined || row.blockHeight < before).slice(0, limit),
  patch: (details) => {
    for (const [hash, found] of details) {
      const row = rows.get(hash);

      if (row) rows.set(hash, { ...row, ...found });
    }
  },
};
const callFacts: CallFacts = {
  read: (call, account) => ({ registeredName: call.args ? account : null }),
  wants: (entry) => entry.fnName === "register" && entry.registeredName === undefined,
};
// A store that checks the state kept in the same transaction as its write.
const check: StoreCheck = (kept) => void kept?.genesis;
const checking: HistoryStore = {
  ...store,
  clear: (forget) => {
    forget?.(state);
    state = null;
  },
  patch: (details, keep) => {
    keep?.(state);
    store.patch(details);
  },
};
const history = createHistory({ account: "x", archive, callFacts, network: networks.testnet, now: () => 1, store });
const byChainId = createHistory({ account: "x", archive, network: 2, store: checking });
const synced: Promise<{ state: HistoryState; requests: number; added: number; detailsError?: Error }> = history.sync({
  maxDetailRequests: RUN_DETAIL_REQUESTS,
  maxRequests: RUN_REQUESTS,
  onStep: (step: HistoryState) => void step.covered,
});
const detailsFailed = synced.then(({ detailsError }) => detailsError?.message);
const binary: boolean | undefined = parseHistoryEntry("x", {})?.memoBinary;
const read = history.read({ before: 10, limit: PAGE, pools: ["ab"] }).then(({ complete, coveredTo, entries, state: kept }) => {
  const first: ReadEntry | undefined = entries[0];
  const value: bigint | undefined = first?.value;
  const fee: bigint | null | undefined = first?.fee;
  const route: Route | null | undefined = first?.route;
  const sozu: boolean | undefined = first?.sozu;
  const bridge: BridgeFacts | null | undefined = first?.bridge;
  const extra: unknown = first?.registeredName;
  const done: boolean = complete;
  const to: number | null = coveredTo;
  const window: number | undefined = kept?.window;

  if (bridge?.kind === "deposit") {
    const evm: `0x${string}` = bridge.to;
    void evm;
  } else if (bridge) {
    const paid: string | null = bridge.recipient;
    const hash: `0x${string}` = bridge.hash;
    void [paid, hash];
  }

  void [value, fee, route, sozu, extra, done, to, window];
});
const needs: boolean = history.needsDetails({ blockHeight: 1, counterparty: null, direction: "in", hash: "ab", kind: "transfer", memo: "", payer: false, value: "1" });
const filled: Promise<void> = history.fillDetails([], { onStep: () => {} });
const parsed: HistoryEntry | null = parseHistoryEntry("x", {});
const kind: EntryKind | undefined = parsed?.kind;
const entry: ReadEntry = historyEntry({ blockHeight: 1, counterparty: null, direction: "out", hash: "ab", kind: "contract_call", memo: "", payer: true, value: "1" }, { network: 2, pools: new Set(["ab"]) });
const details: Promise<Map<string, EntryDetails & Record<string, unknown>>> = fetchTxDetails(archive, ["ab"], { account: "x", args: new Set(["ab"]), callFacts, network: 2, now: Date.now });
const nonce: Promise<string | null> = fetchTxNonce(archive, "ab");
const range: Promise<{ entries: HistoryEntry[]; complete: boolean; requests: number }> = historyRange(archive, { account: "x", direction: "out", from: 0, page: 5, pages: 4, to: 10 });
const covered: number[][] = addCoverage([[1, 2]], 3, 4);
const gap: [number, number] | null = topGap(covered, 10);
const downTo: number | null = shownDownTo(covered, 10);
const refused: NoArchiveError = new NoArchiveError(url);
const refusedAt: string = refused.url;
const overtaken: Error = new StaleHistoryError();
const numbers: number[] = [PAGE, FIRST_WINDOW, FINALITY_MARGIN, DETAILS_BATCH, RUN_REQUESTS, RUN_DETAIL_REQUESTS, NO_ARCHIVE_RETRY_MS];
const contracts: string[] = [TRANSFER_CONTRACT, STAKE_CONTRACT];
const kinds: EntryKind[] = [ENTRY_KIND.TRANSFER, ENTRY_KIND.CONTRACT_CALL, ENTRY_KIND.WITHDRAW_REWARD];
void [answer, checked, check, byChainId, synced, detailsFailed, binary, read, needs, filled, kind, entry, details, nonce, range, gap, downTo, refusedAt, overtaken, numbers, contracts, kinds];
// @ts-expect-error a direction is "in", "out" or "both"
historyRange(archive, { account: "x", direction: "self" });
// @ts-expect-error an archive needs its URL
createArchive({ fetch });
// @ts-expect-error a history needs a store
createHistory({ account: "x", archive });

// The shielded history, over an app's own stores and note tree.
let shieldedRecord: ShieldedRecord | null = null;
const shieldedStore: ShieldedStore = {
  get: () => shieldedRecord,
  put: async (next) => {
    shieldedRecord = next;
  },
};
// One that keeps the decoys in one transaction.
const updatingStore: ShieldedStore = {
  ...shieldedStore,
  update: async (change) => {
    shieldedRecord = change(shieldedRecord);

    return shieldedRecord;
  },
};
let keptHeights: TreeHeights | null = null;
const treeHeights: TreeHeightsStore = {
  get: async () => keptHeights,
  put: (next) => {
    keptHeights = next;
  },
};
const tree: NoteTree = { leaves: async (from: bigint) => new Response(new Uint8Array(Number(from))), size: () => 6n };
const owned: OwnedNote = { leaf: new Uint8Array(LEAF_BYTES), nullifier: new Uint8Array(32), spent: false };
const shielded: Promise<ShieldedHistory> = shieldedHistory({
  archive,
  isCurrent: () => true,
  notes: async () => [owned],
  random: () => 1,
  store: updatingStore,
  synced: true,
  tree,
  treeHeights,
  valueOf: async () => 1n,
});
const shown = shielded.then(({ entries, pending }) => {
  const first: ShieldedEntry | undefined = entries[0];
  const moved: string | undefined = first?.value;
  const paid: string | null | undefined = first?.fee;
  const when: number | null | undefined = first?.timestamp;
  const failed: string | undefined = first?.error;
  const did: EntryKind | undefined = first?.kind;
  const ok: boolean | undefined = first?.success;
  const more: boolean = pending;

  void [moved, paid, when, failed, did, ok, more];
});
const tap: LeafHeightTap = createLeafHeightTap({ from: 0n });
const tapped: ReadableStream<Uint8Array> | undefined = new Response(new Uint8Array(LEAF_BYTES)).body?.pipeThrough(tap.stream());
const tapHeights: number[] | null = tap.heights(1n);
const heightsKept: Promise<number[] | null> = noteTreeHeights(tree, treeHeights, { isCurrent: () => true });
const heightsRead: Promise<number[] | null> = readNoteHeights({ leaves: async () => null }, 6n, { from: 0, isCurrent: () => true });
const picked: { decoys: number[]; heights: number[] } = pickHeights([1, 2, 3], [2], { keep: [1], perHeight: DECOYS_PER_HEIGHT, random: () => 1 });
const blocks: Promise<Map<number, ShieldedBlock>> = fetchShieldedBlocks(archive, [1, 2], { isCurrent: () => true });
const position: { height: number; pos: bigint } = leafInfo(owned.leaf);
const made: ShieldedEntry[] = shieldedEntries({ blocks: new Map(), notes: [{ ...owned, value: 1n }] });
const layout: number[] = [LEAF_BYTES, NOTE_BYTES, LEAF_POS_OFFSET, LEAF_HEIGHT_OFFSET, HEIGHTS_PER_REQUEST];
void [shieldedStore, shown, tapped, tapHeights, heightsKept, heightsRead, picked, blocks, position, made, layout];
// @ts-expect-error a shielded history needs to know whether the notes are all found
shieldedHistory({ archive, notes: () => [], store: shieldedStore, tree, treeHeights, valueOf: () => 1n });
// @ts-expect-error an entry's amounts are text, as kept
const lux: bigint = made[0].value;
void lux;

// `/activity`: an account's rows from its histories and the wallet's sends.
import {
  PENDING_MS,
  activityRows,
  settleSends,
  type ActivityBridge,
  type ActivityCategory,
  type ActivityInput,
  type ActivityRow,
  type ActivityStatus,
  type BridgeStep,
  type NameFacts,
  type SentTransaction,
} from "@dusk-network/app-core/activity";

const sends: SentTransaction[] = [
  { hash: "ab", kind: "transfer", amount: "5", to: "x", status: "submitted", submittedAt: 1, toName: "alice.dusk", origin: "https://app.example" },
  { hash: "cd", kind: "contract_call", amount: 0n, deposit: 5n, contractId: "ef", fnName: "pay", bridge: { kind: "deposit", amount: "5", to: "0x00" } },
];
const shieldedRows: ShieldedEntry[] = [{ hash: "ab", blockHeight: 1, kind: "transfer", direction: "out", value: "5", fee: null, success: true, timestamp: null }];
const nameCall: ActivityInput["nameCall"] = (call, kept): NameFacts | null =>
  call.fnName === "register" ? { kind: "registration", name: typeof kept.registeredName === "string" ? kept.registeredName : null } : null;
const activity: ActivityRow[] = activityRows({
  account: "x",
  address: null,
  arrivals: new Map([["ab", { at: 1, hash: "0x29" }]]),
  claims: new Map([["0x8e", { claimed: true, ready: false }]]),
  nameCall,
  names: new Map([["x", "alice.dusk"]]),
  network: networks.testnet,
  now: Date.now(),
  pending: sends,
  pools: new Set(["ab"]),
  profileIndex: 0,
  public: [entry],
  shielded: shieldedRows,
  state: { finalized: 10, headAt: 1 },
});
const first: ActivityRow | undefined = activity[0];
const status: ActivityStatus | undefined = first?.status;
const category: ActivityCategory | undefined = first?.category;
const moved: bigint | undefined = first?.value;
const paid: bigint | null | undefined = first?.fee;
const bridged: ActivityBridge | null | undefined = first?.bridge;
const step: BridgeStep | undefined = bridged?.step;
const arrivedAt: number | null | undefined = bridged?.arrival?.at;
const onRoute: Route | null | undefined = first?.route;
const sozuStep: "stake" | "unstake" | null | undefined = first?.sozu;
const reserved: string | null | undefined = first?.nameCall?.name;
const record: SentTransaction | null | undefined = first?.sent;
const { drop, keep }: { drop: string[]; keep: SentTransaction[] } = settleSends({ keeps: (s) => Boolean(s.toName), pending: sends, public: [entry], shielded: shieldedRows });
const waits: number = PENDING_MS;
void [status, category, moved, paid, step, arrivedAt, onRoute, sozuStep, reserved, record, drop, keep, waits, activityRows()];
// @ts-expect-error a row's status is one of four
const wrong: ActivityStatus = "submitted";
// @ts-expect-error a send needs its hash
const noHash: SentTransaction = { kind: "transfer" };
void [wrong, noHash];

// What happened on the other side of the bridge's routes.
const blockTimes: BlockTimes = new Map<number, number>();
const kept: ReadEntry = historyEntry({ blockHeight: 1, counterparty: null, direction: "out", hash: "ab", kind: "contract_call", memo: "", payer: true, value: "1" });
const found: (Deposit & { amount: bigint }) | null = depositOf(kept, "x");
const keptDeposit: Deposit | null = depositOf({ blockHeight: 1, counterparty: null, direction: "out", hash: "ab", kind: "contract_call", memo: "", payer: true, value: "1" });
const deposits: Promise<{ arrivals: Map<string, Arrival>; requests: number }> = depositArrivals({
  archive,
  blockTimes,
  deposits: found ? [found] : [{ amount: 1n, at: null, hash: "ab", notBefore: 1n, scan: { basis: 1, from: "2", search: "" }, sender: null, to: "0xab" }],
  explorerUrl: "https://explorer.example",
  fetch,
  maxPages: EXPLORER_PAGES,
  maxWindows: LOG_WINDOWS,
  network: 2,
  now: 1,
  rpcUrl: "https://rpc.example",
  taken: new Set(["0xab"]),
  timeoutMs: 8_000,
  via: "rpc",
  waitMs: WAIT_MS,
  windowMs: CREDIT_WINDOW_MS,
});
// An app that reads only the explorer.
const explorerOnly: ExplorerDepositOptions = { deposits: [], fetch, maxPages: 1, network: 2, now: 1, taken: [], waitMs: Infinity };
const onExplorer: Promise<{ arrivals: Map<string, Arrival>; requests: number }> = depositArrivalsFromExplorer(explorerOnly);
const sameFunction: typeof depositArrivalsFromExplorer = fromBridge;
void [onExplorer, sameFunction];
// @ts-expect-error the explorer's reads take no RPC
depositArrivalsFromExplorer({ deposits: [], network: 2, rpcUrl: "https://rpc.example" });
const followed = deposits.then(({ arrivals }) => {
  const one: Arrival | undefined = arrivals.get("ab");
  // `/activity`'s input.
  const forActivity: Map<string, { hash: string; at: number | null }> = arrivalsOf(arrivals);

  if (one?.state === "arrived") {
    const paid: [string, number | null, bigint, number | null] = [one.hash, one.at, one.amount, one.block];
    void paid;
  } else if (one?.state === "unknown") {
    const why: UnknownReason = one.reason;
    const next: Scan | undefined = one.scan;
    const width: [number | undefined, number | undefined] = [next?.size, next?.refused];
    const error: string | undefined = one.error;
    void [why, next, width, error];
  }

  const input: ActivityInput["arrivals"] = forActivity;

  void input;
});
const facts: ServiceTransferFacts | null = serviceTransferOf(kept, networks.mainnet);
const out: Promise<{ arrivals: Map<string, Arrival>; requests: number }> = serviceArrivals({
  archive,
  blockTimes,
  fetch,
  maxWindows: 2,
  network: 1,
  now: 1,
  rpcUrl: "https://bsc.example",
  taken: [],
  transfers: facts?.to && !facts.problem ? [{ fee: facts.fee, hash: facts.hash, notBefore: 1n, route: facts.route, scan: null }] : [],
  waitMs: 1,
});
// A cache a chain, by its chain ID.
const timesByChain = new Map<number, BlockTimes>();
const outByChain: Promise<{ arrivals: Map<string, Arrival>; requests: number }> = serviceArrivals({
  archive,
  blockTimes: (chainId: number) => timesByChain.get(chainId),
  network: 1,
  transfers: [],
});
void outByChain;
const sentOut: [bigint, bigint | null] | null = facts ? [facts.sent, facts.amount] : null;
const out2 = out.then(({ arrivals }) => {
  const one = arrivals.get("ab");
  const why: NoPayout | undefined = one?.state === "unknown" ? one.problem : undefined;
  const seen: ReadonlyArray<{ hash: string; block: string; at: number; sender: string | null }> | undefined = one?.state === "waiting" ? one.scan?.seen : undefined;
  const read: HistoryScan | undefined = one?.state === "waiting" ? one.scan?.history : undefined;
  const page: number | undefined = read?.next?.page;

  void [why, seen, page];
});
const payout: MigrationPayout | null = migrationPayoutOf(kept, 1);
// Where one account pays out both routes, a payout doesn't say which: its payer does.
const payoutRoute: string | null | undefined = payout?.route;
const payoutPayer: string | undefined = payout?.payer;
// A kept entry tells a gas refund apart as text, a read one as a bigint.
const keptRefund: string | undefined = ({ blockHeight: 1, counterparty: null, direction: "in", hash: "ab", kind: "transfer", memo: "", payer: false, refund: "5", value: "6" } satisfies KeptEntry).refund;
const readRefund: bigint | undefined = kept.refund;
const migrations: Promise<{ payouts: Map<string, Arrival>; unlisted: MigrationPayout[]; requests: number }> = migrationPayouts({
  entries: [kept],
  migrations: [{ amount: "1", at: 1, hash: "0xab", route: "bsc-to-dusk" }],
  network: networks.mainnet,
  now: 1,
  taken: [],
  waitMs: 1,
});
const byMemo: Promise<unknown> = migrationPayouts({ account: "x", archive, migrations: [], network: 1 });
const bridgeNumbers: number[] = [CLOCK_SLACK_MS, CREDIT_WINDOW_MS, WAIT_MS, EXPLORER_PAGES, LOG_WINDOW, LOG_WINDOWS, DEPOSIT_HORIZON_MS, SERVICE_HORIZON_MS, HISTORY_PAGES];
const topics: string[] = [TRANSFER_TOPIC, ETH_BRIDGE_FINALIZED_TOPIC];
void [keptDeposit, followed, out, out2, sentOut, payout, payoutRoute, payoutPayer, keptRefund, readRefund, migrations, byMemo, bridgeNumbers, topics];
// @ts-expect-error a deposit is followed on the explorer or the RPC
depositArrivals({ deposits: [], network: 2, via: "adapter" });
// @ts-expect-error a transfer out needs the archive: each transfer is read from the chain
serviceArrivals({ network: 1, transfers: [] });
// @ts-expect-error a migration names its route
migrationPayouts({ entries: [], migrations: [{ amount: 1n, hash: "0xab" }], network: 1 });

// `/duskevm-withdrawals`: a withdrawal's life, signing aside.
import {
  EXPLORER_ITEMS,
  GAME_SEARCH_DEPTH,
  GAS_LIMIT_UPPER,
  MAX_BATCH,
  STAGE,
  WITHDRAWAL_MIN_GAS_LIMIT,
  WithdrawalError,
  createWithdrawals,
  explorerStage,
  explorerWithdrawals,
  parseWithdrawalReceipt,
  syncWithdrawals,
  withdrawalCall,
  withdrawalsByNonce,
  type DataDriver,
  type ExplorerWithdrawal,
  type FoundWithdrawal,
  type PortalCall,
  type PreparedProof,
  type ReceiptWithdrawal,
  type WaitReason,
  type WithdrawalClaim,
  type WithdrawalScan,
  type WithdrawalStage,
  type WithdrawalStatus,
  type WithdrawalTiming,
  type Withdrawals,
} from "@dusk-network/app-core/duskevm-withdrawals";
import { createPublicClient, http } from "viem";

const driver: DataDriver = { decodeOutputFn: (_fn, bytes) => bytes.length, encodeInputFn: (_fn, json) => new TextEncoder().encode(json) };
// DuskEVM's RPC as a viem client, or a URL and fetch.
const client = createPublicClient({ transport: http("https://rpc.testnet.evm.dusk.network") });
const withdrawals: Withdrawals = createWithdrawals({
  cache: new Map<string, string>(),
  drivers: { disputeGameFactory: async () => driver, optimismPortal: Promise.resolve(driver) },
  duskEvm: client,
  fetch,
  gameSearchDepth: 64,
  latestBlock: async () => ({ height: 1n, timestamp: 2n }),
  maxBatch: 64,
  network: 2,
  nodeUrl: "https://testnet.nodes.dusk.network",
});
const byUrl: Withdrawals = createWithdrawals({ drivers: { disputeGameFactory: driver, optimismPortal: driver }, duskEvm: { fetch, url: "https://rpc.example" }, network: networks.testnet, nodeUrl: "https://x" });
const statusRead: Promise<WithdrawalStatus> = withdrawals.status("0x00", { proofGame: null, submitter: "0x2c" });
const prepared: Promise<PreparedProof> = withdrawals.prepareProof("0x00", { gasLimitUpper: GAS_LIMIT_UPPER, submitter: "0x2c" });
const claimed: Promise<PortalCall> = withdrawals.claimCall("0x00", { submitter: "0x2c" });
const claimsRead: Promise<Map<string, WithdrawalClaim>> = withdrawals.claims(["0x8e"], { submitter: "0x2c" });
const timed: Promise<WithdrawalTiming> = byUrl.timing();
const received: Promise<ReceiptWithdrawal> = byUrl.receipt("0x00");
void (async () => {
  const s = await statusRead;
  const stage: WithdrawalStage = s.stage;
  const reason: WaitReason | null = s.reason;
  const readyAt: bigint | null | undefined = s.readyAt;
  const pays: string = s.facts.recipient.kind === "account" ? s.facts.recipient.account : s.facts.recipient.contractId;
  const { call, claim, proof } = await prepared;
  const fnArgs: Uint8Array = call.fnArgs;
  const deposit: 0n = call.deposit;
  const index: bigint = proof.disputeGameIndex;
  const at: number | null | undefined = claim?.at;
  const decodedHash: `0x${string}` = (await claimed).decoded.hash;
  // As `/activity` takes `claims`.
  const forActivity: ActivityInput["claims"] = await claimsRead;
  void [stage, reason, readyAt, pays, fnArgs, deposit, index, at, decodedHash, forActivity, timed, received];
})();
try {
  parseWithdrawalReceipt(2, null);
} catch (error) {
  if (error instanceof WithdrawalError) {
    const why: "not-found" | string = error.code;
    const was: WithdrawalStatus | null = error.status;
    void [why, was];
  }
}
const start: { to: `0x${string}`; data: `0x${string}`; value: bigint } = withdrawalCall(2, { amountWei: 10n ** 18n, minGasLimit: WITHDRAWAL_MIN_GAS_LIMIT, sender: "0x00", to: "x" });
const scan: Promise<{ found: FoundWithdrawal[]; requests: number; state: WithdrawalScan }> = syncWithdrawals({ address: "0x00", duskEvm: client, network: 2 });
// Its passes over the final blocks again: where the one under way is, and when the next begins.
const passes = scan.then(({ state }) => [state.recheck?.from, state.recheck?.at] satisfies [number | null | undefined, number | undefined]);
const listed: Promise<ExplorerWithdrawal[]> = explorerWithdrawals({ address: "0x00", maxItems: EXPLORER_ITEMS, network: 2 });
const byNonce: Promise<Map<string, ExplorerWithdrawal>> = withdrawalsByNonce({ network: 2, nonces: [1n] });
const stageOf: WithdrawalStage | null = explorerStage("Relayed");
const named: "finalized" = STAGE.FINALIZED;
void [start, scan, passes, listed, byNonce, stageOf, named, GAME_SEARCH_DEPTH, MAX_BATCH];
// @ts-expect-error a claim sends no DUSK along
const sendsDusk: PortalCall["deposit"] = 1n;
// @ts-expect-error a proof is for one account
void withdrawals.prepareProof("0x00", {});
void sendsDusk;
