// A fake CAW node for the tests: a small frontend build and a server that serves it.
import http from 'node:http';
import { createHash } from 'node:crypto';

export const sha = (buffer) => 'sha256-' + createHash('sha256').update(buffer).digest('hex');

export function makeBuild(extraChunks = 12) {
  const html =
    '<!doctype html><html><head><meta property="og:url" content="__CAW_PUBLIC_URL__">' +
    '<script type="module" crossorigin src="/assets/index-AAA.js"></script>' +
    '<link rel="modulepreload" crossorigin href="/assets/vendor-BBB.js">' +
    '<link rel="stylesheet" href="/assets/style-CCC.css"></head><body></body></html>';
  const files = {
    'index.html': Buffer.from(html),
    'assets/index-AAA.js': Buffer.from('console.log("index")'),
    'assets/vendor-BBB.js': Buffer.from('console.log("vendor")'),
    'assets/style-CCC.css': Buffer.from('body{}'),
    'assets/keyManager-DDD.js': Buffer.from('console.log("keys")'),
    'assets/SessionKeySettings-EEE.js': Buffer.from('console.log("session")'),
  };
  for (let i = 0; i < extraChunks; i++) files[`assets/chunk-${i}.js`] = Buffer.from(`console.log(${i})`);
  return files;
}

export function manifestOf(files, overrides = {}) {
  const listed = {};
  for (const [path, bytes] of Object.entries(files)) listed[path] = sha(bytes);
  return { version: 1, clientVersion: 'abc1234', builtAt: '2026-11-12T00:00:00Z', files: { ...listed, ...overrides } };
}

// served: what the server really sends (path -> Buffer). manifest: what it says.
export async function startNode({ served, manifest, manifestStatus = 200, manifestBody, spa = false, statuses = {} }) {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\//, '');
    if (path === 'build-manifest.json') {
      if (manifestStatus !== 200) {
        res.writeHead(manifestStatus);
        res.end('no');
        return;
      }
      if (manifestBody !== undefined) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(manifestBody);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (statuses[path]) {
      res.writeHead(statuses[path]);
      res.end('x');
      return;
    }
    const file = path === '' ? served['index.html'] : served[path];
    if (file) {
      res.writeHead(200);
      res.end(file);
    } else if (spa) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(served['index.html']);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Deterministic "random" for tests.
export function seeded(seed = 1) {
  let state = seed;
  return (max) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % max;
  };
}
