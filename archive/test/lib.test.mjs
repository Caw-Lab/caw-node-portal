import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSubmission, buildStatus, collectArchive, ARCHIVE, GRACE_SECONDS } from '../lib.mjs';

const w = (n) => BigInt(n).toString(16).padStart(64, '0');
// submitter, merkleRoot, networkId, start, end, finalizedAt, status, dataCommitment
const raw = ({ networkId = 1, start = 1, end = 16, deadline = 1000, status = 0 } = {}) =>
  '0x' + w(0xabc) + w(0x1234) + w(networkId) + w(start) + w(end) + w(deadline) + w(status) + w(0x99);

test('a submission is decoded from its 8 words', () => {
  assert.deepEqual(decodeSubmission(3, raw({ start: 17, end: 32, deadline: 555, status: 1 })), {
    id: 3, networkId: 1, startCheckpoint: 17, endCheckpoint: 32, deadline: 555, status: 'FINALIZED',
  });
});

test('wrong length, wrong shape, unknown status and huge numbers are refused', () => {
  assert.throws(() => decodeSubmission(1, '0x'), /unexpected answer/);
  assert.throws(() => decodeSubmission(1, null), /unexpected answer/);
  assert.throws(() => decodeSubmission(1, raw({ status: 3 })), /unknown status/);
  assert.throws(() => decodeSubmission(1, raw({ deadline: 2n ** 60n })), /too large/);
});

test('pending ones become overdue only after the deadline plus the grace period', () => {
  const G = GRACE_SECONDS;
  const subs = [
    { id: 1, endCheckpoint: 16, deadline: 1000 - G - 100, status: 'PENDING' }, // 100 s past the grace: overdue
    { id: 2, endCheckpoint: 32, deadline: 1000 - G, status: 'PENDING' }, // exactly at the end of the grace: not yet
    { id: 3, endCheckpoint: 48, deadline: 1000 - 60, status: 'PENDING' }, // 60 s past the deadline: inside the grace
    { id: 4, endCheckpoint: 64, deadline: 1500, status: 'PENDING' }, // window still running
    { id: 5, endCheckpoint: 80, deadline: 100, status: 'FINALIZED' },
    { id: 6, endCheckpoint: 96, deadline: 100, status: 'SLASHED' },
  ];
  const s = buildStatus({ now: Date.UTC(2026, 10, 18, 12), chainTime: 1000, submissions: subs });
  assert.deepEqual(s.counts, { finalized: 1, pendingInWindow: 3, pendingOverdue: 1, slashed: 1 });
  assert.equal(s.total, 6);
  assert.deepEqual(s.overdue, [{ id: 1, endCheckpoint: 16, overdueSeconds: 100 }]);
  assert.deepEqual(s.inWindow.map((x) => [x.id, x.secondsLeft]), [[2, 0], [3, 0], [4, 500]]);
  assert.equal(s.graceSeconds, G);
  assert.equal(s.generatedAt, '2026-11-18T12:00:00.000Z');
  assert.equal(s.kind, 'caw-archive-status');
});

// A fake node: answers the three calls the collector makes.
const fakeNode = ({ chainTime = 1000, subs, failOn } = {}) => async (_url, init) => {
  const { method, params } = JSON.parse(init.body);
  const reply = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
  if (method === 'eth_getBlockByNumber') return reply({ timestamp: '0x' + chainTime.toString(16) });
  const data = params[0].data;
  if (data === '0x35b96901') return reply('0x' + w(subs.length + 1));
  if (data.startsWith('0xad73349e')) {
    const id = Number(BigInt('0x' + data.slice(10)));
    if (failOn === id) return { ok: false, status: 429, text: async () => '' };
    return reply(raw(subs[id - 1]));
  }
  throw new Error('unexpected call ' + data);
};

test('the collector reads every submission through the node', async () => {
  const chainTime = 100000;
  const subs = [{ status: 1, deadline: 10 }, { status: 0, deadline: chainTime - GRACE_SECONDS - 5 }, { status: 0, deadline: chainTime + 2000 }];
  const s = await collectArchive({ now: 0, fetchImpl: fakeNode({ subs, chainTime }) });
  assert.deepEqual(s.counts, { finalized: 1, pendingInWindow: 1, pendingOverdue: 1, slashed: 0 });
  assert.equal(s.archive, ARCHIVE.to);
});

test('one failed read fails the whole run: no partial counts', async () => {
  const subs = [{ status: 1 }, { status: 0 }, { status: 0 }];
  await assert.rejects(collectArchive({ fetchImpl: fakeNode({ subs, failOn: 2 }) }), /HTTP 429/);
});

test('an implausible submission count is refused', async () => {
  const fetchImpl = async (_u, init) => {
    const { method } = JSON.parse(init.body);
    const result = method === 'eth_getBlockByNumber' ? { timestamp: '0x3e8' } : '0x' + w(10 ** 7);
    return { ok: true, status: 200, text: async () => JSON.stringify({ result }) };
  };
  await assert.rejects(collectArchive({ fetchImpl }), /implausible/);
});

test('no submissions at all gives zero counts', async () => {
  const s = await collectArchive({ now: 0, fetchImpl: fakeNode({ subs: [] }) });
  assert.equal(s.total, 0);
  assert.equal(s.counts.pendingOverdue, 0);
});
