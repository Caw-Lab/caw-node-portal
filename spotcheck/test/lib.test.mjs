import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNode, entryAssets, fingerprint, parseManifest, pickSample, priorityPaths, systemRandom } from '../lib.js';
import { createGet } from '../net.js';
import { makeBuild, manifestOf, seeded, sha, startNode } from './helpers.mjs';

const get = createGet({ allowLocal: true });
const ALL = 1000; // a sample size large enough to check every file

async function withNode(config, work) {
  const node = await startNode(config);
  try {
    return await work(node);
  } finally {
    await node.close();
  }
}

// ---------------------------------------------------------------- units

test('parseManifest accepts a good manifest and refuses odd ones', () => {
  const good = manifestOf(makeBuild());
  assert.equal(parseManifest(good).clientVersion, 'abc1234');
  assert.throws(() => parseManifest({ ...good, version: 2 }));
  assert.throws(() => parseManifest({ ...good, files: {} }));
  assert.throws(() => parseManifest({ ...good, files: { '../x.js': sha(Buffer.from('a')) } }));
  assert.throws(() => parseManifest({ ...good, files: { '/abs.js': sha(Buffer.from('a')) } }));
  assert.throws(() => parseManifest({ ...good, files: { 'a.js?x=1': sha(Buffer.from('a')) } }));
  assert.throws(() => parseManifest({ ...good, files: { 'a.js': 'sha256-nothex' } }));
  assert.throws(() => parseManifest(null));
});

test('fingerprint does not depend on key order', async () => {
  const a = { 'b.js': sha(Buffer.from('b')), 'a.js': sha(Buffer.from('a')) };
  const b = { 'a.js': sha(Buffer.from('a')), 'b.js': sha(Buffer.from('b')) };
  assert.equal(await fingerprint(a), await fingerprint(b));
  assert.notEqual(await fingerprint(a), await fingerprint({ ...a, 'a.js': sha(Buffer.from('changed')) }));
});

test('entryAssets finds scripts, preloads and stylesheets, and tells external ones apart', () => {
  const html =
    '<script type="module" src="/assets/a.js?v=1"></script>' +
    "<script src='./assets/b.js'></script>" +
    '<link rel="modulepreload" href="https://node.test/assets/c.js">' +
    '<link rel="stylesheet" href="/assets/d.css">' +
    '<link rel="icon" href="/favicon.ico">' +
    '<script src="https://cdn.example/x.js"></script>' +
    '<script>inline()</script>' +
    '<link rel="stylesheet" href="/../../etc/passwd">';
  const found = entryAssets(html, 'https://node.test');
  assert.deepEqual(found.paths.sort(), ['assets/a.js', 'assets/b.js', 'assets/c.js', 'assets/d.css']);
  assert.deepEqual(found.external, ['https://cdn.example/x.js']);
});

test('priorityPaths picks names about keys, sessions, signing, wallets and sign-in', () => {
  const files = manifestOf(makeBuild()).files;
  const names = priorityPaths(files);
  assert.deepEqual(names, ['assets/SessionKeySettings-EEE.js', 'assets/keyManager-DDD.js']);
});

test('pickSample gives distinct items, never more than asked, and is repeatable with a seed', () => {
  const items = Array.from({ length: 50 }, (_, i) => 'f' + i);
  const a = pickSample(items, 20, seeded(7));
  const b = pickSample(items, 20, seeded(7));
  assert.equal(a.length, 20);
  assert.equal(new Set(a).size, 20);
  assert.deepEqual(a, b);
  assert.equal(pickSample(items, 99, seeded(1)).length, 50);
  assert.deepEqual(pickSample([], 5), []);
});

test('systemRandom stays inside the range', () => {
  for (let i = 0; i < 2000; i++) {
    const value = systemRandom(7);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 7);
  }
});

// ---------------------------------------------------------------- the check

test('an unchanged node is consistent', async () => {
  const served = makeBuild();
  await withNode({ served, manifest: manifestOf(served) }, async ({ origin }) => {
    const result = await checkNode(origin, { get, sampleSize: ALL });
    assert.equal(result.state, 'consistent');
    assert.equal(result.indexHtml, 'exact');
    assert.equal(result.counts.matched, Object.keys(served).length);
    assert.equal(result.complete, true);
    assert.deepEqual(result.problems, []);
    assert.equal(result.history.length, 1);
  });
});

test('a changed file is found when it is checked', async () => {
  const listed = makeBuild();
  const served = { ...listed, 'assets/chunk-3.js': Buffer.from('console.log("tampered")') };
  await withNode({ served, manifest: manifestOf(listed) }, async ({ origin }) => {
    const result = await checkNode(origin, { get, sampleSize: ALL });
    assert.equal(result.state, 'inconsistent');
    assert.deepEqual(result.problems, [{ path: 'assets/chunk-3.js', state: 'mismatched' }]);
  });
});

test('a file the list names but the node does not serve is missing', async () => {
  const listed = makeBuild();
  const served = { ...listed };
  delete served['assets/chunk-5.js'];
  await withNode({ served, manifest: manifestOf(listed) }, async ({ origin }) => {
    const result = await checkNode(origin, { get, sampleSize: ALL });
    assert.equal(result.state, 'inconsistent');
    assert.deepEqual(result.problems, [{ path: 'assets/chunk-5.js', state: 'missing' }]);
  });
});

test('files that point at keys and sessions are always checked, other files only when sampled', async () => {
  const listed = makeBuild();
  const priority = { ...listed, 'assets/keyManager-DDD.js': Buffer.from('changed') };
  await withNode({ served: priority, manifest: manifestOf(listed) }, async ({ origin }) => {
    const result = await checkNode(origin, { get, sampleSize: 0 });
    assert.equal(result.state, 'inconsistent');
  });
  const ordinary = { ...listed, 'assets/chunk-3.js': Buffer.from('changed') };
  await withNode({ served: ordinary, manifest: manifestOf(listed) }, async ({ origin }) => {
    const result = await checkNode(origin, { get, sampleSize: 0 });
    assert.equal(result.state, 'consistent');
  });
});

test('a script that index.html loads but the list does not know is inconsistent', async () => {
  const served = makeBuild();
  served['index.html'] = Buffer.from(served['index.html'].toString().replace('</head>', '<script src="/assets/evil.js"></script></head>'));
  served['assets/evil.js'] = Buffer.from('console.log("evil")');
  const manifest = manifestOf(served); // index.html matches the served page ...
  delete manifest.files['assets/evil.js']; // ... but the list does not know evil.js
  await withNode({ served, manifest }, async ({ origin }) => {
    const result = await checkNode(origin, { get, sampleSize: ALL });
    assert.equal(result.state, 'inconsistent');
    assert.equal(result.indexHtml, 'exact');
    assert.deepEqual(result.problems, [{ path: 'assets/evil.js', state: 'unlisted' }]);
  });
});

test('a script from another site is reported but does not change the state', async () => {
  const served = makeBuild();
  served['index.html'] = Buffer.from(served['index.html'].toString().replace('</head>', '<script src="https://cdn.example/x.js"></script></head>'));
  await withNode({ served, manifest: manifestOf(served) }, async ({ origin }) => {
    const result = await checkNode(origin, { get, sampleSize: ALL });
    assert.equal(result.state, 'consistent');
    assert.deepEqual(result.externalScripts, ['https://cdn.example/x.js']);
  });
});

test('index.html with the node address put in for the placeholder still matches', async () => {
  const listed = makeBuild();
  const manifest = manifestOf(listed); // the hash of the page with the placeholder
  const served = { ...listed };
  await withNode({ served, manifest }, async ({ origin }) => {
    // what the installer does: the placeholder becomes the node's address
    served['index.html'] = Buffer.from(listed['index.html'].toString().replaceAll('__CAW_PUBLIC_URL__', origin));
    const result = await checkNode(origin, { get, sampleSize: ALL });
    assert.equal(result.indexHtml, 'after-undoing-address');
    assert.equal(result.state, 'consistent');
  });
});

test('index.html that really differs is a problem', async () => {
  const listed = makeBuild();
  const served = { ...listed, 'index.html': Buffer.from(listed['index.html'].toString() + '<!-- x -->') };
  await withNode({ served, manifest: manifestOf(listed) }, async ({ origin }) => {
    const result = await checkNode(origin, { get, sampleSize: 0 });
    assert.equal(result.state, 'inconsistent');
    assert.equal(result.indexHtml, 'different');
  });
});

test('a node with no list: 404, or the page returned in place of the file', async () => {
  const served = makeBuild();
  await withNode({ served, manifestStatus: 404 }, async ({ origin }) => {
    assert.equal((await checkNode(origin, { get })).state, 'no-list');
  });
  await withNode({ served, manifestBody: served['index.html'].toString() }, async ({ origin }) => {
    assert.equal((await checkNode(origin, { get })).state, 'no-list');
  });
});

test('a node that cannot be reached, or answers 5xx for the list, is unreachable', async () => {
  const served = makeBuild();
  const node = await startNode({ served, manifest: manifestOf(served) });
  const origin = node.origin;
  await node.close();
  assert.equal((await checkNode(origin, { get })).state, 'unreachable');
  await withNode({ served, manifestStatus: 503 }, async ({ origin: o }) => {
    assert.equal((await checkNode(o, { get })).state, 'unreachable');
  });
});

test('a list that changed under the same version string is "changed"; a new version is not', async () => {
  const served = makeBuild();
  await withNode({ served, manifest: manifestOf(served) }, async ({ origin }) => {
    const same = await checkNode(origin, { get, sampleSize: ALL, previous: { clientVersion: 'abc1234', manifestHash: 'old', history: [] } });
    assert.equal(same.state, 'changed');
    assert.equal(same.versionChanged, false);
    const newer = await checkNode(origin, { get, sampleSize: ALL, previous: { clientVersion: 'older', manifestHash: 'old', history: [] } });
    assert.equal(newer.state, 'consistent');
    assert.equal(newer.versionChanged, true);
    assert.equal(newer.history.length, 1);
  });
});

test('history only grows when the list changes', async () => {
  const served = makeBuild();
  await withNode({ served, manifest: manifestOf(served) }, async ({ origin }) => {
    const first = await checkNode(origin, { get, sampleSize: 0 });
    const second = await checkNode(origin, { get, sampleSize: 0, previous: first });
    assert.equal(second.history.length, 1);
    assert.equal(second.state, 'consistent');
  });
});

test('a file that answers 500 or is too large is "could not be read", not a difference', async () => {
  const served = makeBuild();
  await withNode({ served, manifest: manifestOf(served), statuses: { 'assets/chunk-1.js': 500 } }, async ({ origin }) => {
    const result = await checkNode(origin, { get, sampleSize: ALL });
    assert.equal(result.counts.errored, 1);
    assert.equal(result.complete, false);
    assert.equal(result.state, 'consistent');
  });
  await withNode({ served, manifest: manifestOf(served) }, async ({ origin }) => {
    const small = (url, options) => get(url, { maxBytes: url.endsWith('chunk-2.js') ? 5 : options.maxBytes });
    const result = await checkNode(origin, { get: small, sampleSize: ALL });
    assert.equal(result.counts.errored, 1);
    assert.deepEqual(result.problems, [{ path: 'assets/chunk-2.js', state: 'errored' }]);
  });
});
