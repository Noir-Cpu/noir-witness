import { describe, expect, it } from "vitest";
import {
  buildBulletin, generateSigningKey, inclusionPath, ballotLeaves, merkleRoot, proveReceipt, rootFromPath,
  verifyBulletin, toHex, type Bulletin, type BulletinPoll,
} from "./index";

const poll: BulletinPoll = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Chair",
  questions: [{ id: "q1", prompt: "Who?", options: [{ id: "a", label: "Ada" }, { id: "b", label: "Bo" }] }],
};

async function make(n: number) {
  const key = await generateSigningKey();
  const ballots = Array.from({ length: n }, (_, i) => ({
    receipt: (i * 7919 + 13).toString(16).padStart(8, "0"),
    selections: [["q1", i % 3 === 0 ? "a" : "b"]] as [string, string][],
  }));
  return buildBulletin({ poll, closedAt: new Date(0), eligibleCount: n + 2, participationCount: n, ballots, privateKey: key.privateKey });
}

describe("merkle tree", () => {
  it("empty root is SHA-256 of nothing", async () => {
    expect(await merkleRoot([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it.each([1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 33])("inclusion proofs verify for every leaf of %i", async (n) => {
    const b = await make(n);
    const leaves = await ballotLeaves(poll.id, b.ballots);
    for (let i = 0; i < n; i++) {
      const path = await inclusionPath(leaves, i);
      expect(await rootFromPath(leaves[i]!, i, n, path)).toBe(b.merkleRoot);
    }
  });

  it("a proof fails for the wrong index", async () => {
    const b = await make(6);
    const leaves = await ballotLeaves(poll.id, b.ballots);
    const path = await inclusionPath(leaves, 2);
    expect(await rootFromPath(leaves[2]!, 3, 6, path)).not.toBe(b.merkleRoot);
  });
});

describe("bulletin", () => {
  it("verifies when untouched", async () => {
    const b = await make(20);
    const checks = await verifyBulletin(b);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(b.ballots.map((x) => x.receipt)).toEqual([...b.ballots.map((x) => x.receipt)].sort());
  });

  it("fails when a ballot is changed", async () => {
    const b = await make(20);
    const t: Bulletin = structuredClone(b);
    t.ballots[4]!.selections = [["q1", t.ballots[4]!.selections[0]![1] === "a" ? "b" : "a"]];
    const failed = (await verifyBulletin(t)).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain("merkle root recomputes");
    expect(failed).toContain("tally recomputes");
  });

  it("fails when the key is not the pinned one", async () => {
    const b = await make(3);
    const other = await generateSigningKey();
    expect((await verifyBulletin(b, { pinnedPublicKey: other.publicKey })).some((c) => !c.ok)).toBe(true);
  });

  it("proves a receipt and rejects an unknown one", async () => {
    const b = await make(9);
    const proof = await proveReceipt(b, b.ballots[5]!.receipt);
    expect(proof?.ok).toBe(true);
    expect(await proveReceipt(b, "nope")).toBeNull();
    expect(toHex(new Uint8Array(1))).toBe("00");
  });
});
