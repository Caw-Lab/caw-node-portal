// The part of the portal's "network numbers" display that is not about the page: reading network.json and
// turning numbers into text and into a small line. A classic script (no import/export) so that index.html can
// load it with a plain <script> tag; it puts one global, NET. The page puts every text on screen with textContent.
//
// network.json is data from the network (it is produced by a scheduled run that reads what nodes say about
// themselves), so it is cleaned before use: unknown shapes are dropped, numbers must be plausible whole numbers.
(function (root) {
  'use strict';

  const MAX = 1e12;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  const isCount = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX;
  const orNull = (value) => (isCount(value) ? value : null);

  function entry(item) {
    if (!item || typeof item !== 'object' || typeof item.date !== 'string' || !DATE.test(item.date)) return null;
    return {
      date: item.date,
      users: orNull(item.users),
      posts: orNull(item.posts),
      activeWeek: orNull(item.activeWeek),
      actions: orNull(item.actions),
      depositedWei: typeof item.depositedWei === 'string' && /^\d{1,80}$/.test(item.depositedWei) ? item.depositedWei : null,
      nodesAsked: orNull(item.nodesAsked),
      nodesAnswered: orNull(item.nodesAnswered),
    };
  }

  // Which addresses serve a frontend, as the scheduled run saw it: { 'https://host': 'served' | 'api-only' }. Only those two words are kept.
  function frontends(data) {
    const out = Object.create(null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
    for (const [key, value] of Object.entries(data).slice(0, 200)) {
      if (key.length <= 200 && /^https:\/\/[a-z0-9.-]+$/.test(key) && (value === 'served' || value === 'api-only')) out[key] = value;
    }
    return out;
  }

  // Returns { latest, history, generatedAt, frontends } (generatedAt is a date, YYYY-MM-DD), or null if the data is not usable.
  function parse(data) {
    if (!data || typeof data !== 'object' || data.schemaVersion !== 1 || data.kind !== 'caw-network-stats') return null;
    const latest = entry(data.latest);
    if (!latest) return null;
    const history = Array.isArray(data.history) ? data.history.slice(-400).map(entry).filter(Boolean) : [];
    const generatedAt = typeof data.generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(data.generatedAt) ? data.generatedAt.slice(0, 10) : latest.date;
    return { latest, history, generatedAt, frontends: frontends(data.frontends) };
  }

  function groupDigits(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // The CAW held (a whole number of wei as text, 18 decimals) as text: grouped digits up to 999,999,999, then 1.10×10¹⁹.
  function formatCaw(wei) {
    if (typeof wei !== 'string' || !/^\d{1,80}$/.test(wei)) return null;
    const whole = (BigInt(wei) / 10n ** 18n).toString();
    if (whole.length <= 9) return groupDigits(whole);
    const exponent = whole.length - 1;
    const power = String(exponent).split('').map((digit) => SUPERSCRIPT[Number(digit)]).join('');
    return whole[0] + '.' + whole.slice(1, 3) + '×10' + power;
  }

  // The values of one number over the days (oldest first), as a number (or null) for each day. The CAW held is a
  // text of up to 80 digits; as a number it is only approximate, which is enough for the shape of a line.
  function series(history, key) {
    return history.map((item) => {
      const value = item[key];
      if (value === null) return null;
      return typeof value === 'string' ? Number(value) : value;
    });
  }

  // The points of a line ("x,y x,y …") for the values that exist, spread evenly over `width`, or null if fewer than two.
  function sparkPoints(values, width, height) {
    const known = values.map((value, index) => ({ value, index })).filter((item) => typeof item.value === 'number');
    if (known.length < 2) return null;
    const low = Math.min(...known.map((item) => item.value));
    const high = Math.max(...known.map((item) => item.value));
    const span = values.length - 1 || 1;
    return known
      .map((item) => {
        const x = (item.index / span) * width;
        const y = high === low ? height / 2 : height - ((item.value - low) / (high - low)) * height;
        return x.toFixed(1) + ',' + y.toFixed(1);
      })
      .join(' ');
  }

  root.NET = { parse, formatCaw, groupDigits, series, sparkPoints };
})(typeof globalThis !== 'undefined' ? globalThis : this);
