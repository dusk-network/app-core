# Changelog

All notable changes to this package are listed here. It follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- `/duskevm-withdrawals`: a withdrawal's receipt is kept in `cache` once its DuskEVM block is final, and read once

### Fixed

- `/bridge`: a memo of bytes that aren't text (`memoBinary`) gives no payout address, and names no migration

## [0.4.0]

### Added

- `/history`: `memoBinary` on an entry whose memo is bytes given as 0x hex, rather than typed 0x text
- `/history`: a `check` for the store's `patch` and `clear` to make in the same transaction, so a run after a reset leaves another run's history of the new chain alone
- `/shielded`: an optional `update` on the store, which keeps the decoys in one transaction, so two reads at once ask among the same ones
- `/bridge`: `serviceArrivals` takes `blockTimes` as a cache for each chain, by its chain ID

### Changed

- `/history`: a details request that fails in `sync()` ends the run's details and resolves it with `detailsError`, rather than rejecting the run
- `/bridge`: an RPC search's windows grow up to 100,000 blocks while the RPC answers them whole, and a call reads a chain's head and pace once for all its searches

### Fixed

- `/shielded`: a conversion is a shield or an unshield as its event says, also for a profile that only got its change
- `/shielded`: two notes a block made for one shielded address go to a transaction each, rather than both to the first
- `/activity`: a gas refund from another account's call to DuskEVM's bridge is a received transfer, rather than a bridge withdrawal
- `/bridge`: an RPC search starts 10 minutes before the transfer as the chain's pace says, at a block whose time is checked to be before it, rather than a fifth further back than the pace says
- `/bridge`: an RPC search keeps the width of its windows in its `scan`, so one window a call moves on past an RPC that takes fewer blocks than it asked
- `/bridge`: `serviceArrivals` uses one `blockTimes` cache only for a network whose service routes are all on one chain
- `/bridge`: a deposit without its sender's history reads no further once its windows are over and read
- `/duskevm-withdrawals`: `syncWithdrawals` reads the final blocks again, the newest 50,000 on each run and all of them a pass at a time once covered, rather than once
- `/duskevm-withdrawals`: `syncWithdrawals` counts both its head's requests against `maxRequests` where the RPC has no finalized block

## [0.3.2]

### Fixed

- `/bridge`: an RPC search reads each block more than once while its transfers wait, from the first transfer's block on, rather than once
- `/bridge`: on an RPC, an earlier one of equal transfers takes a credit a later one could have had once the blocks before it are read again, rather than at once

## [0.3.1]

### Added

- `/history`: `historyRange` reads on from a `page`

### Fixed

- `/bridge`: each transfer reads only its own hours of its account's history, read on from its `scan` while a call can't read it all: it waits then, rather than staying unsure
- `/bridge`: a transfer the archive doesn't list in its account's history yet waits, rather than taking an earlier one's credit
- `/bridge`: a deposit whose call's arguments the archive doesn't give counts as one that could be equal, rather than none

## [0.3.0]

### Added

- `/duskevm-withdrawals`: a DuskEVM withdrawal's start, finding it again, its status and claim date, and its proof's and claim's calls, checked before they're handed over to sign

### Fixed

- `/bridge`: a migration is paid by its own route's payout account also where one account pays out both routes (a payout of one not listed then has a null `route`), and a payout read from an entry leaves out a gas refund paid with it, which `/history` entries now tell apart as `refund`

## [0.2.0]

### Added

- `/bridge`: `depositArrivals`, `migrationPayouts` and `serviceArrivals`, where a deposit to DuskEVM, a migration and a transfer out to BNB Smart Chain arrived, each credit paying one transfer, in order

## [0.1.0]

### Added

- `/history`: `createHistory`, a public account's history synced from the archive by block height into the app's own store, newest first, carried on run by run, and `StaleHistoryError` for a run another one overtook
- `/history`: `createArchive`, the archive's GraphQL by the app's fetch or caller, with exact amounts, retries, and an hour's rest for a node without the archive
- `/history`: `historyArchiveUrl`, the node in place of an archive on another chain
- `/history`: `parseHistoryEntry` and `historyEntry`, what an entry did for the account, with its bridge route and Sozu call
- `/history`: `fetchTxDetails` and `fetchTxNonce`, a transaction's time, outcome, fee and call, a DuskEVM bridge call read from its arguments
- `/history`: `callFacts`, the app's own hook for the calls it reads
- `/history`: `historyRange`, an account's entries between two heights, a page at a time
- `/history`: `addCoverage`, `topGap` and `shownDownTo`, the heights a history covers
- `/shielded`: `shieldedHistory`, a profile's shielded history from the notes its sync keeps, each block asked for among decoys kept before asking
- `/activity`: `activityRows`, an account's rows from its public and shielded history and the wallet's own sends, as facts, and `settleSends`, for the sends the chain's rows now say all of
- Published to npm as `@dusk-network/app-core` and to JSR as `@dusk/app-core`
