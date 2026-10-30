# @dusk-network/app-core

Shared logic for the Dusk apps: public and shielded history, activity rows, bridge arrivals and DuskEVM withdrawals.

It has no framework and runs in a browser extension's service worker. Each part is its own entry point, so an app loads only what it uses. Apps pass in their own fetch, batching and storage; the package never chooses storage keys.

Network data (endpoints, contracts, routes) comes from [`@dusk-network/networks`](https://github.com/dusk-network/networks).

Nothing is published yet.

## License

MPL-2.0
