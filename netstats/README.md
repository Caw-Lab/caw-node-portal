# netstats

The network numbers shown on the portal page: how many users and posts there are, how active the week was, how
many actions the chain has processed, and how much CAW is held in deposit. A scheduled GitHub Actions run
(`.github/workflows/netstats.yml`, once a day) collects them and publishes `network.json` on the
`data-network` branch; the page reads it from raw.githubusercontent.com and draws a small history.

## What the numbers are

| number | where it comes from | what it is |
|---|---|---|
| users, posts, active users this week | each active node's public `/api/stats` | **what the nodes say about themselves**; the largest value among the nodes that answered. A node can be behind, or can report anything, so the page words it as "at least" |
| actions processed | the chain: `networkActionCount(1)` of CawActions on Base Sepolia | the same for every node (posts, likes, follows and so on) |
| CAW in deposit | the chain: the CAW balance of CawProfile on Sepolia | the CAW held by the CawProfile contract |

The two chain numbers read the testnet deployment of `GilgameshCaw/Caw` master `97cd13f3`. If the contracts are
deployed again, they keep reading the old ones until `CHAIN` in `lib.mjs` is updated. These are testnet numbers
(test accounts, a test token with a huge supply): they say what the testnet holds now, not how much the network
is used.

## What a run does

- Takes the registry (`/api/instances`) from the first seed node in `spotcheck/targets.json` that answers, and
  keeps the active nodes, at most 40, once each.
- Every address is untrusted: https only, a real host name (no IP address, no internal name, no port, no user name),
  a name that resolves to a private address is refused, redirects are not followed, and every request has a
  time and a size limit (the same checks as the spot check, `spotcheck/net.js`).
- Asks each node for `/api/stats` once (four at a time). Only plausible whole numbers are kept.
- Reads the two chain numbers with `eth_call` from public RPC endpoints.
- Adds one entry per UTC day to the history of the previous file (a second run on the same day replaces it; at most 400 days).
- If nothing at all could be read, nothing is written and the previous file stays.

## Opt-out

A node operator can ask to be left out: add the host name to `spotcheck/optout.txt` (one per line). A left-out
node is neither contacted nor counted. (The same list is used by the spot check.)

## Run it

Node 20 or newer. No dependencies.

```
node netstats/collect.mjs --seeds spotcheck/targets.json --optout spotcheck/optout.txt --out network.json
node netstats/collect.mjs --seeds spotcheck/targets.json --previous network.json --out network.json
```

Tests: `cd netstats && npm test`.

## License

MIT, see the `LICENSE` of the repository.
