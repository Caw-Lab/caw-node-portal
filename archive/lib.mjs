// Reads the archive contract (CawActionsArchive) on the replication chain and says, for every submission, whether
// it is finalized, still inside its challenge window, past the deadline without being finalized ("overdue"), or
// slashed. Only eth_call and eth_getBlockByNumber are used; nothing is written to any chain and no key is involved.
// No dependencies: the two calls are encoded by hand.

// The testnet deployment of GilgameshCaw/Caw master 97cd13f3 (2026-09-21), network 1 archiving to Arbitrum Sepolia.
// If the contracts are deployed again, this keeps reading the old ones until the address is updated.
export const ARCHIVE = {
  rpc: 'https://arbitrum-sepolia-rpc.publicnode.com',
  to: '0x3B526a24a740F8FD5Ed9688E109414Ec10786B8D', // CawActionsArchive on Arbitrum Sepolia
  chain: 'arbitrum-sepolia',
};

const SELECTOR_NEXT_ID = '0x35b96901'; // nextSubmissionId()
const SELECTOR_SUBMISSIONS = '0xad73349e'; // submissions(uint256)
const STATUS = ['PENDING', 'FINALIZED', 'SLASHED'];
export const LIMITS = { maxSubmissions: 5000, concurrency: 4, responseBytes: 8192 };
const USER_AGENT = 'caw-node-portal-archive/0.1 (+https://github.com/Caw-Lab/caw-node-portal)';

export async function rpcCall(rpc, method, params, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const response = await fetchImpl(rpc, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > LIMITS.responseBytes) throw new Error(`${method}: answer too large`);
  const body = JSON.parse(text);
  if (body.error || body.result === undefined || body.result === null) throw new Error(`${method}: no result`);
  return body.result;
}

const word = (n) => BigInt(n).toString(16).padStart(64, '0');

// The eight fields of the submissions(uint256) getter are all static, so the answer is 8 words of 32 bytes:
// submitter, merkleRoot, networkId, startCheckpointId, endCheckpointId, finalizedAt, status, dataCommitment.
export function decodeSubmission(id, hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-f]{512}$/i.test(hex)) throw new Error(`submission ${id}: unexpected answer`);
  const w = (i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  const status = Number(w(6));
  if (status >= STATUS.length) throw new Error(`submission ${id}: unknown status ${status}`);
  const num = (i) => {
    const v = w(i);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`submission ${id}: number too large`);
    return Number(v);
  };
  return { id, networkId: num(2), startCheckpoint: num(3), endCheckpoint: num(4), deadline: num(5), status: STATUS[status] };
}

export function buildStatus({ now, chainTime, submissions }) {
  const pending = submissions.filter((s) => s.status === 'PENDING');
  const overdue = pending
    .filter((s) => chainTime > s.deadline)
    .map((s) => ({ id: s.id, endCheckpoint: s.endCheckpoint, overdueSeconds: chainTime - s.deadline }));
  const inWindow = pending
    .filter((s) => chainTime <= s.deadline)
    .map((s) => ({ id: s.id, endCheckpoint: s.endCheckpoint, secondsLeft: s.deadline - chainTime }));
  return {
    schemaVersion: 1,
    kind: 'caw-archive-status',
    generatedAt: new Date(now).toISOString(),
    chain: ARCHIVE.chain,
    archive: ARCHIVE.to,
    chainTime,
    total: submissions.length,
    counts: {
      finalized: submissions.filter((s) => s.status === 'FINALIZED').length,
      pendingInWindow: inWindow.length,
      pendingOverdue: overdue.length,
      slashed: submissions.filter((s) => s.status === 'SLASHED').length,
    },
    overdue,
    inWindow,
  };
}

// Reads everything or fails: a half-read list would show wrong counts, so nothing partial is returned.
export async function collectArchive({ archive = ARCHIVE, now = Date.now(), fetchImpl, timeoutMs } = {}) {
  const opts = { fetchImpl, timeoutMs };
  const block = await rpcCall(archive.rpc, 'eth_getBlockByNumber', ['latest', false], opts);
  const chainTime = Number(BigInt(block.timestamp));
  const next = BigInt(await rpcCall(archive.rpc, 'eth_call', [{ to: archive.to, data: SELECTOR_NEXT_ID }, 'latest'], opts));
  if (next < 1n || next - 1n > BigInt(LIMITS.maxSubmissions)) throw new Error(`implausible submission count: ${next - 1n}`);
  const ids = Array.from({ length: Number(next) - 1 }, (_, i) => i + 1);
  const submissions = new Array(ids.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const index = cursor++;
      const hex = await rpcCall(archive.rpc, 'eth_call', [{ to: archive.to, data: SELECTOR_SUBMISSIONS + word(ids[index]) }, 'latest'], opts);
      submissions[index] = decodeSubmission(ids[index], hex);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, ids.length) }, worker));
  return buildStatus({ now, chainTime, submissions });
}
