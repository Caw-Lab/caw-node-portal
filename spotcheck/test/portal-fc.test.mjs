import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// The file is a classic script: run it the way a page does and take the global it makes.
function load() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(path.join(import.meta.dirname, '..', 'portal-fc.js'), 'utf8'), context);
  return context.FC;
}
const FC = load();
// Objects made inside the vm are of another realm; compare their content only.
const plain = (value) => JSON.parse(JSON.stringify(value));

// the page's own check, reduced: https, no port, no path
const safeUrl = (u) => {
  try {
    const x = new URL(u);
    const ip = /^\d+(\.\d+){3}$/.test(x.hostname);
    return x.protocol === 'https:' && !x.port && x.pathname === '/' && x.hostname.includes('.') && !ip ? x.origin : null;
  } catch {
    return null;
  }
};

const good = {
  state: 'consistent',
  checkedAt: '2026-11-12T08:12:43.051Z',
  clientVersion: '97cd13f3+dirty',
  fileCount: 359,
  checked: 35,
  counts: { matched: 35, mismatched: 0, missing: 0, errored: 0 },
  complete: true,
  indexHtml: 'exact',
  versionChanged: false,
  externalScripts: ['https://fonts.googleapis.com/css2'],
  problems: [],
  history: [{ at: '2026-11-12T08:12:43.051Z', clientVersion: '97cd13f3+dirty', manifestHash: 'abc' }],
};

test('a good status file is read, keyed by the node address', () => {
  const status = FC.parse({ generatedAt: '2026-11-12T08:12:43.051Z', nodes: { 'https://cawnest.com': good } }, safeUrl);
  assert.equal(status.nodes.size, 1);
  const result = status.nodes.get('https://cawnest.com');
  assert.equal(result.state, 'consistent');
  assert.equal(result.checked, 35);
  assert.deepEqual(plain(result.external), ['https://fonts.googleapis.com/css2']);
  assert.equal(result.history.length, 1);
});

test('the older field name externalScripts and the newer externalResources both work', () => {
  const a = FC.parse({ nodes: { 'https://a.example': { ...good, externalScripts: ['x'] } } }, safeUrl).nodes.get('https://a.example');
  const b = FC.parse({ nodes: { 'https://a.example': { ...good, externalScripts: undefined, externalResources: ['y'] } } }, safeUrl).nodes.get('https://a.example');
  assert.deepEqual(plain(a.external), ['x']);
  assert.deepEqual(plain(b.external), ['y']);
});

test('entries with an unknown state, or for an address the page does not allow, are dropped', () => {
  const status = FC.parse(
    {
      nodes: {
        'https://ok.example': good,
        'https://bad-state.example': { ...good, state: 'compromised' },
        'http://plain.example': good,
        'https://with-port.example:8443': good,
        'javascript:alert(1)': good,
        'https://127.0.0.1': good,
      },
    },
    safeUrl,
  );
  assert.deepEqual(plain([...status.nodes.keys()]), ['https://ok.example']);
});

test('anything that is not a status file gives null', () => {
  for (const bad of [null, 'text', 42, [], {}, { nodes: null }, { nodes: 'x' }]) assert.equal(FC.parse(bad, safeUrl), null);
});

test('strings are cut, numbers must be numbers, odd list entries are dropped', () => {
  const nasty = {
    ...good,
    clientVersion: 'v'.repeat(500),
    fileCount: '359',
    checked: -5,
    counts: { matched: 1.5, mismatched: Infinity, missing: null, errored: '2' },
    indexHtml: '<script>',
    problems: [{ path: '<img src=x onerror=alert(1)>', state: 'mismatched' }, { path: 'a.js', state: 'owned' }, null, 'x', ...Array.from({ length: 30 }, (_, i) => ({ path: 'f' + i, state: 'missing' }))],
    history: [null, 'x', { at: 'not a date', clientVersion: 1, manifestHash: 'h'.repeat(200) }],
    externalScripts: [1, null, 'https://ok.example/x.css'],
  };
  const result = FC.parse({ nodes: { 'https://n.example': nasty } }, safeUrl).nodes.get('https://n.example');
  assert.equal(result.clientVersion.length, 80);
  assert.equal(result.fileCount, 0);
  assert.equal(result.checked, 0);
  assert.deepEqual(plain(result.counts), { matched: 0, mismatched: 0, missing: 0, errored: 0 });
  assert.equal(result.indexHtml, '');
  assert.equal(result.problems.length, 10); // the bad ones are dropped, then the list is cut
  assert.ok(result.problems.every((p) => ['mismatched', 'missing'].includes(p.state)));
  assert.equal(result.problems[0].path, '<img src=x onerror=alert(1)>'); // kept as plain text; the page uses textContent
  assert.deepEqual(plain(result.history), [{ at: '', clientVersion: '', manifestHash: 'h'.repeat(64) }]);
  assert.deepEqual(plain(result.external), ['https://ok.example/x.css']);
});

test('every state has a badge colour and a text key', () => {
  for (const state of ['consistent', 'inconsistent', 'changed', 'no-list', 'unreachable']) {
    assert.ok(FC.BADGE[state] && typeof FC.BADGE[state].key === 'string' && typeof FC.BADGE[state].cls === 'string', state);
  }
  assert.equal(FC.BADGE.consistent.cls, 'ok');
  assert.equal(FC.BADGE.inconsistent.cls, 'warn'); // never red
});

test('ago: minutes, hours, days, and nothing for a bad date', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.deepEqual(plain(FC.ago('2026-11-12T11:48:00Z', now)), { unit: 'minute', n: 12 });
  assert.deepEqual(plain(FC.ago('2026-11-12T12:00:00Z', now)), { unit: 'minute', n: 1 });
  assert.deepEqual(plain(FC.ago('2026-11-12T08:00:00Z', now)), { unit: 'hour', n: 4 });
  assert.deepEqual(plain(FC.ago('2026-11-09T12:00:00Z', now)), { unit: 'day', n: 3 });
  assert.equal(FC.ago('nope', now), null);
});
