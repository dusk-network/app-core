/**
 * Where a deposit to DuskEVM arrived, followed on DuskEVM's explorer alone,
 * for an app that reads only the explorer: what `/bridge`'s
 * `depositArrivals` does with `via: "explorer"`, without its RPC path and
 * `/history`. `/bridge` exports it too.
 *
 * @example
 * ```js
 * import { depositArrivalsFromExplorer } from "@dusk/app-core/bridge-explorer";
 *
 * const { arrivals } = await depositArrivalsFromExplorer({ network: chainId, deposits: [{ hash, amount, to, at }], fetch });
 * arrivals.get(hash); // { state: "arrived", hash: "0x029e…", at: 1793080333000, amount: 500000000n, block: 3951755 }
 * ```
 *
 * @module
 */

import type { Arrival, DepositArrivalOptions } from "./bridge.js";

/** What `depositArrivalsFromExplorer` takes: `depositArrivals`' options for the explorer. */
export type ExplorerDepositOptions = Omit<DepositArrivalOptions, "via" | "rpcUrl" | "archive" | "blockTimes" | "maxWindows">;

/**
 * Where each deposit arrived on DuskEVM, by its Dusk transaction's hash
 * (lower case), in the order given, and the requests it took, as
 * `depositArrivals` gives them with `via: "explorer"`: the recipient's
 * incoming calls are read once for all its deposits, newest first, back
 * past the oldest one waited for, at most `maxPages` pages; none is asked
 * while every deposit's window is still open. A network without DuskEVM
 * asks nothing. Throws a TypeError for a deposit that isn't one, and for a
 * network there's no file for.
 */
export declare function depositArrivalsFromExplorer(options: ExplorerDepositOptions): Promise<{ arrivals: Map<string, Arrival>; requests: number }>;
