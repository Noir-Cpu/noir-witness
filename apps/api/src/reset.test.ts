import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditEvents, eligibleVoters } from "@noir/db";
import { createApp } from "./app";
import { runElection } from "./lifecycle";
import { makeWorld, type World } from "./test-helpers";

// ADR 0013: a passkey reset must not tell the organiser whether a number is on the roll or whether that student has voted.

const reset = (w: World, pollId: string, studentNumber: string, app = w.app) =>
  app.request(`/api/organiser/polls/${pollId}/voters/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ studentNumber }) }, w.env);

// The same app over the same database, with every query counted.
function counting(w: World) {
  const counts = { n: 0 };
  const wrap = <T extends object>(o: T, path: string): T =>
    new Proxy(o, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (typeof k !== "string") return v;
        if (path === "" && ["select", "update", "insert", "delete", "execute"].includes(k) && typeof v === "function") {
          return (...a: unknown[]) => ((counts.n += 1), (v as (...x: unknown[]) => unknown).apply(t, a));
        }
        if (path === "" && k === "query") return wrap(v as object, "query");
        if (path === "query") return wrap(v as object, "table");
        if (path === "table" && typeof v === "function") return (...a: unknown[]) => ((counts.n += 1), (v as (...x: unknown[]) => unknown).apply(t, a));
        return v;
      },
    });
  const db = wrap(w.db, "");
  const app = createApp({ db, now: () => w.clock.now, organiser: async () => ({ id: "organiser-1", name: "organiser-1" }) });
  return { app, counts };
}

async function bodyOf(res: Response) {
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k !== "x-request-id") h[k] = v;
  });
  return JSON.stringify({ status: res.status, headers: h, body: await res.text() });
}

describe("organiser passkey reset leaks nothing about the roll or about who has voted", () => {
  it("answers byte for byte the same for a voter who voted, one who did not, a claimed one and a number not on the roll", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 3 }); // voters 0..2 have voted
    await w.db.update(eligibleVoters).set({ credentialId: "abc", credentialPublicKey: "k", credentialCounter: 0 }).where(eq(eligibleVoters.id, e.voters[5]!.id));
    const cases = {
      voted: e.voters[0]!.number,
      notVoted: e.voters[8]!.number,
      claimedNotVoted: e.voters[5]!.number,
      notOnRoll: "S0000001",
      oddlyFormatted: "  s 99 ",
    };
    const seen: Record<string, string> = {};
    for (const [name, number] of Object.entries(cases)) seen[name] = await bodyOf(await reset(w, e.pollId, number));
    const distinct = new Set(Object.values(seen));
    expect([...distinct]).toHaveLength(1);
    const parsed = JSON.parse([...distinct][0]!) as { status: number; body: string };
    expect(parsed.status).toBe(200);
    expect(JSON.parse(parsed.body)).toEqual({ ok: true });
  });

  it("does the same number of database operations in every case", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 3 });
    const { app, counts } = counting(w);
    const used: Record<string, number> = {};
    for (const [name, number] of Object.entries({ voted: e.voters[0]!.number, notVoted: e.voters[8]!.number, notOnRoll: "S0000001" })) {
      counts.n = 0;
      expect((await reset(w, e.pollId, number, app)).status).toBe(200);
      used[name] = counts.n;
    }
    expect(used.voted).toBeGreaterThan(0);
    expect(new Set(Object.values(used)).size).toBe(1);
  });

  it("writes an audit row that is identical in every case: no student number, no voted flag, no outcome", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 3 });
    const numbers = [e.voters[0]!.number, e.voters[8]!.number, "S0000001"];
    for (const n of numbers) await reset(w, e.pollId, n);
    const rows = await w.db.query.auditEvents.findMany({ where: and(eq(auditEvents.pollId, e.pollId), eq(auditEvents.action, "voter.passkey_reset_requested")) });
    expect(rows).toHaveLength(3);
    const shapes = rows.map((r) => JSON.stringify({ action: r.action, detail: r.detail, actor: r.actorUserId, poll: r.pollId }));
    expect(new Set(shapes).size).toBe(1);
    for (const r of rows) {
      const text = JSON.stringify(r);
      for (const n of numbers) expect(text).not.toContain(n);
      expect(text).not.toMatch(/voted|already|roll|found|cleared/i);
    }
  });

  it("clears the passkey of the matching voter, whether or not they voted, and cannot let a voter vote twice", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 2 });
    for (const i of [0, 8]) await w.db.update(eligibleVoters).set({ credentialId: `c${i}`, credentialPublicKey: "k", credentialCounter: 1 }).where(eq(eligibleVoters.id, e.voters[i]!.id));
    for (const i of [0, 8]) await reset(w, e.pollId, e.voters[i]!.number);
    for (const i of [0, 8]) expect((await w.db.query.eligibleVoters.findFirst({ where: eq(eligibleVoters.id, e.voters[i]!.id) }))?.credentialId).toBeNull();
    // Voter 0 voted; the participation survives the reset, so a second cast is still refused.
    const { voterSession, newKey } = await import("./test-helpers");
    const res = await w.request(`/api/vote/${e.pollId}/cast`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await voterSession(e.pollId, e.voters[0]!.id)}` },
      body: JSON.stringify({ idempotencyKey: newKey(), selections: [{ questionId: e.questionId, optionId: e.options[0]!.id }] }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_voted");
  });

  it("is still limited to the poll's owner, and a reset in one poll does not touch the same number in another", async () => {
    const w = await makeWorld();
    const a = await runElection(w, { voters: 12, votes: 0 });
    const b = await runElection(w, { voters: 12, votes: 0 });
    const number = a.voters[3]!.number;
    for (const p of [a, b]) await w.db.update(eligibleVoters).set({ credentialId: "x", credentialPublicKey: "k", credentialCounter: 0 }).where(eq(eligibleVoters.id, p.voters[3]!.id));
    w.actAs("organiser-2");
    expect((await reset(w, a.pollId, number)).status).toBe(404);
    w.actAs("organiser-1");
    await reset(w, a.pollId, number);
    expect((await w.db.query.eligibleVoters.findFirst({ where: eq(eligibleVoters.id, a.voters[3]!.id) }))?.credentialId).toBeNull();
    expect((await w.db.query.eligibleVoters.findFirst({ where: eq(eligibleVoters.id, b.voters[3]!.id) }))?.credentialId).toBe("x");
  });
});
