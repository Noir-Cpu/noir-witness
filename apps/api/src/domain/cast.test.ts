import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ballots, participations, polls } from "@noir/db";
import { castBallot, type CastResult } from "./cast";
import { makeWorld, newKey, seedOpenPoll, voterSession, type World } from "../test-helpers";

let w: World;
beforeAll(async () => void (w = await makeWorld()));

const cast = (s: Awaited<ReturnType<typeof seedOpenPoll>>, voter: number, key: string, option = 0) =>
  castBallot(w.db, { pollId: s.pollId, voterId: s.voterIds[voter]!, idempotencyKey: key, selections: [[s.questionId, s.optionIds[option]!]], now: w.clock.now });

const counts = async (pollId: string) => ({
  ballots: (await w.db.select().from(ballots).where(eq(ballots.pollId, pollId))).length,
  participations: (await w.db.select().from(participations).where(eq(participations.pollId, pollId))).length,
});

describe("cast", () => {
  it("records one ballot and one participation", async () => {
    const s = await seedOpenPoll(w.db, 3);
    const r = await cast(s, 0, newKey());
    expect(r.status).toBe("cast");
    expect(await counts(s.pollId)).toEqual({ ballots: 1, participations: 1 });
  });

  it("returns the same receipt to a retry with the same key, and refuses a different key", async () => {
    const s = await seedOpenPoll(w.db, 3);
    const key = newKey();
    const first = await cast(s, 0, key);
    const retry = await cast(s, 0, key);
    const other = await cast(s, 0, newKey(), 1);
    expect(first.status).toBe("cast");
    expect(retry).toEqual({ status: "replayed", receipt: (first as { receipt: string }).receipt });
    expect(other).toEqual({ status: "already_voted" });
    expect(await counts(s.pollId)).toEqual({ ballots: 1, participations: 1 });
  });

  it("does not hand another voter's receipt to someone who guesses the key of a different voter", async () => {
    const s = await seedOpenPoll(w.db, 3);
    const key = newKey();
    await cast(s, 0, key);
    // Voter 1 has not voted, so presenting voter 0's key casts a new ballot with a different-voter key: a collision.
    expect(await cast(s, 1, key)).toEqual({ status: "receipt_collision" });
    expect(await counts(s.pollId)).toEqual({ ballots: 1, participations: 1 });
  });

  it("refuses when the poll is not open", async () => {
    const s = await seedOpenPoll(w.db, 2);
    await w.db.update(polls).set({ status: "closed" }).where(eq(polls.id, s.pollId));
    expect(await cast(s, 0, newKey())).toEqual({ status: "not_open" });
    expect(await counts(s.pollId)).toEqual({ ballots: 0, participations: 0 });
  });

  it("refuses a voter who is not on this poll's roll", async () => {
    const a = await seedOpenPoll(w.db, 2);
    const b = await seedOpenPoll(w.db, 2);
    const r = await castBallot(w.db, {
      pollId: a.pollId, voterId: b.voterIds[0]!, idempotencyKey: newKey(), selections: [[a.questionId, a.optionIds[0]!]], now: w.clock.now,
    });
    expect(r).toEqual({ status: "not_open" });
    expect(await counts(a.pollId)).toEqual({ ballots: 0, participations: 0 });
  });

  it("rejects selections that do not match the poll", async () => {
    const s = await seedOpenPoll(w.db, 2);
    const bad = await castBallot(w.db, {
      pollId: s.pollId, voterId: s.voterIds[0]!, idempotencyKey: newKey(), selections: [[s.questionId, crypto.randomUUID()]], now: w.clock.now,
    });
    expect(bad).toEqual({ status: "invalid_selection" });
    expect(await counts(s.pollId)).toEqual({ ballots: 0, participations: 0 });
  });
});

// ---- Concurrency ---------------------------------------------------------------------------------------------
// PGlite runs statements one at a time on a single connection, so these tests exercise the statement's logic and the
// unique constraint, not row-level contention between separate Postgres backends. That is stated in the README.

const stats = { runs: 0, attempts: 0, voters: 0, ballots: 0 };
afterAll(() => {
  console.log(`[cast concurrency] ${JSON.stringify(stats)}`);
});

describe("cast under concurrency", () => {
  it("1,000 concurrent attempts from 100 voters produce exactly 100 ballots", async () => {
    const s = await seedOpenPoll(w.db, 100);
    const keys = s.voterIds.map(() => newKey());
    // 10 attempts per voter: half retries with the voter's own key, half double-submits with fresh keys.
    const jobs = Array.from({ length: 1000 }, (_, i) => {
      const v = i % 100;
      return { v, key: i < 100 ? keys[v]! : Math.floor(i / 100) % 2 ? keys[v]! : newKey() };
    });
    const results = await Promise.all(jobs.map((j) => cast(s, j.v, j.key, j.v % 2)));
    const c = await counts(s.pollId);
    expect(c).toEqual({ ballots: 100, participations: 100 });
    expect(results.filter((r) => r.status === "cast")).toHaveLength(100);
    stats.attempts += 1000;
    stats.voters += 100;
    stats.ballots += 100;
    stats.runs += 1;
  }, 60_000);

  it("property: never more than one ballot per voter, ballots = participations, tally = winning attempts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 25 }),
        fc.array(fc.record({ voter: fc.nat(), keyIx: fc.integer({ min: 0, max: 2 }), option: fc.integer({ min: 0, max: 2 }), stranger: fc.boolean() }), { minLength: 1, maxLength: 120 }),
        async (voterCount, attempts) => {
          const s = await seedOpenPoll(w.db, voterCount, 3);
          const strangerPoll = await seedOpenPoll(w.db, 1);
          const jobs = attempts.map((a) => ({
            ...a,
            v: a.voter % voterCount,
            key: `v${a.voter % voterCount}-key-${a.keyIx}-0123456789`,
          }));
          const results: { job: (typeof jobs)[number]; r: CastResult }[] = await Promise.all(
            jobs.map(async (job) => ({
              job,
              r: job.stranger
                ? await castBallot(w.db, { pollId: s.pollId, voterId: strangerPoll.voterIds[0]!, idempotencyKey: job.key, selections: [[s.questionId, s.optionIds[0]!]], now: w.clock.now })
                : await cast(s, job.v, job.key, job.option),
            })),
          );

          const voted = new Set(jobs.filter((j) => !j.stranger).map((j) => j.v));
          const c = await counts(s.pollId);
          expect(c.ballots).toBe(voted.size);
          expect(c.participations).toBe(voted.size);
          expect(c.ballots).toBe(c.participations);
          for (const x of results.filter((x) => x.job.stranger)) expect(x.r.status).toBe("not_open");

          const tally = [0, 0, 0];
          for (const v of voted) {
            const mine = results.filter((x) => !x.job.stranger && x.job.v === v);
            const winners = mine.filter((x) => x.r.status === "cast");
            expect(winners).toHaveLength(1);
            const win = winners[0]!;
            tally[win.job.option]!++;
            for (const x of mine) {
              if (x === win) continue;
              expect(x.r.status).toBe(x.job.key === win.job.key ? "replayed" : "already_voted");
              if (x.r.status === "replayed") expect(x.r.receipt).toBe((win.r as { receipt: string }).receipt);
            }
          }
          const stored = await w.db.select().from(ballots).where(eq(ballots.pollId, s.pollId));
          const stored2 = [0, 0, 0];
          for (const b of stored) stored2[s.optionIds.indexOf(b.selections[0]![1])]!++;
          expect(stored2).toEqual(tally);

          stats.runs++;
          stats.attempts += jobs.length;
          stats.voters += voted.size;
          stats.ballots += c.ballots;
        },
      ),
      { numRuns: 100 },
    );
  }, 120_000);

  it("holds through the HTTP endpoint with real session tokens", async () => {
    const s = await seedOpenPoll(w.db, 20);
    const tokens = await Promise.all(s.voterIds.map((v) => voterSession(s.pollId, v)));
    const keys = s.voterIds.map(() => newKey());
    const reqs = Array.from({ length: 200 }, (_, i) => {
      const v = i % 20;
      return w.request(`/api/vote/${s.pollId}/cast`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokens[v]}` },
        body: JSON.stringify({ idempotencyKey: i < 20 || i % 2 ? keys[v] : newKey(), selections: [{ questionId: s.questionId, optionId: s.optionIds[v % 2] }] }),
      });
    });
    const res = await Promise.all(reqs);
    const created = res.filter((r) => r.status === 201);
    expect(created).toHaveLength(20);
    expect(res.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    expect(await counts(s.pollId)).toEqual({ ballots: 20, participations: 20 });
    stats.attempts += 200;
    stats.voters += 20;
    stats.ballots += 20;
    stats.runs += 1;
  }, 60_000);

  it("a cast that races a close is either counted or refused, never lost", async () => {
    const s = await seedOpenPoll(w.db, 30);
    const closing = w.db.update(polls).set({ status: "closed" }).where(and(eq(polls.id, s.pollId), eq(polls.status, "open")));
    const [results] = await Promise.all([Promise.all(s.voterIds.map((_, i) => cast(s, i, newKey()))), closing]);
    const c = await counts(s.pollId);
    expect(c.ballots).toBe(results.filter((r) => r.status === "cast").length);
    expect(c.ballots).toBe(c.participations);
  });
});
