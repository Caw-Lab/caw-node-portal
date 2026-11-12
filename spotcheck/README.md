# spotcheck

A light check of what a CAW node serves. Unofficial. It complements the full check that downloads every file; it does not replace it.

## What it does

Most CAW nodes publish `/build-manifest.json`: the files of their frontend build, with a SHA-256 for each. spotcheck downloads some of those files from the node and compares them with **the node's own list**:

- `index.html` (also with the node's address put back in place of the `__CAW_PUBLIC_URL__` placeholder, in case the installer replaced it);
- every script, module preload and stylesheet that `index.html` loads. If one of them is not in the list, that is reported;
- every file whose name contains `key`, `session`, `sign`, `wallet`, `passkey` or `auth` (at most 30);
- a random sample of 20 of the other files (system random source, different every run).

It also keeps a fingerprint of the list. If the list changes while the version string stays the same, it says so.

## Results

| state | meaning |
|---|---|
| `consistent` | every file that was checked matches the node's own list |
| `inconsistent` | a checked file differs from the list or is missing, or `index.html` loads a script the list does not know |
| `changed` | the files match, but the list changed under the same version string |
| `no-list` | the node publishes no `build-manifest.json` (or the answer is not a JSON file) |
| `unreachable` | the node could not be read |

The wording is deliberately neutral. `inconsistent` means "differs from the node's own list", not "bad". A file that could not be read is counted as "could not be read", never as a difference (`complete: false`).

## What it cannot tell you

- It checks the node against **its own** list. A node that changes both the files and the list passes. The history of the list helps to notice that, after the fact.
- Only a sample is downloaded. A change to one ordinary file is found with a probability of about 20/360 per run, and a change to `index.html`, a loaded script or a file with one of the names above is found every run. Repeated runs add up.
- A node can answer a checker differently from an ordinary visitor.
- It does not compare with a shared, published reference. That needs every node to build the same files, which the standard build does not do yet (the settings are built into the files).

## Run it

Node 20 or newer. No dependencies.

```
node spotcheck/run.mjs --portal-html index.html --out status.json
node spotcheck/run.mjs --nodes nodes.json --previous status.json --out status.json
```

`--portal-html` reads the `NODES` array of the portal page; `--nodes` reads a JSON array of addresses (or of objects with an `apiUrl`). Other options: `--optout file`, `--only host1,host2` (check just these hosts, for a first small run), `--sample N` (default 20), `--max-nodes N` (default 40). The exit code is 0 whatever the nodes answer, and 1 if the run could not be set up.

Tests: `cd spotcheck && npm test`.

## Opt-out

A node operator can ask to be left out: add the host name to `optout.txt` (one per line). Left-out nodes are neither contacted nor listed.

## Safety of the run

The list of nodes comes from the network, so each address is treated as untrusted:

- https only, no user name, no port, a real host name (no IP address, no `localhost`, no internal-looking names);
- the address a name resolves to is checked when the connection is made; private, loopback and link-local addresses are refused;
- redirects are not followed;
- every request has a time limit (12 s) and a size limit (2 MB for the list and `index.html`, 8 MB for a file); compressed answers are unpacked up to the same limit;
- at most 4 requests at a time per node, nodes one after the other, about 40 requests per node and run;
- the requests say who is asking (`caw-node-portal-spotcheck`, with the address of this repository) and send no cookies.

## License

MIT, see `LICENSE`.
