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
} from "@dusk-network/app-core/history";
import { networks, type Route } from "@dusk-network/networks";
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
const history = createHistory({ account: "x", archive, callFacts, network: networks.testnet, now: () => 1, store });
const byChainId = createHistory({ account: "x", archive, network: 2, store });
const synced: Promise<{ state: HistoryState; requests: number; added: number }> = history.sync({
  maxDetailRequests: RUN_DETAIL_REQUESTS,
  maxRequests: RUN_REQUESTS,
  onStep: (step: HistoryState) => void step.covered,
});
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
const range: Promise<{ entries: HistoryEntry[]; complete: boolean; requests: number }> = historyRange(archive, { account: "x", direction: "out", from: 0, pages: 4, to: 10 });
const covered: number[][] = addCoverage([[1, 2]], 3, 4);
const gap: [number, number] | null = topGap(covered, 10);
const downTo: number | null = shownDownTo(covered, 10);
const refused: NoArchiveError = new NoArchiveError(url);
const refusedAt: string = refused.url;
const overtaken: Error = new StaleHistoryError();
const numbers: number[] = [PAGE, FIRST_WINDOW, FINALITY_MARGIN, DETAILS_BATCH, RUN_REQUESTS, RUN_DETAIL_REQUESTS, NO_ARCHIVE_RETRY_MS];
const contracts: string[] = [TRANSFER_CONTRACT, STAKE_CONTRACT];
const kinds: EntryKind[] = [ENTRY_KIND.TRANSFER, ENTRY_KIND.CONTRACT_CALL, ENTRY_KIND.WITHDRAW_REWARD];
void [answer, checked, byChainId, synced, read, needs, filled, kind, entry, details, nonce, range, gap, downTo, refusedAt, overtaken, numbers, contracts, kinds];
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
  store: shieldedStore,
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
void [shown, tapped, tapHeights, heightsKept, heightsRead, picked, blocks, position, made, layout];
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
