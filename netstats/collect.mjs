#!/usr/bin/env node
// Collects the network numbers for the portal and writes network.json.
//
//   node netstats/collect.mjs --seeds spotcheck/targets.json --out network.json
//        [--previous old-network.json] [--optout spotcheck/optout.txt] [--max-nodes 40] [--allow-local]
//
// --seeds is a JSON array of node addresses (or of objects with an "apiUrl"); the first one that answers gives the
// registry (/api/instances). A host name in the opt-out file is never contacted. --previous is the file of the
// last run: its history is kept and today's entry is added.
// Exit code: 0 when at least one number was read, 2 when nothing could be read (nothing is written), 1 when the
// run could not be set up.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createGet } from '../spotcheck/net.js';
import { LIMITS, buildEntry, buildFile, collectChain, collectNodes, hasData } from './lib.mjs';

function parseArgs(argv) {
  const options = { maxNodes: LIMITS.maxNodes, allowLocal: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--allow-local') options.allowLocal = true;
    else if (['--seeds', '--out', '--previous', '--optout', '--max-nodes'].includes(key)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(key + ' needs a value');
      options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else {
      throw new Error('unknown option ' + key);
    }
  }
  options.maxNodes = Number(options.maxNodes);
  if (!Number.isInteger(options.maxNodes) || options.maxNodes < 1 || options.maxNodes > 200) throw new Error('--max-nodes must be 1-200');
  if (!options.out) throw new Error('--out is required');
  if (!options.seeds) throw new Error('--seeds is required');
  return options;
}

function readOptout(path) {
  const set = new Set();
  if (!path || !existsSync(path)) return set;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const host = line.trim().toLowerCase();
    if (host && !host.startsWith('#')) set.add(host);
  }
  return set;
}

function readSeeds(path) {
  const list = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(list)) throw new Error('--seeds must be a JSON array');
  return list.map((entry) => (typeof entry === 'string' ? entry : entry && typeof entry.apiUrl === 'string' ? entry.apiUrl : null)).filter(Boolean);
}

function readPrevious(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // a damaged file is not worth stopping for; the history starts again
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error('netstats: ' + error.message);
    return 1;
  }
  let seeds;
  try {
    seeds = readSeeds(options.seeds);
  } catch (error) {
    console.error('netstats: cannot read the seeds: ' + error.message);
    return 1;
  }
  const get = createGet({ allowLocal: options.allowLocal, userAgent: 'caw-node-portal-netstats/0.1 (+https://github.com/Caw-Lab/caw-node-portal)' });
  const now = Date.now();
  const [nodes, chain] = await Promise.all([
    collectNodes({ seeds, get, optout: readOptout(options.optout), allowLocal: options.allowLocal, maxNodes: options.maxNodes }),
    collectChain(),
  ]);
  const entry = buildEntry({ now, nodes, chain });
  console.log(`netstats: asked ${nodes.asked} nodes, ${nodes.answered} answered, ${nodes.refused} addresses refused; chain: actions ${chain.actions}, deposits ${chain.depositedWei === null ? 'none' : 'read'}; frontends: ${Object.values(nodes.frontends).filter((v) => v === 'served').length} served, ${Object.values(nodes.frontends).filter((v) => v === 'api-only').length} api-only`);
  if (!hasData(entry)) {
    console.error('netstats: nothing could be read; nothing is written');
    return 2;
  }
  const file = buildFile({ now, entry, previous: readPrevious(options.previous), frontends: nodes.frontends });
  writeFileSync(options.out + '.tmp', JSON.stringify(file, null, 1) + '\n');
  renameSync(options.out + '.tmp', options.out);
  console.log(`netstats: wrote ${options.out} (${file.history.length} days in the history)`);
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error('netstats: ' + (error && error.message));
  process.exit(1);
});
