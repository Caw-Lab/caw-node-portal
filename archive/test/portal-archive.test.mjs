import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// The file is a classic script: run it the way a page does and take the global it makes.
function load() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(path.join(import.meta.dirname, '..', 'portal-archive.js'), 'utf8'), context);
  return context.ARC;
}
const ARC = load();
const plain = (value) => JSON.parse(JSON.stringify(value));

const file = (over = {}) => ({
  schemaVersion: 1,
  kind: 'caw-archive-status',
  generatedAt: '2026-11-18T12:00:03.000Z',
  total: 16,
  counts: { finalized: 14, pendingInWindow: 1, pendingOverdue: 1, slashed: 0 },
  overdue: [{ id: 1, overdueSeconds: 5583000 }],
  ...over,
});

test('a good file is read and an overdue submission makes the level warn', () => {
  const r = plain(ARC.parse(file()));
  assert.equal(r.total, 16);
  assert.equal(r.finalized, 14);
  assert.equal(r.pendingOverdue, 1);
  assert.deepEqual(r.overdueIds, [1]);
  assert.equal(r.generatedAt, '2026-11-18 12:00');
  assert.equal(r.level, 'warn');
});

test('nothing overdue: the level is ok', () => {
  const r = ARC.parse(file({ counts: { finalized: 15, pendingInWindow: 1, pendingOverdue: 0, slashed: 0 }, overdue: [] }));
  assert.equal(r.level, 'ok');
});

test('counts that do not add up to the stated total are refused', () => {
  assert.equal(ARC.parse(file({ total: 17 })), null);
});

test('a missing total is accepted when the counts are fine', () => {
  const data = file();
  delete data.total;
  assert.equal(ARC.parse(data).total, 16);
});

test('wrong shapes are refused', () => {
  assert.equal(ARC.parse(null), null);
  assert.equal(ARC.parse([]), null);
  assert.equal(ARC.parse(file({ schemaVersion: 2 })), null);
  assert.equal(ARC.parse(file({ kind: 'caw-network-stats' })), null);
  assert.equal(ARC.parse(file({ generatedAt: 'yesterday' })), null);
  assert.equal(ARC.parse(file({ counts: null })), null);
});

test('counts must be whole non-negative numbers', () => {
  const bad = (counts) => ARC.parse(file({ total: undefined, counts: { finalized: 14, pendingInWindow: 1, pendingOverdue: 1, slashed: 0, ...counts } }));
  assert.equal(bad({ finalized: -1 }), null);
  assert.equal(bad({ finalized: 1.5 }), null);
  assert.equal(bad({ slashed: '0' }), null);
  assert.equal(bad({ pendingOverdue: 1e12 }), null);
});

test('overdue ids are cleaned: only whole numbers, at most 50', () => {
  const overdue = [{ id: 3 }, { id: 'x' }, null, 7, { id: -2 }, { id: 9 }];
  assert.deepEqual(plain(ARC.parse(file({ overdue })).overdueIds), [3, 9]);
  const many = Array.from({ length: 80 }, (_, i) => ({ id: i + 1 }));
  assert.equal(ARC.parse(file({ overdue: many })).overdueIds.length, 50);
});

test('a slashed submission is counted but does not make the level warn by itself', () => {
  const r = ARC.parse(file({ total: 16, counts: { finalized: 14, pendingInWindow: 1, pendingOverdue: 0, slashed: 1 }, overdue: [] }));
  assert.equal(r.slashed, 1);
  assert.equal(r.level, 'ok');
});
