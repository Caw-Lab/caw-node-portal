// Network numbers for the portal: what the nodes report about themselves, and two numbers read from the chains.
//
// The list of nodes comes from the network (the registry each seed node serves at /api/instances), so every
// address is untrusted: it goes through the same checks as the spot check (https only, a real host name, no
// private address, no redirect, a time and a size limit). A node's numbers are what that node says; a lying
// node can only raise the maximum, which is why the page words them as "at least".
import { checkTarget } from '../spotcheck/net.js';

export class NoData extends Error {}

// The testnet deployment of GilgameshCaw/Caw master 97cd13f3 (2026-09-21). If the contracts are deployed again,
// these numbers keep reading the old ones until the addresses here are updated.
export const CHAIN = {
  actions: {
    rpc: 'https://base-sepolia-rpc.publicnode.com',
    to: '0x73246104f57001edc6d0659fa37afb672a76e763', // CawActions on Base Sepolia
    data: '0xbe17131d' + '1'.padStart(64, '0'), // networkActionCount(1)
  },
  deposits: {
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    to: '0x56817dc696448135203c0556f702c6a953260411', // the CAW token on Sepolia
    data: '0x70a08231' + '3ba577936ff6cfe07dc2d00e6669436c6dace319'.padStart(64, '0'), // balanceOf(CawProfile)
  },
};

export const LIMITS = { maxNodes: 40, instancesBytes: 512 * 1024, statsBytes: 16 * 1024, historyDays: 400, concurrency: 4 };
const MAX_COUNT = 1e12;

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
}

// What a node's /api/stats may contribute. Anything that is not a plausible whole number is left out.
export function parseStats(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const out = {};
  for (const [from, to] of [['totalUsers', 'users'], ['totalPosts', 'posts'], ['postsToday', 'postsToday'], ['activeUsersThisWeek', 'activeWeek']]) {
    if (isCount(data[from])) out[to] = data[from];
  }
  return Object.keys(out).length ? out : null;
}

// The active nodes of a registry answer: unique, allowed addresses only. Returns { origins, refused }.
export function nodesFromRegistry(text, { allowLocal = false, optout = new Set(), maxNodes = LIMITS.maxNodes } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.instances)) return null;
  const origins = new Set();
  let refused = 0;
  for (const item of data.instances.slice(0, 2000)) {
    if (!item || item.active !== true || typeof item.apiUrl !== 'string') continue;
    let origin;
    try {
      origin = checkTarget(item.apiUrl, { allowLocal });
    } catch {
      refused += 1;
      continue;
    }
    if (optout.has(new URL(origin).hostname.toLowerCase())) continue;
    origins.add(origin);
  }
  return { origins: [...origins].sort().slice(0, maxNodes), refused };
}

export function aggregate(answers) {
  const best = { users: null, posts: null, postsToday: null, activeWeek: null };
  for (const answer of answers) {
    for (const key of Object.keys(best)) {
      if (typeof answer[key] === 'number' && (best[key] === null || answer[key] > best[key])) best[key] = answer[key];
    }
  }
  return best;
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// get(url, { maxBytes }) => { status, bytes }, as createGet gives. Returns the per-run numbers of the nodes.
export async function collectNodes({ seeds, get, optout, allowLocal = false, maxNodes = LIMITS.maxNodes }) {
  let registry = null;
  for (const seed of seeds) {
    try {
      const origin = checkTarget(seed, { allowLocal });
      const response = await get(origin + '/api/instances', { maxBytes: LIMITS.instancesBytes });
      if (response.status !== 200) continue;
      registry = nodesFromRegistry(Buffer.from(response.bytes).toString('utf8'), { allowLocal, optout, maxNodes });
      if (registry) break;
    } catch {
      /* try the next seed */
    }
  }
  if (!registry) return { asked: 0, answered: 0, refused: 0, numbers: aggregate([]) };
  const answers = await mapLimit(registry.origins, LIMITS.concurrency, async (origin) => {
    try {
      const response = await get(origin + '/api/stats', { maxBytes: LIMITS.statsBytes });
      if (response.status !== 200) return null;
      return parseStats(Buffer.from(response.bytes).toString('utf8'));
    } catch {
      return null;
    }
  });
  const good = answers.filter(Boolean);
  return { asked: registry.origins.length, answered: good.length, refused: registry.refused, numbers: aggregate(good) };
}

// One eth_call. Returns a BigInt, or null on any failure (the numbers are optional).
export async function ethCall({ rpc, to, data }, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  try {
    const response = await fetchImpl(rpc, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'user-agent': 'caw-node-portal-netstats/0.1 (+https://github.com/Caw-Lab/caw-node-portal)' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 4096) return null;
    const result = JSON.parse(text).result;
    if (typeof result !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(result)) return null;
    return BigInt(result);
  } catch {
    return null;
  }
}

export async function collectChain({ chain = CHAIN, fetchImpl, timeoutMs } = {}) {
  const [actions, deposits] = await Promise.all([ethCall(chain.actions, { fetchImpl, timeoutMs }), ethCall(chain.deposits, { fetchImpl, timeoutMs })]);
  return {
    actions: actions !== null && actions <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(actions) : null,
    depositedWei: deposits !== null ? deposits.toString() : null,
  };
}

export const utcDate = (now) => new Date(now).toISOString().slice(0, 10);

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return false;
  for (const key of ['users', 'posts', 'activeWeek', 'actions', 'nodesAsked', 'nodesAnswered']) {
    if (entry[key] !== null && !isCount(entry[key])) return false;
  }
  return entry.depositedWei === null || (typeof entry.depositedWei === 'string' && /^\d{1,80}$/.test(entry.depositedWei));
}

const pick = (entry) => ({
  date: entry.date, users: entry.users, posts: entry.posts, activeWeek: entry.activeWeek,
  actions: entry.actions, depositedWei: entry.depositedWei, nodesAsked: entry.nodesAsked, nodesAnswered: entry.nodesAnswered,
});

// Yesterday's file plus today's entry: one entry per UTC day (a second run on the same day replaces it), oldest first.
export function mergeHistory(previous, entry, cap = LIMITS.historyDays) {
  const old = previous && previous.schemaVersion === 1 && Array.isArray(previous.history) ? previous.history.filter(validEntry).map(pick) : [];
  const byDate = new Map(old.map((e) => [e.date, e]));
  byDate.set(entry.date, pick(entry));
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-cap);
}

export function buildEntry({ now, nodes, chain }) {
  return {
    date: utcDate(now),
    users: nodes.numbers.users,
    posts: nodes.numbers.posts,
    activeWeek: nodes.numbers.activeWeek,
    actions: chain.actions,
    depositedWei: chain.depositedWei,
    nodesAsked: nodes.asked,
    nodesAnswered: nodes.answered,
  };
}

export function buildFile({ now, entry, previous }) {
  return {
    schemaVersion: 1,
    kind: 'caw-network-stats',
    generatedAt: new Date(now).toISOString(),
    note: 'Testnet. users, posts and activeWeek are the largest value among the nodes that answered (what the nodes report); actions and depositedWei are read from the chains.',
    latest: pick(entry),
    history: mergeHistory(previous, entry),
  };
}

export function hasData(entry) {
  return ['users', 'posts', 'activeWeek', 'actions', 'depositedWei'].some((key) => entry[key] !== null);
}
