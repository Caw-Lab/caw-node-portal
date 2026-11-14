import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGet } from '../../spotcheck/net.js';
import {
  CHAIN, aggregate, buildEntry, buildFile, collectChain, collectNodes, entryScript, ethCall, hasData, looksLikeHtml, mergeHistory, nodesFromRegistry, parseStats, probeFrontend, utcDate,
} from '../lib.mjs';

// A fake node: /api/stats answers `stats` (a string or an object), /api/instances answers `instances`.
async function startNode({ stats, statsStatus = 200, instances } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/api/stats') {
      res.writeHead(statsStatus, { 'content-type': 'application/json' });
      res.end(typeof stats === 'string' ? stats : JSON.stringify(stats ?? {}));
    } else if (req.url === '/api/instances' && instances !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(typeof instances === 'string' ? instances : JSON.stringify({ networkId: 1, instances }));
    } else {
      res.writeHead(404);
      res.end('no');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, hits, close: () => new Promise((resolve) => server.close(resolve)) };
}

const get = createGet({ allowLocal: true, timeoutMs: 3000 });
const entry = (apiUrl, active = true) => ({ instanceId: 1, apiUrl, validatorAddress: '0x' + '1'.repeat(40), owner: '0x' + '1'.repeat(40), active });

test('parseStats keeps plausible whole numbers and drops the rest', () => {
  assert.deepEqual(parseStats('{"totalUsers":69,"totalPosts":618,"postsToday":0,"activeUsersThisWeek":3,"totalCawBurned":"2397730000000"}'),
    { users: 69, posts: 618, postsToday: 0, activeWeek: 3 });
  assert.deepEqual(parseStats('{"totalUsers":-1,"totalPosts":1.5,"postsToday":"7","activeUsersThisWeek":1e15}'), null);
  assert.deepEqual(parseStats('{"totalUsers":5,"totalPosts":null}'), { users: 5 });
  for (const bad of ['', 'not json', '[]', 'null', '5', '{}']) assert.equal(parseStats(bad), null);
});

test('aggregate takes the largest value of each number among the answers', () => {
  assert.deepEqual(aggregate([{ users: 5, posts: 10 }, { users: 69, posts: 3, activeWeek: 2 }, {}]),
    { users: 69, posts: 10, postsToday: null, activeWeek: 2 });
  assert.deepEqual(aggregate([]), { users: null, posts: null, postsToday: null, activeWeek: null });
});

test('the registry gives unique active nodes; refused and opted-out addresses are not kept', () => {
  const text = JSON.stringify({ instances: [
    entry('https://a.example'), entry('https://a.example/'), entry('https://b.example', false), entry('https://c.example'),
    entry('https://10.0.0.1'), entry('https://localhost'), entry('http://d.example'), entry('https://e.example:8443'), entry('https://user@f.example'), entry('http://127.0.0.1:8080'), entry('http://localhost'),
    { active: true }, null, entry(5),
  ] });
  const r = nodesFromRegistry(text, { optout: new Set(['c.example']) });
  assert.deepEqual(r.origins, ['https://a.example']);
  assert.equal(r.refused, 7);
  assert.equal(nodesFromRegistry(text, { allowLocal: true }).origins.length, 4, 'only the tests may allow a local address');
  assert.equal(nodesFromRegistry('nope'), null);
  assert.equal(nodesFromRegistry('{"instances":5}'), null);
});

test('the number of nodes is capped', () => {
  const text = JSON.stringify({ instances: Array.from({ length: 100 }, (_, i) => entry(`https://n${i}.example`)) });
  assert.equal(nodesFromRegistry(text, { maxNodes: 7 }).origins.length, 7);
});

test('collectNodes asks every active node once and keeps the largest numbers', async () => {
  const a = await startNode({ stats: { totalUsers: 69, totalPosts: 618, postsToday: 0, activeUsersThisWeek: 3 } });
  const b = await startNode({ stats: { totalUsers: 12, totalPosts: 900, postsToday: 4, activeUsersThisWeek: 1 } });
  const broken = await startNode({ stats: 'not json' });
  const failing = await startNode({ stats: {}, statsStatus: 500 });
  const seed = await startNode({ instances: [entry(a.origin), entry(a.origin + '/'), entry(b.origin), entry(broken.origin), entry(failing.origin), entry(a.origin, false)] });
  try {
    const r = await collectNodes({ seeds: [seed.origin], get, optout: new Set(), allowLocal: true });
    assert.equal(r.asked, 4);
    assert.equal(r.answered, 2);
    assert.deepEqual(r.numbers, { users: 69, posts: 900, postsToday: 4, activeWeek: 3 });
    assert.equal(a.hits.filter((u) => u === '/api/stats').length, 1);
  } finally {
    await Promise.all([a, b, broken, failing, seed].map((n) => n.close()));
  }
});

test('an opted-out node is never contacted, and a seed that fails is skipped', async () => {
  const quiet = await startNode({ stats: { totalUsers: 1 } });
  const dead = await startNode({ instances: 'nope' });
  const seed = await startNode({ instances: [entry(quiet.origin)] });
  try {
    const r = await collectNodes({ seeds: [dead.origin, seed.origin], get, optout: new Set(['127.0.0.1']), allowLocal: true });
    assert.equal(r.asked, 0);
    assert.equal(quiet.hits.length, 0);
    const again = await collectNodes({ seeds: [dead.origin, seed.origin], get, optout: new Set(), allowLocal: true });
    assert.equal(again.asked, 1);
    assert.equal(again.numbers.users, 1);
  } finally {
    await Promise.all([quiet, dead, seed].map((n) => n.close()));
  }
});

test('with no seed that answers, nothing is asked', async () => {
  const r = await collectNodes({ seeds: ['https://localhost'], get, optout: new Set() });
  assert.deepEqual(r, { asked: 0, answered: 0, refused: 0, numbers: { users: null, posts: null, postsToday: null, activeWeek: null }, frontends: {} });
});

// ---------------------------------------------------------------- the chain reads
const rpcAnswer = (result) => async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });

test('ethCall reads a number and gives null for anything else', async () => {
  assert.equal(await ethCall(CHAIN.actions, { fetchImpl: rpcAnswer('0x633') }), 1587n);
  assert.equal(await ethCall(CHAIN.actions, { fetchImpl: rpcAnswer('0x') }), null);
  assert.equal(await ethCall(CHAIN.actions, { fetchImpl: rpcAnswer('hello') }), null);
  assert.equal(await ethCall(CHAIN.actions, { fetchImpl: rpcAnswer('0x' + 'f'.repeat(65)) }), null);
  assert.equal(await ethCall(CHAIN.actions, { fetchImpl: async () => ({ ok: false, text: async () => '' }) }), null);
  assert.equal(await ethCall(CHAIN.actions, { fetchImpl: async () => { throw new Error('down'); } }), null);
  assert.equal(await ethCall(CHAIN.actions, { fetchImpl: async () => ({ ok: true, text: async () => 'x'.repeat(5000) }) }), null);
});

test('the chain calls read the two contracts, and a failing one does not stop the other', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, to: body.params[0].to, data: body.params[0].data.slice(0, 10), redirect: init.redirect });
    if (url === CHAIN.deposits.rpc) return { ok: false, text: async () => '' };
    return { ok: true, text: async () => JSON.stringify({ result: '0x633' }) };
  };
  const r = await collectChain({ fetchImpl });
  assert.deepEqual(r, { actions: 1587, depositedWei: null });
  assert.deepEqual(seen.map((s) => s.data).sort(), ['0x70a08231', '0xbe17131d']);
  assert.ok(seen.every((s) => s.redirect === 'error'));
  const ok = await collectChain({ fetchImpl: async (url) => ({ ok: true, text: async () => JSON.stringify({ result: url === CHAIN.deposits.rpc ? '0x' + (11n * 10n ** 36n).toString(16) : '0x1' }) }) });
  assert.equal(ok.depositedWei, (11n * 10n ** 36n).toString());
  assert.equal(CHAIN.actions.data.length, 2 + 8 + 64);
  assert.equal(CHAIN.deposits.data.length, 2 + 8 + 64);
});

// ---------------------------------------------------------------- the file
const day = (s) => Date.parse(s + 'T12:00:00Z');
const nodes = (users, posts) => ({ asked: 9, answered: 8, refused: 0, numbers: { users, posts, postsToday: 0, activeWeek: 3 } });
const chain = { actions: 1587, depositedWei: '1000' };

test('one entry per UTC day: appended, replaced on the same day, oldest first, capped', () => {
  const e1 = buildEntry({ now: day('2026-11-14'), nodes: nodes(69, 618), chain });
  const f1 = buildFile({ now: day('2026-11-14'), entry: e1, previous: null });
  assert.equal(f1.latest.date, '2026-11-14');
  assert.equal(f1.history.length, 1);
  const e2 = buildEntry({ now: day('2026-11-15'), nodes: nodes(70, 620), chain });
  const f2 = buildFile({ now: day('2026-11-15'), entry: e2, previous: f1 });
  assert.deepEqual(f2.history.map((h) => h.date), ['2026-11-14', '2026-11-15']);
  const e2b = buildEntry({ now: day('2026-11-15'), nodes: nodes(71, 630), chain });
  const f2b = buildFile({ now: day('2026-11-15'), entry: e2b, previous: f2 });
  assert.equal(f2b.history.length, 2);
  assert.equal(f2b.history[1].users, 71);
  const older = buildEntry({ now: day('2026-11-10'), nodes: nodes(60, 500), chain });
  assert.deepEqual(buildFile({ now: day('2026-11-10'), entry: older, previous: f2b }).history.map((h) => h.date), ['2026-11-10', '2026-11-14', '2026-11-15']);
  const long = { schemaVersion: 1, history: Array.from({ length: 450 }, (_, i) => ({ ...e1, date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10) })) };
  assert.equal(mergeHistory(long, e2).length, 400);
});

test('a damaged or foreign previous file is ignored; bad entries in it are dropped', () => {
  const e = buildEntry({ now: day('2026-11-14'), nodes: nodes(1, 2), chain });
  for (const previous of [null, 'x', 5, {}, { schemaVersion: 2, history: [e] }, { schemaVersion: 1, history: 'no' }]) {
    assert.equal(mergeHistory(previous, e).length, 1);
  }
  const mixed = { schemaVersion: 1, history: [{ ...e, date: '2026-11-01' }, { ...e, date: 'bad' }, { ...e, date: '2026-11-02', users: -5 }, { ...e, date: '2026-11-03', depositedWei: '1e5' }, null] };
  assert.deepEqual(mergeHistory(mixed, e).map((h) => h.date), ['2026-11-01', '2026-11-14']);
  assert.deepEqual(Object.keys(mergeHistory(mixed, { ...e, extra: 'x' })[0]).sort(), ['actions', 'activeWeek', 'date', 'depositedWei', 'nodesAnswered', 'nodesAsked', 'posts', 'users']);
});

test('hasData is false only when nothing was read', () => {
  const none = buildEntry({ now: 0, nodes: { asked: 3, answered: 0, refused: 0, numbers: aggregate([]) }, chain: { actions: null, depositedWei: null } });
  assert.equal(hasData(none), false);
  assert.equal(hasData({ ...none, actions: 0 }), true);
  assert.equal(hasData({ ...none, depositedWei: '0' }), true);
  assert.equal(utcDate(Date.parse('2026-11-14T23:59:59Z')), '2026-11-14');
});

// ---------------------------------------------------------------- does the address serve a frontend?
test('the entry script of a page: this site, another site, or none', () => {
  assert.deepEqual(entryScript('<script type="module" crossorigin src="/assets/index-AAA.js"></script>'), { path: '/assets/index-AAA.js' });
  assert.deepEqual(entryScript('<script src="./assets/x.js?v=1#h" type=\'module\'></script>'), { path: '/assets/x.js' });
  assert.deepEqual(entryScript('<script type="module" src="https://cdn.example/app.js"></script>'), { external: true });
  assert.deepEqual(entryScript('<script type="module" src="//cdn.example/app.js"></script>'), { external: true });
  for (const none of ['', '<html></html>', '<script src="/a.js"></script>', '<script type="module">x()</script>', '<script type="module" src="/../x.js"></script>', '<script type="module" src="/a b.js"></script>']) {
    assert.equal(entryScript(none), null, none);
  }
  assert.equal(looksLikeHtml(Buffer.from('  \n<!DOCTYPE html><html>')), true);
  assert.equal(looksLikeHtml(Buffer.from('<html lang="en">')), true);
  assert.equal(looksLikeHtml(Buffer.from('import"./v.js";const h="<html>";')), false);
});

const PAGE = '<!doctype html><script type="module" src="/assets/index-AAA.js"></script>';
// A fake site: `routes` is { path: { status, type, body } }; supportsRange=false sends everything.
async function fakeSite(routes, { supportsRange = true } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, range: req.headers.range || null });
    const r = routes[req.url];
    if (!r) { res.writeHead(404); res.end('no'); return; }
    let body = r.body;
    let status = r.status ?? 200;
    if (req.headers.range && supportsRange && status === 200) { body = body.slice(0, 256); status = 206; }
    res.writeHead(status, r.type ? { 'content-type': r.type } : {});
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + server.address().port, hits, close: () => new Promise((resolve) => server.close(resolve)) };
}
const probe = async (routes, options) => {
  const site = await fakeSite(routes, options);
  try {
    return { state: await probeFrontend({ get, origin: site.origin }), hits: site.hits };
  } finally {
    await site.close();
  }
};
const HTML = 'text/html; charset=utf-8';
const JS = 'text/javascript';

test('a page whose script comes back as a script is served; only the first bytes are asked for', async () => {
  const r = await probe({ '/': { type: HTML, body: PAGE }, '/assets/index-AAA.js': { type: JS, body: 'const a=1;'.repeat(100) } });
  assert.equal(r.state, 'served');
  assert.deepEqual(r.hits.map((h) => h.range), [null, 'bytes=0-255']);
  assert.equal((await probe({ '/': { type: HTML, body: PAGE }, '/assets/index-AAA.js': { type: 'application/javascript', body: 'x=1' } })).state, 'served');
});

test('a script that comes back as the HTML page, or is missing, means no frontend is served (api-only)', async () => {
  assert.equal((await probe({ '/': { type: HTML, body: PAGE }, '/assets/index-AAA.js': { type: HTML, body: PAGE } })).state, 'api-only');
  assert.equal((await probe({ '/': { type: HTML, body: PAGE }, '/assets/index-AAA.js': { type: 'application/octet-stream', body: '  <!doctype html><html>' } })).state, 'api-only');
  assert.equal((await probe({ '/': { type: HTML, body: PAGE }, '/assets/index-AAA.js': { type: JS, body: '<!doctype html><html>' } })).state, 'api-only'); // labelled as a script, but a page
  assert.equal((await probe({ '/': { type: HTML, body: PAGE } })).state, 'api-only'); // the script answers 404
  assert.equal((await probe({})).state, 'api-only'); // no page at all
  assert.equal((await probe({ '/': { type: 'application/json', body: '{"ok":true}' } })).state, 'api-only');
  assert.equal((await probe({ '/': { type: HTML, body: '<html><body>hello</body></html>' } })).state, 'api-only'); // a page with no script
});

test('when the answers do not say, nothing is claimed (unknown)', async () => {
  assert.equal((await probe({ '/': { status: 500, type: HTML, body: 'x' } })).state, 'unknown');
  assert.equal((await probe({ '/': { status: 302, type: HTML, body: 'x' } })).state, 'unknown');
  assert.equal((await probe({ '/': { type: HTML, body: PAGE }, '/assets/index-AAA.js': { status: 500, type: JS, body: 'x' } })).state, 'unknown');
  assert.equal((await probe({ '/': { type: HTML, body: '<script type="module" src="https://cdn.example/a.js"></script>' } })).state, 'unknown');
  assert.equal(await probeFrontend({ get: async () => { throw new Error('down'); }, origin: 'https://x.example' }), 'unknown');
});

test('a big script from a server that ignores the range is still a script, not the small fallback page', async () => {
  const r = await probe({ '/': { type: HTML, body: PAGE }, '/assets/index-AAA.js': { type: JS, body: 'a'.repeat(200000) } }, { supportsRange: false });
  assert.equal(r.state, 'served');
});

test('collectNodes records which nodes serve a frontend, and leaves out the ones it cannot tell', async () => {
  const a = await fakeSite({ '/': { type: HTML, body: PAGE }, '/assets/index-AAA.js': { type: JS, body: 'x=1' }, '/api/stats': { type: 'application/json', body: '{"totalUsers":5}' } });
  const b = await fakeSite({ '/': { type: HTML, body: PAGE }, '/assets/index-AAA.js': { type: HTML, body: PAGE }, '/api/stats': { type: 'application/json', body: '{"totalUsers":7}' } });
  const c = await fakeSite({ '/': { status: 500, type: HTML, body: 'x' } });
  const seed = await startNode({ instances: [entry(a.origin), entry(b.origin), entry(c.origin)] });
  try {
    const r = await collectNodes({ seeds: [seed.origin], get, optout: new Set(), allowLocal: true });
    assert.deepEqual(r.frontends, { [a.origin]: 'served', [b.origin]: 'api-only' });
    const file = buildFile({ now: day('2026-11-14'), entry: buildEntry({ now: day('2026-11-14'), nodes: r, chain }), previous: null, frontends: r.frontends });
    assert.deepEqual(file.frontends, r.frontends);
    assert.deepEqual(buildFile({ now: day('2026-11-14'), entry: buildEntry({ now: day('2026-11-14'), nodes: r, chain }), previous: null }).frontends, {});
  } finally {
    await Promise.all([a, b, c, seed].map((n) => n.close()));
  }
});

test('an opted-out node is not asked for its page either', async () => {
  const quiet = await fakeSite({ '/': { type: HTML, body: PAGE } });
  const seed = await startNode({ instances: [entry(quiet.origin)] });
  try {
    const r = await collectNodes({ seeds: [seed.origin], get, optout: new Set(['127.0.0.1']), allowLocal: true });
    assert.equal(r.asked, 0);
    assert.deepEqual(quiet.hits, []);
  } finally {
    await Promise.all([quiet, seed].map((n) => n.close()));
  }
});
