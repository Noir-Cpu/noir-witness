import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { polls } from "@noir/db";
import { makeWorld, newKey, voterSession, type World } from "./test-helpers";
import { runElection } from "./lifecycle";

let w: World;
let e: Awaited<ReturnType<typeof runElection>>;
beforeAll(async () => {
  w = await makeWorld();
  e = await runElection(w, { voters: 12, votes: 0 });
});

const start = (code: string, studentNumber: string, pollId = e.pollId) => w.json("POST", `/api/vote/${pollId}/start`, { code, studentNumber });

describe("voter sign-in, step 1: invite code and student number", () => {
  it("starts a passkey registration for a student on the roll", async () => {
    const res = await start(e.invite, e.voters[0]!.number);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; token: string; options: { challenge: string; rp: { id: string }; user: { name: string } } };
    expect(body.mode).toBe("register");
    expect(body.options.rp.id).toBe("localhost");
    expect(body.options.challenge.length).toBeGreaterThan(20);
    // The passkey label shows the poll, never the student number.
    expect(body.options.user.name).not.toContain(e.voters[0]!.number);
  });

  it("accepts the student number in any case or spacing", async () => {
    expect((await start(e.invite, ` ${e.voters[1]!.number.toLowerCase()} `)).status).toBe(200);
  });

  it("gives the same answer for a wrong code and for a number that is not on the roll", async () => {
    const wrongCode = await start("x".repeat(22), e.voters[0]!.number);
    const unknown = await start(e.invite, "S0000001");
    expect(wrongCode.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(await wrongCode.json()).toEqual(await unknown.json());
  });

  it("gives nothing away about the roll without the code", async () => {
    const a = await start("y".repeat(22), e.voters[0]!.number);
    const b = await start("y".repeat(22), "S0000001");
    expect(await a.json()).toEqual(await b.json());
  });

  it("refuses when the poll is closed", async () => {
    await w.db.update(polls).set({ status: "closed" }).where(eq(polls.id, e.pollId));
    try {
      expect((await start(e.invite, e.voters[0]!.number)).status).toBe(409);
    } finally {
      await w.db.update(polls).set({ status: "open" }).where(eq(polls.id, e.pollId));
    }
  });

  it("returns 404 for a malformed poll id", async () => {
    expect((await start(e.invite, "S1", "not-a-uuid")).status).toBe(404);
  });

  it("an old invite code stops working after it is rotated", async () => {
    const before = await start(e.invite, e.voters[0]!.number);
    expect(before.status).toBe(200);
    const rotated = (await (await w.json("POST", `/api/organiser/polls/${e.pollId}/invite`)).json()) as { code: string };
    expect((await start(e.invite, e.voters[0]!.number)).status).toBe(403);
    expect((await start(rotated.code, e.voters[0]!.number)).status).toBe(200);
    e.invite = rotated.code;
  });
});

describe("voter sign-in, step 2: the passkey", () => {
  it("rejects a passkey response with a forged or missing challenge token", async () => {
    const res = await w.json("POST", `/api/vote/${e.pollId}/finish`, { token: "nope.nope", response: { id: "x" } });
    expect(res.status).toBe(403);
  });

  it("rejects a garbage passkey response even with a valid challenge", async () => {
    const s = (await (await start(e.invite, e.voters[2]!.number)).json()) as { token: string };
    const res = await w.json("POST", `/api/vote/${e.pollId}/finish`, { token: s.token, response: { id: "x", rawId: "x", type: "public-key", response: {} } });
    expect(res.status).toBe(403);
  });
});

describe("casting needs a fresh voter session", () => {
  const body = () => ({ idempotencyKey: newKey(), selections: [{ questionId: e.questionId, optionId: e.options[0]!.id }] });
  const cast = (auth?: string) =>
    w.request(`/api/vote/${e.pollId}/cast`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body()),
    });

  it("refuses without a session", async () => expect((await cast()).status).toBe(403));
  it("refuses an expired session", async () => expect((await cast(await voterSession(e.pollId, e.voters[3]!.id, w.clock.now.getTime() - 1))).status).toBe(403));
  it("refuses a session for another poll", async () => {
    const other = await runElection(w, { voters: 12, votes: 0 });
    expect((await cast(await voterSession(other.pollId, other.voters[0]!.id))).status).toBe(403);
  });
  it("refuses a tampered session token", async () => {
    const t = await voterSession(e.pollId, e.voters[3]!.id);
    expect((await cast(t.slice(0, -2) + "00")).status).toBe(403);
  });
  it("accepts a valid session once", async () => {
    const t = await voterSession(e.pollId, e.voters[4]!.id);
    expect((await cast(t)).status).toBe(201);
    expect((await cast(t)).status).toBe(409);
  });
  it("shows the ballot and whether this voter has voted", async () => {
    const t = await voterSession(e.pollId, e.voters[4]!.id);
    const res = await w.request(`/api/vote/${e.pollId}/ballot`, { headers: { authorization: `Bearer ${t}` } });
    const b = (await res.json()) as { hasVoted: boolean; questions: unknown[] };
    expect(b.hasVoted).toBe(true);
    expect(b.questions).toHaveLength(1);
  });
});
