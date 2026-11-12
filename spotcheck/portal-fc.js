// The part of the portal's "file consistency" display that is not about the
// page: reading status.json and describing a result. A classic script (no
// import/export) so that index.html can load it with a plain <script> tag; it
// puts one global, FC. The page puts every text on screen with textContent.
//
// status.json is data from the network, so it is cleaned before use: unknown
// states are dropped, strings are cut, numbers must be numbers, and only
// plain https host names (checked by the page's own safeUrl) are accepted.
(function (root) {
  'use strict';

  // state -> the colour class of the badge and the key of its text
  const BADGE = {
    consistent: { cls: 'ok', key: 'b_fcok' },
    inconsistent: { cls: 'warn', key: 'b_fcdiff' },
    changed: { cls: 'warn', key: 'b_fcchg' },
    'no-list': { cls: '', key: 'b_fcnone' },
    unreachable: { cls: '', key: 'b_fcfail' },
  };
  const PROBLEM_STATES = ['mismatched', 'missing', 'errored', 'unlisted', 'different'];
  const INDEX_STATES = ['exact', 'after-undoing-address', 'different', 'unlisted'];

  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const count = (value) => (Number.isInteger(value) && value >= 0 && value < 1e7 ? value : 0);
  const time = (value) => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  };

  function cleanResult(entry) {
    if (!entry || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(BADGE, entry.state)) return null;
    const counts = entry.counts && typeof entry.counts === 'object' ? entry.counts : {};
    const problems = (Array.isArray(entry.problems) ? entry.problems : [])
      .filter((p) => p && typeof p.path === 'string' && PROBLEM_STATES.includes(p.state))
      .slice(0, 10)
      .map((p) => ({ path: text(p.path, 200), state: p.state }));
    const history = (Array.isArray(entry.history) ? entry.history : [])
      .filter((h) => h && typeof h === 'object')
      .slice(-20)
      .map((h) => ({ at: time(h.at), clientVersion: text(h.clientVersion, 80), manifestHash: text(h.manifestHash, 64) }));
    const external = (Array.isArray(entry.externalResources) ? entry.externalResources : Array.isArray(entry.externalScripts) ? entry.externalScripts : [])
      .filter((e) => typeof e === 'string')
      .slice(0, 10)
      .map((e) => text(e, 200));
    return {
      state: entry.state,
      checkedAt: time(entry.checkedAt),
      clientVersion: text(entry.clientVersion, 80),
      fileCount: count(entry.fileCount),
      checked: count(entry.checked),
      counts: {
        matched: count(counts.matched),
        mismatched: count(counts.mismatched),
        missing: count(counts.missing),
        errored: count(counts.errored),
      },
      complete: entry.complete === true,
      indexHtml: INDEX_STATES.includes(entry.indexHtml) ? entry.indexHtml : '',
      versionChanged: entry.versionChanged === true,
      problems,
      history,
      external,
    };
  }

  // json: the parsed status.json. safeUrl: the page's own address check
  // (returns the origin or null). Returns { generatedAt, nodes: Map } or null.
  function parse(json, safeUrl) {
    if (!json || typeof json !== 'object' || !json.nodes || typeof json.nodes !== 'object') return null;
    const nodes = new Map();
    for (const [key, entry] of Object.entries(json.nodes).slice(0, 100)) {
      const origin = safeUrl(key);
      const result = origin ? cleanResult(entry) : null;
      if (result) nodes.set(origin, result);
    }
    return { generatedAt: time(json.generatedAt), nodes };
  }

  // How long ago, as { unit: 'minute' | 'hour' | 'day', n } (a minute at least).
  function ago(iso, nowMs) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    const minutes = Math.max(1, Math.round((nowMs - ms) / 60000));
    if (minutes < 90) return { unit: 'minute', n: minutes };
    if (minutes < 60 * 36) return { unit: 'hour', n: Math.round(minutes / 60) };
    return { unit: 'day', n: Math.round(minutes / 1440) };
  }

  root.FC = { BADGE, parse, ago };
})(typeof globalThis !== 'undefined' ? globalThis : this);
