import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { checkTarget, createGet, guardedLookup, isPrivateAddress } from '../net.js';

test('checkTarget accepts an ordinary https host name and returns its origin', () => {
  assert.equal(checkTarget('https://v2.example.com'), 'https://v2.example.com');
  assert.equal(checkTarget('https://v2.example.com/api/instances?x=1'), 'https://v2.example.com');
});

test('checkTarget refuses http, IP addresses, ports, user names and internal-looking names', () => {
  for (const bad of [
    'http://example.com',
    'ftp://example.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://10.0.0.5',
    'https://user:pw@example.com',
    'https://example.com:8443',
    'https://localhost',
    'https://nodehost',
    'https://printer.local',
    'https://db.internal',
    'not an address',
  ]) {
    assert.throws(() => checkTarget(bad), undefined, bad);
  }
});

test('checkTarget allows local http only when asked to (tests)', () => {
  assert.throws(() => checkTarget('http://127.0.0.1:8000'));
  assert.equal(checkTarget('http://127.0.0.1:8000', { allowLocal: true }), 'http://127.0.0.1:8000');
});

test('isPrivateAddress', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'nonsense']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.0.2.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('the connection lookup refuses a name that resolves to a private address', async () => {
  const refuse = guardedLookup(false);
  await assert.rejects(
    new Promise((resolve, reject) => refuse('localhost', { all: true }, (error, result) => (error ? reject(error) : resolve(result)))),
    /private address/,
  );
  const allow = guardedLookup(true);
  const result = await new Promise((resolve, reject) => allow('localhost', { all: true }, (error, list) => (error ? reject(error) : resolve(list))));
  assert.ok(Array.isArray(result) && result.length > 0);
});

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

test('get does not follow redirects, and reads status and body', async () => {
  const site = await serve((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/' });
      res.end();
    } else {
      res.writeHead(200);
      res.end('hello');
    }
  });
  try {
    const get = createGet({ allowLocal: true });
    const moved = await get(site.origin + '/redirect', { maxBytes: 100 });
    assert.equal(moved.status, 302);
    assert.equal(moved.bytes.length, 0);
    const ok = await get(site.origin + '/x', { maxBytes: 100 });
    assert.equal(ok.status, 200);
    assert.equal(new TextDecoder().decode(ok.bytes), 'hello');
  } finally {
    await site.close();
  }
});

test('get refuses responses larger than the limit, declared or not', async () => {
  const site = await serve((req, res) => {
    if (req.url === '/declared') {
      res.writeHead(200, { 'content-length': '5000' });
      res.end('x'.repeat(5000));
    } else {
      res.writeHead(200); // no content-length: chunked
      res.write('x'.repeat(3000));
      res.end('y'.repeat(3000));
    }
  });
  try {
    const get = createGet({ allowLocal: true });
    await assert.rejects(get(site.origin + '/declared', { maxBytes: 1000 }), /too large/);
    await assert.rejects(get(site.origin + '/chunked', { maxBytes: 1000 }), /too large/);
  } finally {
    await site.close();
  }
});

test('get decodes a gzip body and caps what it unpacks to', async () => {
  const original = 'a'.repeat(2000);
  const site = await serve((req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(original));
  });
  try {
    const get = createGet({ allowLocal: true });
    const ok = await get(site.origin + '/', { maxBytes: 10000 });
    assert.equal(new TextDecoder().decode(ok.bytes), original);
    await assert.rejects(get(site.origin + '/', { maxBytes: 1000 }));
  } finally {
    await site.close();
  }
});

test('get gives up on a server that never answers', async () => {
  const site = await serve(() => {});
  try {
    const get = createGet({ allowLocal: true, timeoutMs: 300 });
    await assert.rejects(get(site.origin + '/', { maxBytes: 100 }), /timed out/);
  } finally {
    await site.close();
  }
});
