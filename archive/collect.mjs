// node archive/collect.mjs --out archive.json
// Writes archive.json (see lib.mjs). Exit 0 on success, 1 on a bad call, 2 if the chain could not be read
// (then nothing is written, so the last good file stays in place).
import { renameSync, writeFileSync } from 'node:fs';
import { collectArchive } from './lib.mjs';

const i = process.argv.indexOf('--out');
const out = i > 0 ? process.argv[i + 1] : null;
if (!out) {
  console.error('usage: node archive/collect.mjs --out archive.json');
  process.exit(1);
}
try {
  const status = await collectArchive();
  writeFileSync(out + '.tmp', JSON.stringify(status, null, 1) + '\n');
  renameSync(out + '.tmp', out);
  const c = status.counts;
  console.log(`archive: ${status.total} submissions, finalized ${c.finalized}, in window ${c.pendingInWindow}, overdue ${c.pendingOverdue}, slashed ${c.slashed}`);
} catch (error) {
  console.error('archive: ' + (error && error.message));
  process.exit(2);
}
