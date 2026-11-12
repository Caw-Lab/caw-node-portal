#!/usr/bin/env node
// Runs the spot check on a list of nodes and writes a status file.
//
//   node spotcheck/run.mjs --portal-html index.html --out status.json
//        [--nodes extra.json] [--previous old-status.json] [--optout optout.txt]
//        [--only host1,host2] [--sample 20] [--max-nodes 40]
//
// The list of nodes is read from the NODES array in the portal page and/or from
// a JSON file (an array of addresses, or of objects with an "apiUrl"). A node
// whose host name is in the opt-out file is skipped and left out of the output.
// With --only, just the listed host names are checked; the last results of the
// other listed nodes are kept in the output.
// Exit code is 0 whatever the nodes answer; it is 1 only if the run could not
// be set up (no nodes, unreadable files).
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { checkNode } from './lib.js';
import { checkTarget, createGet } from './net.js';

const TOOL = 'spotcheck/0.1';

function parseArgs(argv) {
  const options = { sample: 20, maxNodes: 40, allowLocal: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--allow-local') options.allowLocal = true;
    else if (['--portal-html', '--nodes', '--out', '--previous', '--optout', '--only', '--sample', '--max-nodes'].includes(key)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(key + ' needs a value');
      options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else {
      throw new Error('unknown option ' + key);
    }
  }
  if (options.only !== null) {
    options.only = String(options.only)
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    if (options.only.length === 0 || options.only.some((host) => !/^[a-z0-9.-]{1,253}$/.test(host))) {
      throw new Error('--only takes host names separated by commas');
    }
  }
  options.sample = Number(options.sample);
  options.maxNodes = Number(options.maxNodes);
  if (!Number.isInteger(options.sample) || options.sample < 0 || options.sample > 200) throw new Error('--sample must be 0-200');
  if (!Number.isInteger(options.maxNodes) || options.maxNodes < 1 || options.maxNodes > 200) throw new Error('--max-nodes must be 1-200');
  if (!options.out) throw new Error('--out is required');
  if (!options.portalHtml && !options.nodes) throw new Error('give --portal-html and/or --nodes');
  return options;
}

function addressOfEntry(entry) {
  return typeof entry === 'string' ? entry : entry && typeof entry.apiUrl === 'string' ? entry.apiUrl : null;
}

function readNodeList(options) {
  const addresses = [];
  if (options.portalHtml) {
    const html = readFileSync(options.portalHtml, 'utf8');
    const match = /const NODES=(\[[\s\S]*?\]);/.exec(html);
    if (!match) throw new Error('no NODES array in ' + options.portalHtml);
    for (const entry of JSON.parse(match[1])) addresses.push(addressOfEntry(entry));
  }
  if (options.nodes) {
    for (const entry of JSON.parse(readFileSync(options.nodes, 'utf8'))) addresses.push(addressOfEntry(entry));
  }
  return addresses.filter(Boolean);
}

function readOptOut(path) {
  if (!path || !existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim().toLowerCase())
      .filter(Boolean),
  );
}

function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const previous = options.previous && existsSync(options.previous) ? JSON.parse(readFileSync(options.previous, 'utf8')) : { nodes: {} };
  const optOut = readOptOut(options.optout);
  const get = createGet({ allowLocal: options.allowLocal });

  const listed = []; // every node on the list (opt-outs left out)
  const origins = []; // the ones to check in this run
  const skipped = [];
  for (const address of readNodeList(options)) {
    try {
      const origin = checkTarget(address, { allowLocal: options.allowLocal });
      const host = new URL(origin).hostname.toLowerCase();
      if (optOut.has(host)) continue;
      if (!listed.includes(origin)) listed.push(origin);
      if (options.only && !options.only.includes(host)) continue;
      if (!origins.includes(origin)) origins.push(origin);
    } catch (error) {
      skipped.push({ address: String(address).slice(0, 80), reason: error.message });
    }
  }
  if (origins.length === 0) throw new Error('no nodes to check');
  const selected = origins.slice(0, options.maxNodes);

  const nodes = {};
  for (const origin of selected) {
    const startedAt = new Date().toISOString();
    const result = await withTimeout(
      checkNode(origin, { get, sampleSize: options.sample, previous: previous.nodes?.[origin] ?? null }),
      180000,
      () => ({ origin, state: 'unreachable', checkedAt: startedAt, message: 'timed out' }),
    );
    nodes[origin] = result;
    const counts = result.counts ? ` ${result.counts.matched}/${result.checked} ok` : '';
    console.log(`${result.state.padEnd(12)} ${origin} ${result.clientVersion ?? ''}${counts}`);
  }

  // Keep the last result of every listed node that was not checked in this run
  // (a run limited with --only must not wipe the others); drop nodes that are no longer listed.
  const merged = {};
  for (const origin of listed) {
    if (nodes[origin]) merged[origin] = nodes[origin];
    else if (previous.nodes?.[origin]) merged[origin] = previous.nodes[origin];
  }
  const output = { tool: TOOL, generatedAt: new Date().toISOString(), sampleSize: options.sample, skipped, nodes: merged };
  writeFileSync(options.out + '.tmp', JSON.stringify(output, null, 2) + '\n');
  renameSync(options.out + '.tmp', options.out);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.values(nodes).map(
      (r) => `| ${r.origin} | ${r.state} | ${r.clientVersion ?? ''} | ${r.counts ? `${r.counts.matched}/${r.checked}` : ''} |`,
    );
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ['## Spot check', '', '| node | state | version | files ok |', '|---|---|---|---|', ...rows, ''].join('\n'),
    );
  }
}

main().catch((error) => {
  console.error('error:', error.message);
  process.exit(1);
});
