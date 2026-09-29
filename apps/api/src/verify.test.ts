import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { publicKeyOf, type Bulletin } from "@noir/bulletin";
import { makeWorld, type World } from "./test-helpers";
import { closeAndPublish, runElection, writeTemp } from "./lifecycle";

const script = fileURLToPath(new URL("../../../scripts/verify.ts", import.meta.url));
const verify = (file: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [script, file, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
};

let w: World;
let published: { text: string; bulletin: Bulletin };
let election: Awaited<ReturnType<typeof runElection>>;
let pubkey: string;
beforeAll(async () => {
  w = await makeWorld();
  election = await runElection(w, { voters: 20, votes: 17 });
  published = await closeAndPublish(w, election.pollId);
  pubkey = await publicKeyOf(w.key.privateKey);
});

describe("scripts/verify.ts (standalone, reads only the published file)", () => {
  it("accepts the untouched bulletin and reproduces the tally", () => {
    const r = verify(writeTemp("bulletin.json", published.text), "--pubkey", pubkey);
    expect(r.out).toContain("VERIFIED");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("FAIL");
  });

  it("proves a voter's receipt is included, and only theirs", () => {
    const file = writeTemp("bulletin.json", published.text);
    const mine = election.receipts[3]!;
    const ok = verify(file, "--pubkey", pubkey, "--receipt", mine.receipt);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`position`);
    expect(ok.out).toContain(mine.option);
    const missing = verify(file, "--pubkey", pubkey, "--receipt", "0".repeat(32));
    expect(missing.code).toBe(1);
  });

  it("fails when one ballot in the published file is changed", () => {
    const t = structuredClone(published.bulletin);
    const b = t.ballots[6]!;
    const other = election.options.find((o) => o.id !== b.selections[0]![1])!.id;
    b.selections = [[b.selections[0]![0], other]];
    const r = verify(writeTemp("tampered.json", JSON.stringify(t)), "--pubkey", pubkey);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL  merkle root recomputes");
    expect(r.out).toContain("FAIL  tally recomputes");
  });

  it("fails when a ballot is removed, added or reordered", () => {
    for (const mutate of [
      (t: Bulletin) => void t.ballots.splice(2, 1),
      (t: Bulletin) => void t.ballots.push({ receipt: "f".repeat(32), selections: t.ballots[0]!.selections }),
      (t: Bulletin) => void t.ballots.reverse(),
    ]) {
      const t = structuredClone(published.bulletin);
      mutate(t);
      expect(verify(writeTemp("t.json", JSON.stringify(t)), "--pubkey", pubkey).code).toBe(1);
    }
  });

  it("fails when the published tally or root is edited to match a tampered ballot", () => {
    const t = structuredClone(published.bulletin);
    const q = election.questionId;
    const [a, b] = election.options.map((o) => o.id) as [string, string];
    t.ballots.find((x) => x.selections[0]![1] === a)!.selections = [[q, b]];
    t.tally[q]![a]!--;
    t.tally[q]![b]!++;
    // The file is now consistent with itself except for the signature, which covers the original root.
    const r = verify(writeTemp("t.json", JSON.stringify(t)), "--pubkey", pubkey);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL  merkle root recomputes");
  });

  it("fails when someone re-signs with their own key and the pinned key is used", async () => {
    const forged = structuredClone(published.bulletin);
    const { generateSigningKey, buildBulletin } = await import("@noir/bulletin");
    const evil = await generateSigningKey();
    const rebuilt = await buildBulletin({
      poll: forged.poll, closedAt: new Date(forged.closedAt), eligibleCount: forged.eligibleCount, participationCount: forged.participationCount,
      ballots: forged.ballots.slice(1), privateKey: evil.privateKey,
    });
    const file = writeTemp("forged.json", JSON.stringify(rebuilt));
    expect(verify(file).code).toBe(1); // ballots != participations
    const pinned = verify(file, "--pubkey", pubkey);
    expect(pinned.out).toContain("FAIL  embedded public key equals the pinned key");
  });

  it("agrees with @noir/bulletin on the server-built file (two independent implementations)", () => {
    const out = execFileSync(process.execPath, [script, writeTemp("b.json", published.text)], { encoding: "utf8" });
    expect(out).toContain(published.bulletin.merkleRoot);
  });
});
