// The part of the portal's "archive" line that is not about the page: reading archive.json and deciding what
// the line says. A classic script (no import/export) so that index.html can load it with a plain <script> tag;
// it puts one global, ARC. The page puts every text on screen with textContent.
//
// archive.json is data from outside (a scheduled run that reads the archive contract on the replication chain),
// so it is cleaned before use: unknown shapes are dropped and the counts must be plausible whole numbers that
// add up. The file says how many submissions are finalized, pending inside their challenge window, pending past
// the deadline ("overdue": anyone may finalize those), and slashed.
(function (root) {
  'use strict';

  const MAX = 1e9;
  const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}(?:\.\d+)?Z$/;
  const isCount = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX;

  // Returns { generatedAt, total, finalized, pendingInWindow, pendingOverdue, slashed, overdueIds, level }, or null
  // if the data is not usable. generatedAt is 'YYYY-MM-DD HH:MM' (UTC). level is 'warn' when a submission is overdue.
  function parse(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.schemaVersion !== 1 || data.kind !== 'caw-archive-status') return null;
    const stamp = typeof data.generatedAt === 'string' ? STAMP.exec(data.generatedAt) : null;
    if (!stamp) return null;
    const c = data.counts;
    if (!c || typeof c !== 'object') return null;
    const { finalized, pendingInWindow, pendingOverdue, slashed } = c;
    if (![finalized, pendingInWindow, pendingOverdue, slashed].every(isCount)) return null;
    const total = finalized + pendingInWindow + pendingOverdue + slashed;
    if (data.total !== undefined && data.total !== total) return null; // the counts do not add up: do not show half-true numbers
    const overdueIds = Array.isArray(data.overdue)
      ? data.overdue.slice(0, 50).map((item) => (item && typeof item === 'object' ? item.id : null)).filter(isCount)
      : [];
    return {
      generatedAt: stamp[1] + ' ' + stamp[2],
      total,
      finalized,
      pendingInWindow,
      pendingOverdue,
      slashed,
      overdueIds,
      level: pendingOverdue > 0 ? 'warn' : 'ok',
    };
  }

  root.ARC = { parse };
})(typeof globalThis !== 'undefined' ? globalThis : this);
