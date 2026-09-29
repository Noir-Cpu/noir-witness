import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEvents, eligibleVoters, polls } from "@noir/db";
import { makeWorld, seedOpenPoll, type World } from "./test-helpers";
import { closeAndPublish, runElection } from "./lifecycle";
import { hashStudentNumber } from "./domain/crypto";

let w: World;
beforeAll(async () => void (w = await makeWorld()));

const j = (path: string, method = "POST", body?: unknown) => w.json(method, path, body);

describe("organiser API", () => {
  it("needs a signed-in organiser", async () => {
    const other = await makeWorld({ organiser: null });
    expect((await other.request("/api/organiser/polls")).status).toBe(403);
  });

  it("runs a poll from draft to published", async () => {
    const e = await runElection(w);
    expect(e.roll).toEqual({ voters: 14, duplicatesIgnored: 1 });

    const open = (await (await w.request(`/api/organiser/polls/${e.pollId}`)).json()) as Record<string, unknown>;
    expect(open.status).toBe("open");
    expect(open.turnout).toBeNull(); // hidden while open
    expect(open.eligible).toBe(14);

    expect((await w.request(`/api/polls/${e.pollId}/bulletin`)).status).toBe(404);
    const { bulletin } = await closeAndPublish(w, e.pollId);
    expect(bulletin.ballotCount).toBe(12);
    expect(bulletin.participationCount).toBe(12);
    expect(bulletin.eligibleCount).toBe(14);
    expect(Object.values(bulletin.tally[e.questionId]!).reduce((a, b) => a + b, 0)).toBe(12);

    const closed = (await (await w.request(`/api/organiser/polls/${e.pollId}`)).json()) as Record<string, unknown>;
    expect(closed.turnout).toBe(12);
    expect(closed.published).toBe(true);
  });

  it("close is idempotent and returns the same root", async () => {
    const e = await runElection(w, { voters: 12, votes: 3 });
    const a = (await (await j(`/api/organiser/polls/${e.pollId}/close`)).json()) as { merkleRoot: string };
    const b = (await (await j(`/api/organiser/polls/${e.pollId}/close`)).json()) as { merkleRoot: string };
    expect(a.merkleRoot).toBe(b.merkleRoot);
  });

  it("finishes a close that stopped after the status change", async () => {
    const e = await runElection(w, { voters: 12, votes: 3 });
    await w.db.update(polls).set({ status: "closed", closedAt: new Date() }).where(eq(polls.id, e.pollId));
    const res = await j(`/api/organiser/polls/${e.pollId}/close`);
    expect(res.status).toBe(200);
    expect((await w.db.query.polls.findFirst({ where: eq(polls.id, e.pollId) }))?.bulletin).toBeTruthy();
  });

  it("does not let another organiser see or change a poll", async () => {
    const e = await runElection(w, { voters: 12, votes: 1 });
    w.actAs("organiser-2");
    try {
      expect((await w.request(`/api/organiser/polls/${e.pollId}`)).status).toBe(404);
      expect((await j(`/api/organiser/polls/${e.pollId}/close`)).status).toBe(404);
      expect(((await (await w.request("/api/organiser/polls")).json()) as { polls: unknown[] }).polls).toEqual([]);
    } finally {
      w.actAs("organiser-1");
    }
  });

  it("refuses to open without options, roll or invite", async () => {
    const created = (await (await j("/api/organiser/polls", "POST", { organisation: "S", title: "T", question: "Q", options: ["only one"] })).json()) as { id: string };
    expect((await j(`/api/organiser/polls/${created.id}/open`)).status).toBe(400);
    await j(`/api/organiser/polls/${created.id}/options`, "POST", { label: "second" });
    expect((await j(`/api/organiser/polls/${created.id}/open`)).status).toBe(400);
    await w.request(`/api/organiser/polls/${created.id}/roll`, { method: "PUT", headers: { "content-type": "text/csv" }, body: "S1234567\nS1234568" });
    const noInvite = await j(`/api/organiser/polls/${created.id}/open`);
    expect(((await noInvite.json()) as { error: string }).error).toBe("needs_invite");
  });

  it("locks the roll and options once open", async () => {
    const e = await runElection(w, { voters: 12, votes: 0 });
    const roll = await w.request(`/api/organiser/polls/${e.pollId}/roll`, { method: "PUT", headers: { "content-type": "text/csv" }, body: "S9999999" });
    expect(roll.status).toBe(409);
    expect((await j(`/api/organiser/polls/${e.pollId}/options`, "POST", { label: "late" })).status).toBe(409);
  });

  it("rejects an unreadable roll and a roll sent as the wrong content type", async () => {
    const created = (await (await j("/api/organiser/polls", "POST", { organisation: "S", title: "T2", question: "Q", options: ["a", "b"] })).json()) as { id: string };
    const bad = await w.request(`/api/organiser/polls/${created.id}/roll`, { method: "PUT", headers: { "content-type": "text/csv" }, body: "S1234567\n<script>" });
    expect(bad.status).toBe(400);
    const wrong = await w.request(`/api/organiser/polls/${created.id}/roll`, { method: "PUT", headers: { "content-type": "text/plain" }, body: "S1234567" });
    expect(wrong.status).toBe(400);
  });

  it("stores student numbers only as per-poll salted hashes", async () => {
    const e = await runElection(w, { voters: 12, votes: 0 });
    const rows = await w.db.select().from(eligibleVoters).where(eq(eligibleVoters.pollId, e.pollId));
    const poll = await w.db.query.polls.findFirst({ where: eq(polls.id, e.pollId) });
    for (const n of e.voters.map((v) => v.number)) {
      expect(rows.some((r) => r.studentHash === n || r.studentHash.includes(n))).toBe(false);
    }
    const other = await runElection(w, { voters: 12, votes: 0 });
    const otherPoll = await w.db.query.polls.findFirst({ where: eq(polls.id, other.pollId) });
    expect(poll!.rollSalt).not.toBe(otherPoll!.rollSalt);
    // The same student number hashes differently in two polls, so rolls cannot be matched across polls.
    expect(await hashStudentNumber(poll!.rollSalt, "S1000000")).not.toBe(await hashStudentNumber(otherPoll!.rollSalt, "S1000000"));
    // Normalisation: case and inner spaces do not matter.
    expect(await hashStudentNumber(poll!.rollSalt, " s1000 000 ")).toBe(await hashStudentNumber(poll!.rollSalt, "S1000000"));
  });

  it("flags electorates under 10", async () => {
    const created = (await (await j("/api/organiser/polls", "POST", { organisation: "S", title: "Tiny", question: "Q", options: ["a", "b"] })).json()) as { id: string };
    await w.request(`/api/organiser/polls/${created.id}/roll`, { method: "PUT", headers: { "content-type": "text/csv" }, body: "S1000001\nS1000002\nS1000003" });
    const d = (await (await w.request(`/api/organiser/polls/${created.id}`)).json()) as { smallElectorate: boolean };
    expect(d.smallElectorate).toBe(true);
    const e = await runElection(w, { voters: 14, votes: 0 });
    const big = (await (await w.request(`/api/organiser/polls/${e.pollId}`)).json()) as { smallElectorate: boolean };
    expect(big.smallElectorate).toBe(false);
  });

  it("resets a passkey only for a voter who has not voted, and logs it", async () => {
    const e = await runElection(w, { voters: 12, votes: 1 });
    const voted = await j(`/api/organiser/polls/${e.pollId}/voters/reset`, "POST", { studentNumber: e.voters[0]!.number });
    expect(voted.status).toBe(409);
    await w.db.update(eligibleVoters).set({ credentialId: "abc", credentialPublicKey: "k", credentialCounter: 0 }).where(eq(eligibleVoters.id, e.voters[5]!.id));
    expect((await j(`/api/organiser/polls/${e.pollId}/voters/reset`, "POST", { studentNumber: e.voters[5]!.number })).status).toBe(200);
    expect((await w.db.query.eligibleVoters.findFirst({ where: eq(eligibleVoters.id, e.voters[5]!.id) }))?.credentialId).toBeNull();
    expect(await w.db.query.auditEvents.findFirst({ where: and(eq(auditEvents.pollId, e.pollId), eq(auditEvents.action, "voter.passkey_reset")) })).toBeTruthy();
  });

  it("serves the public signing key", async () => {
    const res = await w.request("/api/signing-key");
    expect(((await res.json()) as { publicKey: string }).publicKey).toHaveLength(43);
    expect((await seedOpenPoll(w.db, 1)).voterIds).toHaveLength(1);
  });
});
