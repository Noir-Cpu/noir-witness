// The bulletin: canonical ballot encoding, the Merkle tree (RFC 6962 shape), Ed25519 signing, and full verification.
// Pure WebCrypto, no I/O, so it runs on Workers, in Node and in the browser. scripts/verify.ts carries its own
// independent copy of the verification half so an auditor need not trust this package (ADR 0011).

export type Selection = [questionId: string, optionId: string];

export type BulletinPoll = {
  id: string;
  title: string;
  questions: { id: string; prompt: string; options: { id: string; label: string }[] }[];
};

export type Bulletin = {
  version: 1;
  poll: BulletinPoll;
  closedAt: string;
  eligibleCount: number;
  participationCount: number;
  ballotCount: number;
  // Sorted by receipt. Never in insertion order (ADR 0005).
  ballots: { receipt: string; selections: Selection[] }[];
  tally: Record<string, Record<string, number>>;
  merkleRoot: string;
  signature: string;
  publicKey: string;
};

const enc = new TextEncoder();

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
export const toB64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

export function canonicalSelections(selections: Selection[]): string {
  return JSON.stringify([...selections].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

export const compareReceipts = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function leafHash(pollId: string, receipt: string, selections: Selection[]): Promise<Uint8Array> {
  return sha256(LEAF, enc.encode(`${pollId}\n${receipt}\n${canonicalSelections(selections)}`));
}

const largestPowerOfTwoBelow = (n: number) => 2 ** Math.floor(Math.log2(n - 1));

async function mth(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) return sha256();
  if (leaves.length === 1) return leaves[0]!;
  const k = largestPowerOfTwoBelow(leaves.length);
  return sha256(NODE, await mth(leaves.slice(0, k)), await mth(leaves.slice(k)));
}

export const merkleRoot = async (leaves: Uint8Array[]) => toHex(await mth(leaves));

// Audit path for the leaf at `index` (RFC 6962 section 2.1.1).
export async function inclusionPath(leaves: Uint8Array[], index: number): Promise<string[]> {
  if (index < 0 || index >= leaves.length) throw new RangeError("leaf index out of range");
  const walk = async (m: number, ls: Uint8Array[]): Promise<Uint8Array[]> => {
    if (ls.length === 1) return [];
    const k = largestPowerOfTwoBelow(ls.length);
    return m < k ? [...(await walk(m, ls.slice(0, k))), await mth(ls.slice(k))] : [...(await walk(m - k, ls.slice(k))), await mth(ls.slice(0, k))];
  };
  return (await walk(index, leaves)).map(toHex);
}

// Root reconstruction from a leaf and its path (RFC 9162 section 2.1.3.2).
export async function rootFromPath(leaf: Uint8Array, index: number, size: number, path: string[]): Promise<string | null> {
  if (index < 0 || index >= size) return null;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const hex of path) {
    if (sn === 0) return null;
    const p = fromHex(hex);
    if (fn % 2 === 1 || fn === sn) {
      r = await sha256(NODE, p, r);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      r = await sha256(NODE, r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 ? toHex(r) : null;
}

export function tallyBallots(poll: BulletinPoll, ballots: { selections: Selection[] }[]): Record<string, Record<string, number>> {
  const t: Record<string, Record<string, number>> = {};
  for (const q of poll.questions) t[q.id] = Object.fromEntries(q.options.map((o) => [o.id, 0]));
  for (const b of ballots) for (const [q, o] of b.selections) if (t[q]?.[o] !== undefined) t[q]![o]!++;
  return t;
}

// True when the selections answer every question exactly once with an option of that question.
export function selectionsValid(poll: BulletinPoll, selections: Selection[]): boolean {
  if (selections.length !== poll.questions.length) return false;
  const seen = new Set<string>();
  for (const [q, o] of selections) {
    const question = poll.questions.find((x) => x.id === q);
    if (!question || seen.has(q) || !question.options.some((x) => x.id === o)) return false;
    seen.add(q);
  }
  return true;
}

export const signedMessage = (pollId: string, root: string, ballotCount: number) => enc.encode(`witness/v1\n${pollId}\n${root}\n${ballotCount}`);

// ---- Ed25519 ------------------------------------------------------------------------------------------------

export async function generateSigningKey() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    privateKey: toB64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    publicKey: toB64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
  };
}

// Derives the raw public key from a PKCS#8 Ed25519 private key via JWK export.
export async function publicKeyOf(privateKeyPkcs8: string): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", fromB64u(privateKeyPkcs8), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return jwk.x!;
}

export async function signRoot(privateKeyPkcs8: string, pollId: string, root: string, ballotCount: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", fromB64u(privateKeyPkcs8), { name: "Ed25519" }, false, ["sign"]);
  return toB64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, signedMessage(pollId, root, ballotCount))));
}

export async function verifySignature(publicKeyRaw: string, signature: string, pollId: string, root: string, ballotCount: number): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromB64u(publicKeyRaw), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64u(signature), signedMessage(pollId, root, ballotCount));
  } catch {
    return false;
  }
}

// ---- Build and verify ---------------------------------------------------------------------------------------

export async function ballotLeaves(pollId: string, ballots: Bulletin["ballots"]) {
  return Promise.all(ballots.map((b) => leafHash(pollId, b.receipt, b.selections)));
}

export async function buildBulletin(input: {
  poll: BulletinPoll;
  closedAt: Date;
  eligibleCount: number;
  participationCount: number;
  ballots: Bulletin["ballots"];
  privateKey: string;
}): Promise<Bulletin> {
  const ballots = input.ballots
    .map((b) => ({ receipt: b.receipt, selections: [...b.selections].sort((a, c) => compareReceipts(a[0], c[0])) }))
    .sort((a, b) => compareReceipts(a.receipt, b.receipt));
  const root = await merkleRoot(await ballotLeaves(input.poll.id, ballots));
  return {
    version: 1,
    poll: input.poll,
    closedAt: input.closedAt.toISOString(),
    eligibleCount: input.eligibleCount,
    participationCount: input.participationCount,
    ballotCount: ballots.length,
    ballots,
    tally: tallyBallots(input.poll, ballots),
    merkleRoot: root,
    signature: await signRoot(input.privateKey, input.poll.id, root, ballots.length),
    publicKey: await publicKeyOf(input.privateKey),
  };
}

export type Check = { name: string; ok: boolean; detail?: string };

// Runs every check and reports each one; nothing short-circuits so an auditor sees the full picture.
export async function verifyBulletin(b: Bulletin, opts: { pinnedPublicKey?: string } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  const sorted = b.ballots.every((x, i) => i === 0 || compareReceipts(b.ballots[i - 1]!.receipt, x.receipt) < 0);
  add("ballots sorted by receipt, no duplicates", sorted);
  add("every ballot answers each question once with a valid option", b.ballots.every((x) => selectionsValid(b.poll, x.selections)));
  add("ballot count matches", b.ballotCount === b.ballots.length, `${b.ballots.length} ballots`);
  add("ballots equal participations", b.ballotCount === b.participationCount, `${b.ballotCount} vs ${b.participationCount}`);
  add("participations do not exceed the eligible roll", b.participationCount <= b.eligibleCount);

  const root = await merkleRoot(await ballotLeaves(b.poll.id, b.ballots));
  add("merkle root recomputes", root === b.merkleRoot, root);

  add("tally recomputes", JSON.stringify(tallyBallots(b.poll, b.ballots)) === JSON.stringify(b.tally));

  const sigOk = await verifySignature(b.publicKey, b.signature, b.poll.id, b.merkleRoot, b.ballotCount);
  add("signature valid for the embedded public key", sigOk);
  if (opts.pinnedPublicKey) add("embedded public key equals the pinned key", opts.pinnedPublicKey === b.publicKey);
  return checks;
}

export async function proveReceipt(b: Bulletin, receipt: string) {
  const index = b.ballots.findIndex((x) => x.receipt === receipt);
  if (index < 0) return null;
  const leaves = await ballotLeaves(b.poll.id, b.ballots);
  const path = await inclusionPath(leaves, index);
  const root = await rootFromPath(leaves[index]!, index, leaves.length, path);
  return { index, size: leaves.length, path, root, ok: root === b.merkleRoot, selections: b.ballots[index]!.selections };
}
