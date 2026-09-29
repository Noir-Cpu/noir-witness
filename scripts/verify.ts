#!/usr/bin/env -S node
// WITNESS bulletin verifier. Standalone on purpose: it imports nothing from this repository and talks to no server.
// It reads one published bulletin file and recomputes everything from it.
//
//   node scripts/verify.ts bulletin.json [--pubkey <base64url Ed25519 public key>] [--receipt <receipt>]
//
// Exit code 0 when every check passes, 1 otherwise. Without --pubkey the signature is checked against the key
// embedded in the file, which proves the file is self-consistent but not who signed it: pin the key you got from the
// organiser or from /api/signing-key.
import { readFileSync } from "node:fs";

type Selection = [string, string];
type Bulletin = {
  poll: { id: string; questions: { id: string; options: { id: string }[] }[] };
  eligibleCount: number;
  participationCount: number;
  ballotCount: number;
  ballots: { receipt: string; selections: Selection[] }[];
  tally: Record<string, Record<string, number>>;
  merkleRoot: string;
  signature: string;
  publicKey: string;
};

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function sha(...parts: Uint8Array[]) {
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (buf.set(p, o), (o += p.length));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

// Merkle tree as in RFC 6962: leaf = H(0x00 || data), node = H(0x01 || left || right), split at the largest power of two below n.
const leaf = (pollId: string, b: { receipt: string; selections: Selection[] }) => {
  const canon = JSON.stringify([...b.selections].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
  return sha(new Uint8Array([0]), enc.encode(`${pollId}\n${b.receipt}\n${canon}`));
};
async function root(ls: Uint8Array[]): Promise<Uint8Array> {
  if (ls.length === 0) return sha();
  if (ls.length === 1) return ls[0]!;
  const k = 2 ** Math.floor(Math.log2(ls.length - 1));
  return sha(new Uint8Array([1]), await root(ls.slice(0, k)), await root(ls.slice(k)));
}
async function path(ls: Uint8Array[], m: number): Promise<Uint8Array[]> {
  if (ls.length === 1) return [];
  const k = 2 ** Math.floor(Math.log2(ls.length - 1));
  return m < k ? [...(await path(ls.slice(0, k), m)), await root(ls.slice(k))] : [...(await path(ls.slice(k), m - k)), await root(ls.slice(0, k))];
}
async function climb(leafHash: Uint8Array, index: number, size: number, p: Uint8Array[]) {
  let fn = index;
  let sn = size - 1;
  let r = leafHash;
  for (const s of p) {
    if (sn === 0) return null;
    if (fn % 2 === 1 || fn === sn) {
      r = await sha(new Uint8Array([1]), s, r);
      while (fn % 2 === 0 && fn !== 0) (fn >>= 1, (sn >>= 1));
    } else r = await sha(new Uint8Array([1]), r, s);
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 ? hex(r) : null;
}

function tally(b: Bulletin) {
  const t: Record<string, Record<string, number>> = {};
  for (const q of b.poll.questions) t[q.id] = Object.fromEntries(q.options.map((o) => [o.id, 0]));
  for (const x of b.ballots) for (const [q, o] of x.selections) if (t[q]?.[o] !== undefined) t[q]![o]!++;
  return t;
}

function validSelections(b: Bulletin, s: Selection[]) {
  if (s.length !== b.poll.questions.length) return false;
  const seen = new Set<string>();
  return s.every(([q, o]) => {
    const question = b.poll.questions.find((x) => x.id === q);
    if (!question || seen.has(q) || !question.options.some((x) => x.id === o)) return false;
    seen.add(q);
    return true;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!file) {
    console.error("usage: node scripts/verify.ts bulletin.json [--pubkey KEY] [--receipt RECEIPT]");
    process.exit(2);
  }
  const b = JSON.parse(readFileSync(file, "utf8")) as Bulletin;
  const pinned = flag("--pubkey");
  const receipt = flag("--receipt");

  let failed = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  };

  const leaves = await Promise.all(b.ballots.map((x) => leaf(b.poll.id, x)));
  const computedRoot = hex(await root(leaves));

  check("ballots sorted by receipt, no duplicates", b.ballots.every((x, i) => i === 0 || b.ballots[i - 1]!.receipt < x.receipt));
  check("every ballot answers each question once with a valid option", b.ballots.every((x) => validSelections(b, x.selections)));
  check("ballot count matches", b.ballotCount === b.ballots.length, `${b.ballots.length} ballots`);
  check("ballots equal participations", b.ballotCount === b.participationCount, `${b.ballotCount} vs ${b.participationCount}`);
  check("participations do not exceed the eligible roll", b.participationCount <= b.eligibleCount, `${b.participationCount} of ${b.eligibleCount}`);
  check("merkle root recomputes", computedRoot === b.merkleRoot, computedRoot);
  const t = tally(b);
  check("tally recomputes", JSON.stringify(t) === JSON.stringify(b.tally));

  let sigOk = false;
  try {
    const key = await crypto.subtle.importKey("raw", unb64u(b.publicKey), { name: "Ed25519" }, false, ["verify"]);
    const msg = enc.encode(`witness/v1\n${b.poll.id}\n${b.merkleRoot}\n${b.ballotCount}`);
    sigOk = await crypto.subtle.verify({ name: "Ed25519" }, key, unb64u(b.signature), msg);
  } catch {
    sigOk = false;
  }
  check("signature valid for the embedded public key", sigOk);
  if (pinned) check("embedded public key equals the pinned key", pinned === b.publicKey);
  else console.log("NOTE  no --pubkey given: the signer is not authenticated, only the file's consistency");

  if (receipt) {
    const i = b.ballots.findIndex((x) => x.receipt === receipt);
    if (i < 0) check(`receipt ${receipt} is in the bulletin`, false);
    else {
      const r = await climb(leaves[i]!, i, leaves.length, await path(leaves, i));
      check(`receipt ${receipt} is in the bulletin, position ${i + 1} of ${leaves.length}`, r === b.merkleRoot);
      console.log(`      your ballot as counted: ${JSON.stringify(b.ballots[i]!.selections)}`);
    }
  }

  console.log("\nTally:");
  for (const q of b.poll.questions) console.log(`  ${q.id}: ${q.options.map((o) => `${o.id}=${t[q.id]![o.id]}`).join("  ")}`);
  console.log(failed ? `\nVERIFICATION FAILED (${failed} check${failed > 1 ? "s" : ""})` : "\nVERIFIED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("VERIFICATION FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
