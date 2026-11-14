// Fetching for Node (the scheduled run). The list of nodes comes from the
// network, so every address is treated as untrusted:
//   - https only, no user name, no port, a real host name (no IP address, no
//     "localhost", no internal-looking names);
//   - the address the name resolves to is checked when the connection is made,
//     and private, loopback and link-local addresses are refused;
//   - redirects are not followed;
//   - every request has a time limit and a size limit.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

export const USER_AGENT = 'caw-node-portal-spotcheck/0.1 (+https://github.com/Caw-Lab/caw-node-portal)';

function ipv4Parts(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

// True for addresses a public website must never resolve to.
export function isPrivateAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b, c] = ipv4Parts(address);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true; // not an address at all
}

// Returns the origin to use, or throws. `allowLocal` is for tests only.
export function checkTarget(input, { allowLocal = false } = {}) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error('not a valid address');
  }
  if (allowLocal && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
    return url.origin;
  }
  if (url.protocol !== 'https:') throw new Error('only https addresses are checked');
  if (url.username || url.password) throw new Error('addresses with a user name are refused');
  if (url.port) throw new Error('addresses with a port are refused');
  const host = url.hostname.toLowerCase();
  if (net.isIP(host) || host.startsWith('[')) throw new Error('IP addresses are refused');
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)) {
    throw new Error('internal-looking names are refused');
  }
  return url.origin;
}

// A lookup for the connection: if the name resolves to any private address,
// the connection is refused (strict on purpose). Newer Node versions ask for
// every address (options.all), older ones for one.
export function guardedLookup(allowLocal) {
  return (hostname, options, callback) => {
    const wantAll = typeof options === 'object' && options !== null && options.all === true;
    const base = typeof options === 'object' && options !== null ? options : {};
    dns.lookup(hostname, { ...base, all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!allowLocal && addresses.some((entry) => isPrivateAddress(entry.address))) {
        return callback(new Error('the name resolves to a private address'));
      }
      if (wantAll) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function decode(bytes, encoding, maxBytes) {
  const options = { maxOutputLength: maxBytes };
  if (!encoding || encoding === 'identity') return bytes;
  if (encoding === 'gzip') return zlib.gunzipSync(bytes, options);
  if (encoding === 'deflate') return zlib.inflateSync(bytes, options);
  if (encoding === 'br') return zlib.brotliDecompressSync(bytes, options);
  throw new Error('unsupported content encoding');
}

// Returns get(url, { maxBytes }) => { status, bytes }.
// The result is settled exactly once; every failure destroys the connection
// and rejects, and errors that arrive after that are ignored.
export function createGet({ allowLocal = false, timeoutMs = 12000, userAgent = USER_AGENT } = {}) {
  return (rawUrl, { maxBytes }) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const succeed = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      let request = null;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        if (request) request.destroy();
      };

      let url;
      try {
        checkTarget(new URL(rawUrl).origin, { allowLocal });
        url = new URL(rawUrl);
      } catch (error) {
        fail(error);
        return;
      }
      const client = url.protocol === 'http:' ? http : https;
      request = client.request(
        url,
        {
          method: 'GET',
          headers: { 'user-agent': userAgent, accept: '*/*', 'accept-encoding': 'identity' },
          lookup: guardedLookup(allowLocal),
          timeout: timeoutMs,
        },
        (response) => {
          response.on('error', fail);
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            fail(new Error('response is too large'));
            return;
          }
          if (response.statusCode >= 300 && response.statusCode < 400) {
            response.resume();
            succeed({ status: response.statusCode, bytes: new Uint8Array(0) });
            return;
          }
          const chunks = [];
          let total = 0;
          response.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
              fail(new Error('response is too large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              const raw = Buffer.concat(chunks);
              const bytes = decode(raw, response.headers['content-encoding'], maxBytes);
              succeed({ status: response.statusCode, bytes: new Uint8Array(bytes) });
            } catch (error) {
              fail(error);
            }
          });
        },
      );
      request.on('timeout', () => fail(new Error('timed out')));
      request.on('error', fail);
      request.end();
    });
}
