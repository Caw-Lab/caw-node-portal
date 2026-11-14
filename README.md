# CAW Node Portal

A single static page that lists CAW nodes and measures, from the visitor's browser, the round-trip time to each one every 5 seconds.

**Open it: https://caw-lab.github.io/caw-node-portal/**

This is an unofficial trial version. The page starts from a snapshot of `/api/instances` taken on 2026-10-25 (duplicate registrations removed), then builds the list live: the visitor's browser fetches `/api/instances` from every node on the page and merges the lists. Comments are placeholders.

Live list:

- An entry shows "Listed by M of N nodes": how many of the nodes with a complete list have that registration in their registry data. It is not a vote. An entry that only one node has is just that node's claim.
- A node whose list is empty, or much shorter than the median (less than half), gets a "Some issues" badge and is left out of M and N; otherwise a node that lists only its own registrations would look like the best-agreed entry. The badge is about the list that node returns (for example its registry sync), not a verdict on the whole node.
- Rows are ordered: responding nodes with a complete list first, then the ones with "Some issues", then the ones that did not answer (by name within each group). The mainline node stays at the top. Other orders, chosen by the visitor: fastest first (by the average of the last measurements, in 100 ms steps), most listed, and monitored files first (the nodes of `spotcheck/targets.json`, then the rest in the default order). The default order does not prefer any node, and the monitored-files order is not a recommendation: the monitored nodes are chosen by hand and the check compares a node with its own file list. An API-only node is always last.
- New URLs found in the lists are added (up to 40 rows) and measured too.
- Only plain `https://` hostnames are measured or linked: no other scheme, port, credentials, path, IP address or internal name. Anyone can register any string in the registry, so this keeps the page from being used to open `javascript:` links or to probe the visitor's local network. Entries with other URLs are counted, not shown.

## Use

Open https://caw-lab.github.io/caw-node-portal/ in a browser. No build step, no server, nothing to install.

The page is published with GitHub Pages from the `main` branch of this repository. To run it from your own computer, download `index.html` and open the downloaded file in a browser (opening `index.html` in the repository only shows its source).

## Scope

The page only does what a single HTML file can do on its own, in the visitor's browser. There is no server component, and none is needed at this stage. Adding more features (for example, reading a node's health or statistics, or keeping a shared curated list) would need a server, because most node endpoints cannot be read from a browser. We have decided that is not needed for now.

Two optional parts do not run in the browser; each is a scheduled GitHub Actions run. First, the file-consistency spot check (`spotcheck/`), which a scheduled run performs for a short list of nodes. It runs every hour (it was paused on 2026-11-13 and started again on 2026-11-14); see below.

Second, the network numbers (`netstats/`, once a day): a scheduled run collects the network numbers shown at the top of the page: users, posts and activity this week (what the nodes report about themselves: the largest value, which can be slightly off), and the actions processed and the CAW in deposit (read from the testnet chains), with a small history. They are testnet numbers and say nothing about how much the network is really used. See [`netstats/README.md`](netstats/README.md) for how they are collected, how to opt out, and what they do not show.

Each registered node also has an "Integrity check" button that opens a separate trial service ([caw-frontend-verify](https://github.com/Caw-Lab/caw-frontend-verify), run by one person, not by Caw-Lab) with the node's address filled in. The button only fills in the address: the check starts there, when the person presses the button, and the portal itself shows no result.

## Caution

The node list comes from the on-chain instance registry, where anyone can register any URL (`registerInstance` is permissionless). A listed node is not verified as legitimate; the page says so next to the list.

## What a row shows

A row is one node: its address, the introduction its operator wrote (`comment` in the `NODES` data of `index.html`; a placeholder text is shown when there is none), the response time, and two buttons: "Open site" and "Integrity check".

- **Response time**: measured live, from the visitor's browser (a round trip to the node's `/api/instances`), with the average of the last measurements and a bar. A node that does not answer shows "No response" and a red dot.
- **Only what is not ordinary is marked.** When every node was registered by its own key and is active, the page says so once above the list; a row gets a mark only when something differs: "Registered by another key" (the registry's `owner`, the account that sent the registration, differs from its `validatorAddress`), "Inactive in registry", "Some issues" (an incomplete list), "Listed by M of N nodes" (fewer than all) or "Not in the live lists". None of them proves that a node is legitimate.
- **API only**: the address does not seem to serve a frontend (the top page may open, but the script it names comes back as an HTML page, so a visitor sees an empty screen). It is read once a day by the scheduled run of `netstats/` (a browser cannot read another site's files), and it can mean a node that only serves its API. Such a row has no "Integrity check" button and is listed last, in every order. It does not mean the node has a problem.
- **Files monitored** (monitoring, not a certificate): only for the nodes in `spotcheck/targets.json`, and only while a status file exists. A scheduled run downloads some of the files a node serves and compares them with that node's own file list. It notices accidents (a partial or stale deployment, a damaged file); it does not show that a node is trustworthy or serves the official code. "Monitoring details" shows what was checked and when. The time of the last run is in the help text under the list.
- **Integrity check** opens a separate trial service ([caw-frontend-verify](https://github.com/Caw-Lab/caw-frontend-verify), run by one person, not by Caw-Lab) with the node's address filled in. For now it only checks which contracts the site points at; a file check is planned.

The summary at the top shows the network numbers (see `netstats/README.md`) and how many nodes respond. "Total" numbers are running totals; "this week" and "current balance" are present values.

## Not included

- The CAW logo and the Fraunces font. The upstream repository has no license file, so the logo is not redistributed here. Without them the page falls back to Georgia/serif and shows no logo.
- Latency is measured by the browser, so a node must allow cross-origin requests (CORS) to be measured.

## License

MIT, see [`LICENSE`](LICENSE). Copyright (c) 2026 zinsanjp and contributors. The CAW logo and the Fraunces font are not part of this repository and are not covered by it (see "Not included").
