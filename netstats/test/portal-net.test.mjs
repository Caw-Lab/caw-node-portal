import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// The file is a classic script: run it the way a page does and take the global it makes.
function load() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(path.join(import.meta.dirname, '..', 'portal-net.js'), 'utf8'), context);
  return context.NET;
}
const NET = load();
const plain = (value) => JSON.parse(JSON.stringify(value));

const entry = (over = {}) => ({ date: '2026-11-14', users: 69, posts: 618, activeWeek: 3, actions: 1587, depositedWei: '11000004229162450356202134848238889270', nodesAsked: 9, nodesAnswered: 9, ...over });
const file = (over = {}) => ({ schemaVersion: 1, kind: 'caw-network-stats', generatedAt: '2026-11-14T03:41:07.000Z', latest: entry(), history: [entry()], ...over });

test('a good file is read; numbers and dates are checked', () => {
  const r = plain(NET.parse(file()));
  assert.equal(r.latest.users, 69);
  assert.equal(r.generatedAt, '2026-11-14');
  assert.equal(r.history.length, 1);
});

test('bad numbers become null, bad entries are dropped, a foreign file is refused', () => {
  const r = plain(NET.parse(file({ latest: entry({ users: -1, posts: 1.5, activeWeek: '3', actions: 1e13, depositedWei: '1e5' }) })));
  assert.deepEqual([r.latest.users, r.latest.posts, r.latest.activeWeek, r.latest.actions, r.latest.depositedWei], [null, null, null, null, null]);
  const h = plain(NET.parse(file({ history: [entry(), { date: 'x' }, null, 5, entry({ date: '2026-11-15' })] })));
  assert.deepEqual(h.history.map((e) => e.date), ['2026-11-14', '2026-11-15']);
  for (const bad of [null, 5, 'x', {}, file({ schemaVersion: 2 }), file({ kind: 'other' }), file({ latest: null }), file({ latest: { date: 'bad' } })]) {
    assert.equal(NET.parse(bad), null);
  }
  assert.equal(plain(NET.parse(file({ generatedAt: 'yesterday' }))).generatedAt, '2026-11-14');
  assert.equal(NET.parse(file({ history: 'no' })).history.length, 0);
});

test('only the last 400 days of the history are used', () => {
  const long = Array.from({ length: 450 }, (_, i) => entry({ date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10) }));
  assert.equal(NET.parse(file({ history: long })).history.length, 400);
});

test('the CAW held is shown grouped, and in powers of ten when it is huge', () => {
  assert.equal(NET.formatCaw('0'), '0');
  assert.equal(NET.formatCaw('1000000000000000000'), '1');
  assert.equal(NET.formatCaw((1234567n * 10n ** 18n).toString()), '1,234,567');
  assert.equal(NET.formatCaw((999999999n * 10n ** 18n).toString()), '999,999,999');
  assert.equal(NET.formatCaw((10n ** 9n * 10n ** 18n).toString()), '1.00×10⁹');
  assert.equal(NET.formatCaw('11000004229162450356202134848238889270'), '1.10×10¹⁹');
  for (const bad of [null, 5, '', 'abc', '1e5', '-1', '1'.repeat(81)]) assert.equal(NET.formatCaw(bad), null);
  assert.equal(NET.groupDigits(1587), '1,587');
  assert.equal(NET.groupDigits(12), '12');
});

test('a line is drawn only when there are two values or more; gaps are skipped, a flat line is in the middle', () => {
  assert.equal(NET.sparkPoints([5], 100, 20), null);
  assert.equal(NET.sparkPoints([null, 5, null], 100, 20), null);
  assert.equal(NET.sparkPoints([0, 10], 100, 20), '0.0,20.0 100.0,0.0');
  assert.equal(NET.sparkPoints([4, 4, 4], 100, 20), '0.0,10.0 50.0,10.0 100.0,10.0');
  assert.equal(NET.sparkPoints([0, null, 10], 100, 20), '0.0,20.0 100.0,0.0');
  const s = NET.series([entry({ users: 5 }), entry({ users: null }), entry({ users: 9, depositedWei: null })], 'users');
  assert.deepEqual(plain(s), [5, null, 9]);
  assert.equal(NET.series([entry({ depositedWei: '2000' })], 'depositedWei')[0], 2000);
  assert.equal(NET.series([entry({ depositedWei: null })], 'depositedWei')[0], null);
});
