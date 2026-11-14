# CAW Node Portal (mock)

A single static page that lists CAW nodes and measures, from the visitor's browser, the round-trip time to each one every 5 seconds.

**Open it: https://caw-lab.github.io/caw-node-portal/**

This is an unofficial mock. The page starts from a snapshot of `/api/instances` taken on 2026-10-25 (duplicate registrations removed), then builds the list live: the visitor's browser fetches `/api/instances` from every node on the page and merges the lists. Comments are placeholders.

Live list:

- An entry shows "Listed by M of N nodes": how many of the nodes with a complete list have that registration in their registry data. It is not a vote. An entry that only one node has is just that node's claim.
- A node whose list is empty, or much shorter than the median (less than half), gets a "Some issues" badge and is left out of M and N; otherwise a node that lists only its own registrations would look like the best-agreed entry. The badge is about the list that node returns (for example its registry sync), not a verdict on the whole node.
- Cards are ordered: responding nodes with a complete list first, then the ones with "Some issues", then the ones that did not answer (by name within each group).
- New URLs found in the lists are added (up to 40 cards) and measured too.
- Only plain `https://` hostnames are measured or linked: no other scheme, port, credentials, path, IP address or internal name. Anyone can register any string in the registry, so this keeps the page from being used to open `javascript:` links or to probe the visitor's local network. Entries with other URLs are counted, not shown.

## Use

Open https://caw-lab.github.io/caw-node-portal/ in a browser. No build step, no server, nothing to install.

The page is published with GitHub Pages from the `main` branch of this repository. To run it from your own computer, download `index.html` and open the downloaded file in a browser (opening `index.html` in the repository only shows its source).

## Scope

The page only does what a single HTML file can do on its own, in the visitor's browser. There is no server component, and none is needed at this stage. Adding more features (for example, reading a node's health or statistics, or keeping a shared curated list) would need a server, because most node endpoints cannot be read from a browser. We have decided that is not needed for now.

Two optional parts do not run in the browser; each is a scheduled GitHub Actions run. First, the file-consistency spot check (`spotcheck/`), which a scheduled run performs for a short list of nodes. It runs every hour (it was paused on 2026-11-13 and started again on 2026-11-14); see below.

Second, the network numbers (`netstats/`, once a day): a scheduled run collects the network numbers shown at the top of the page: users, posts and activity this week (what the nodes report about themselves, shown as "at least"), and the actions processed and the CAW in deposit (read from the testnet chains), with a small history. They are testnet numbers and say nothing about how much the network is really used. See [`netstats/README.md`](netstats/README.md) for how they are collected, how to opt out, and what they do not show.

Each registered node also has a link that opens a separate trial service ([caw-frontend-verify](https://github.com/Caw-Lab/caw-frontend-verify), run by one person, not by Caw-Lab) with the node's address filled in. The link only fills in the address: the check starts there, when the person presses the button, and the portal itself shows no result.

## Caution

The node list comes from the on-chain instance registry, where anyone can register any URL (`registerInstance` is permissionless). A listed node is not verified as legitimate; the page says so next to the list.

## Badges

Each card shows what can be checked from here. None of them proves that a node is legitimate.

- "Registered by its own key": the registry's `owner` (the account that sent the registration transaction) equals its `validatorAddress`, so the registrant controls that key. It does not show who runs the server behind the URL.
- "Active in registry": at least one registration for the URL is active.
- "Listed by M of N nodes" / "Not in the live lists": see the live list above.
- "Responding": measured live, from the visitor's browser.
- "Hand-picked": nodes we chose by hand, shown apart from the registry list.
- File consistency (monitoring): only for the nodes in `spotcheck/targets.json`, and only while a status file exists. A scheduled run downloads some of the files a node serves and compares them with that node's own file list. It notices accidents (a partial or stale deployment, a damaged file); it does not show that a node is trustworthy or serves the official code. The section is hidden while no status file exists. See [`spotcheck/README.md`](spotcheck/README.md) for how it works, how to opt out, and how to pause it.

## Not included

- The CAW logo and the Fraunces font. The upstream repository has no license file, so the logo is not redistributed here. Without them the page falls back to Georgia/serif and shows no logo.
- Latency is measured by the browser, so a node must allow cross-origin requests (CORS) to be measured.

## License

MIT, see [`LICENSE`](LICENSE). Copyright (c) 2026 zinsanjp and contributors. The CAW logo and the Fraunces font are not part of this repository and are not covered by it (see "Not included").
