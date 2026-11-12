// spotcheck: a light check of what a CAW node serves.
//
// Most CAW nodes publish /build-manifest.json: a list of the files of their
// frontend build with a SHA-256 for each. This module downloads a few of those
// files from the node and checks them against the node's OWN list:
//   - index.html, every script and stylesheet that index.html loads, and the
//     files whose names point at keys, sessions, signing, wallets or sign-in
//     are always checked;
//   - a random sample of the other files is checked as well.
// It also remembers a fingerprint of the list, so a list that changes without
// a new version string can be noticed.
//
// It tells you whether the node serves what its own list says. It does not
// tell you that the list is the published one. A node that changes both the
// files and the list passes. Nothing here has any dependency; it runs in
// Node 20+ and in a browser (see browserGet).

const HASH_PATTERN = /^sha256-[0-9a-f]{64}$/;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const PRIORITY_NAME = /(key|session|sign|wallet|passkey|auth)/i;
const MAX_PRIORITY = 30;
const MAX_HISTORY = 20;
const MAX_PROBLEMS = 20;

// ---------------------------------------------------------------- hashing

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256-' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Hash of the whole list: one "path<TAB>hash" line per file, sorted by path.
// It does not depend on key order or on the build time.
export async function fingerprint(files) {
  const text = Object.keys(files)
    .sort()
    .map((path) => path + '\t' + files[path] + '\n')
    .join('');
  return (await sha256(new TextEncoder().encode(text))).slice('sha256-'.length);
}

// ---------------------------------------------------------------- manifest

function isSafePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 300) return false;
  if (path.startsWith('/') || path.includes('\\') || /[?#]/.test(path)) return false;
  return !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

// Strict check of a build-manifest.json. Throws on anything odd.
export function parseManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) {
    throw new Error('not a version 1 manifest');
  }
  const source = raw.files;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('no file list');
  const files = {};
  for (const [path, hash] of Object.entries(source)) {
    if (!isSafePath(path)) throw new Error('unsafe path in the file list');
    if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) throw new Error('malformed hash in the file list');
    files[path] = hash;
  }
  if (Object.keys(files).length === 0) throw new Error('empty file list');
  return {
    clientVersion: typeof raw.clientVersion === 'string' ? raw.clientVersion.slice(0, 80) : 'unknown',
    builtAt: typeof raw.builtAt === 'string' ? raw.builtAt.slice(0, 40) : '',
    files,
  };
}

// ---------------------------------------------------------------- what to check

// Scripts, module preloads and stylesheets that an index.html loads.
// `paths` are files on the same origin (as manifest paths); `external` are
// scripts or stylesheets from elsewhere.
export function entryAssets(html, origin) {
  const paths = [];
  const external = [];
  const add = (reference) => {
    let value = reference.trim();
    if (!value || value.startsWith('data:') || value.startsWith('#')) return;
    if (value.startsWith('//')) value = 'https:' + value;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      let url;
      try {
        url = new URL(value);
      } catch {
        return;
      }
      if (url.origin !== origin) {
        external.push(url.origin + url.pathname);
        return;
      }
      value = url.pathname;
    }
    value = value.split(/[?#]/)[0].replace(/^\.?\//, '');
    if (isSafePath(value)) paths.push(value);
  };
  const attribute = (tag, name) => {
    const match = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
    return match ? (match[1] ?? match[2]) : null;
  };
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    const src = attribute(tag, 'src');
    if (src) add(src);
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase();
    const href = attribute(tag, 'href');
    if (href && /\b(modulepreload|stylesheet|preload)\b/.test(rel)) add(href);
  }
  return { paths: [...new Set(paths)], external: [...new Set(external)] };
}

export function priorityPaths(files) {
  return Object.keys(files)
    .filter((path) => PRIORITY_NAME.test(path.slice(path.lastIndexOf('/') + 1)))
    .sort()
    .slice(0, MAX_PRIORITY);
}

// Uniform random integer in [0, max), from the system's random source.
export function systemRandom(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return buffer[0] % max;
}

// `count` different items chosen at random (partial Fisher-Yates).
export function pickSample(items, count, random = systemRandom) {
  const pool = items.slice();
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + random(pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

// ---------------------------------------------------------------- fetching

function addressOf(origin, path) {
  return origin + '/' + path.split('/').map(encodeURIComponent).join('/');
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// A getter for browsers. In Node, use createGet from net.js, which also
// refuses private addresses and redirects.
export function browserGet(fetchFn = fetch) {
  return async (url, { maxBytes }) => {
    const response = await fetchFn(url, { credentials: 'omit', cache: 'no-store' });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response is too large');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('response is too large');
    return { status: response.status, bytes };
  };
}

// ---------------------------------------------------------------- the check

// states:
//   consistent    every file that was checked matches the node's own list
//   inconsistent  a checked file differs from, or is missing from, the list,
//                 or index.html loads a script that the list does not know
//   changed       the files match, but the list changed while the version
//                 string stayed the same
//   no-list       the node publishes no build-manifest.json
//   unreachable   the node could not be read
export async function checkNode(origin, options) {
  const {
    get,
    previous = null,
    sampleSize = 20,
    random = systemRandom,
    concurrency = 4,
    now = () => new Date().toISOString(),
  } = options;
  const checkedAt = now();
  const record = (state, extra = {}) => ({ origin, state, checkedAt, ...extra });
  const unreachable = (message) => record('unreachable', { message: String(message).slice(0, 160) });

  // 1. The node's own list.
  let manifestResponse;
  try {
    manifestResponse = await get(origin + '/build-manifest.json', { maxBytes: MAX_MANIFEST_BYTES });
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : error);
  }
  if (manifestResponse.status >= 500) return unreachable('HTTP ' + manifestResponse.status);
  let manifest;
  try {
    if (manifestResponse.status !== 200) throw new Error('HTTP ' + manifestResponse.status);
    manifest = parseManifest(JSON.parse(new TextDecoder().decode(manifestResponse.bytes)));
  } catch (error) {
    return record('no-list', { message: error instanceof SyntaxError ? 'the answer is not a JSON file' : error instanceof Error ? error.message.slice(0, 120) : 'unreadable' });
  }
  const { files } = manifest;
  const listHash = await fingerprint(files);

  // 2. index.html, as the node serves it now.
  let indexResponse;
  try {
    indexResponse = await get(origin + '/index.html', { maxBytes: MAX_MANIFEST_BYTES });
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : error);
  }
  if (indexResponse.status !== 200) return unreachable('index.html: HTTP ' + indexResponse.status);

  const problems = [];
  const counts = { matched: 0, mismatched: 0, missing: 0, errored: 0 };
  const note = (path, state) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ path, state });
  };

  // The installer may replace the __CAW_PUBLIC_URL__ placeholder with the
  // node's address. Try the page as served, then with that undone.
  let indexMatch = 'unlisted';
  if (files['index.html']) {
    if ((await sha256(indexResponse.bytes)) === files['index.html']) {
      indexMatch = 'exact';
    } else {
      const undone = new TextDecoder().decode(indexResponse.bytes).split(origin).join('__CAW_PUBLIC_URL__');
      indexMatch = (await sha256(new TextEncoder().encode(undone))) === files['index.html'] ? 'after-undoing-address' : 'different';
    }
  }
  if (indexMatch === 'different' || indexMatch === 'unlisted') {
    counts.mismatched++;
    note('index.html', indexMatch === 'unlisted' ? 'unlisted' : 'different');
  } else {
    counts.matched++;
  }

  // 3. What index.html loads must be listed.
  const html = new TextDecoder().decode(indexResponse.bytes);
  const loaded = entryAssets(html, origin);
  const unlisted = loaded.paths.filter((path) => !files[path]);
  for (const path of unlisted) note(path, 'unlisted');
  const loadedListed = loaded.paths.filter((path) => files[path]);

  // 4. Files to download: always the loaded ones and the priority ones, then a random sample.
  const fixed = [...new Set([...loadedListed, ...priorityPaths(files)])].filter((path) => path !== 'index.html');
  const rest = Object.keys(files).filter((path) => path !== 'index.html' && !fixed.includes(path));
  const chosen = [...fixed, ...pickSample(rest, sampleSize, random)];

  const results = await mapLimit(chosen, concurrency, async (path) => {
    try {
      const response = await get(addressOf(origin, path), { maxBytes: MAX_FILE_BYTES });
      if (response.status === 404) return { path, state: 'missing' };
      if (response.status !== 200) return { path, state: 'errored' };
      return { path, state: (await sha256(response.bytes)) === files[path] ? 'matched' : 'mismatched' };
    } catch {
      return { path, state: 'errored' };
    }
  });
  for (const result of results) {
    counts[result.state]++;
    if (result.state !== 'matched') note(result.path, result.state);
  }

  // 5. Verdict, and the list's history.
  const versionChanged = Boolean(previous && previous.clientVersion !== manifest.clientVersion);
  const listChanged = Boolean(previous && previous.manifestHash && previous.manifestHash !== listHash);
  const total = counts.matched + counts.mismatched + counts.missing + counts.errored;

  let state;
  if (counts.errored === chosen.length && chosen.length > 0 && counts.matched <= 1) state = 'unreachable';
  else if (counts.mismatched > 0 || counts.missing > 0 || unlisted.length > 0) state = 'inconsistent';
  else if (listChanged && !versionChanged) state = 'changed';
  else state = 'consistent';

  const history = Array.isArray(previous?.history) ? previous.history.slice() : [];
  if (!history.length || history[history.length - 1].manifestHash !== listHash) {
    history.push({ at: checkedAt, clientVersion: manifest.clientVersion, manifestHash: listHash });
  }

  return record(state, {
    clientVersion: manifest.clientVersion,
    builtAt: manifest.builtAt,
    manifestHash: listHash,
    fileCount: Object.keys(files).length,
    checked: total,
    counts,
    complete: counts.errored === 0,
    indexHtml: indexMatch,
    versionChanged,
    externalScripts: loaded.external.slice(0, 10),
    problems,
    history: history.slice(-MAX_HISTORY),
  });
}
