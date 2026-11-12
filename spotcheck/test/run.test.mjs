import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeBuild, manifestOf, startNode } from './helpers.mjs';

const run = path.join(import.meta.dirname, '..', 'run.mjs');

// Asynchronous on purpose: the fake nodes live in this process, so it must keep answering while the command runs.
const execFileAsync = promisify(execFile);
async function cli(args) {
  const { stdout } = await execFileAsync('node', [run, ...args], { encoding: 'utf8' });
  return stdout;
}

// Two fake nodes with different host names: 127.0.0.1 and localhost.
test('a run limited with --only keeps the last result of the other nodes', async () => {
  const served = makeBuild();
  const a = await startNode({ served, manifest: manifestOf(served) });
  const b = await startNode({ served, manifest: manifestOf(served) });
  const dir = mkdtempSync(path.join(tmpdir(), 'spotcheck-run-'));
  try {
    const nodes = path.join(dir, 'nodes.json');
    const nodeA = a.origin; // http://127.0.0.1:PORT
    const nodeB = b.origin.replace('127.0.0.1', 'localhost');
    writeFileSync(nodes, JSON.stringify([nodeA, nodeB]));

    await cli(['--nodes', nodes, '--out', path.join(dir, 's1.json'), '--allow-local']);
    const first = JSON.parse(readFileSync(path.join(dir, 's1.json'), 'utf8'));
    assert.deepEqual(Object.keys(first.nodes).sort(), [nodeA, nodeB].sort());

    // only 127.0.0.1 this time
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cli(['--nodes', nodes, '--previous', path.join(dir, 's1.json'), '--only', '127.0.0.1', '--out', path.join(dir, 's2.json'), '--allow-local']);
    const second = JSON.parse(readFileSync(path.join(dir, 's2.json'), 'utf8'));
    assert.deepEqual(Object.keys(second.nodes).sort(), [nodeA, nodeB].sort());
    assert.notEqual(second.nodes[nodeA].checkedAt, first.nodes[nodeA].checkedAt); // checked again
    assert.equal(second.nodes[nodeB].checkedAt, first.nodes[nodeB].checkedAt); // kept as it was

    // a node that is no longer on the list is dropped
    writeFileSync(nodes, JSON.stringify([nodeA]));
    await cli(['--nodes', nodes, '--previous', path.join(dir, 's2.json'), '--only', '127.0.0.1', '--out', path.join(dir, 's3.json'), '--allow-local']);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(dir, 's3.json'), 'utf8')).nodes), [nodeA]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await a.close();
    await b.close();
  }
});

test('--only with something that is not a host name is refused', async () => {
  await assert.rejects(cli(['--nodes', '/dev/null', '--only', 'bad host!', '--out', '/tmp/never.json']), /host names/);
});
