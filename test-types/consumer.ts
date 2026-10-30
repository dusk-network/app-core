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
