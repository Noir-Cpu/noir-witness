import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IP_LIMIT, MemoryRateLimiter, STUDENT_LIMIT, studentKey, type RateLimiter } from "./guards";
import { makeWorld, AUTH_SECRET } from "./test-helpers";
import { deriveSecret } from "./domain/crypto";
import { runElection } from "./lifecycle";

const POLL_A = "11111111-1111-4111-8111-111111111111";
const POLL_B = "22222222-2222-4222-8222-222222222222";
const CODE = "CODE-CODE-CODE-CODE-1234";

const startAs = (w: Awaited<ReturnType<typeof makeWorld>>, ip: string, pollId: string, studentNumber: string, code = CODE) =>
  w.request(`/api/vote/${pollId}/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ code, studentNumber }),
  });
const finishAs = (w: Awaited<ReturnType<typeof makeWorld>>, ip: string, pollId = POLL_A) =>
  w.request(`/api/vote/${pollId}/finish`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ token: "x.y", response: {} }),
  });

describe("limits match the wrangler.toml bindings", () => {
  const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
  const block = (name: string) => {
    const m = new RegExp(`name = "${name}"\\s+namespace_id = "(\\d+)"\\s+\\[ratelimits.simple\\]\\s+limit = (\\d+)\\s+period = (\\d+)`).exec(toml);
    expect(m, `${name} block`).toBeTruthy();
    return { ns: m![1], limit: Number(m![2]), period: Number(m![3]) };
  };
  it("per-address binding", () => {
    expect(block("RATE_LIMIT_IP")).toEqual({ ns: "2001", limit: IP_LIMIT.limit, period: IP_LIMIT.periodSeconds });
  });
  it("per-student binding", () => {
    expect(block("RATE_LIMIT_STUDENT")).toEqual({ ns: "2002", limit: STUDENT_LIMIT.limit, period: STUDENT_LIMIT.periodSeconds });
  });
  it("periods are ones the Workers binding allows", () => {
    expect([10, 60]).toContain(IP_LIMIT.periodSeconds);
    expect([10, 60]).toContain(STUDENT_LIMIT.periodSeconds);
  });
});

describe("per client address", () => {
  it("lets 300 students behind one address through sign-in, then limits the 601st request", async () => {
    const w = await makeWorld();
    // 300 students, two sign-in requests each (start and finish) is exactly the per-minute limit.
    for (let i = 0; i < 300; i++) {
      expect((await startAs(w, "196.0.0.1", POLL_A, `S${2000000 + i}`)).status).toBe(403); // not on any roll: refused, not limited
      expect((await finishAs(w, "196.0.0.1")).status).toBe(403);
    }
    const over = await startAs(w, "196.0.0.1", POLL_A, "S3000000");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    const body = (await over.json()) as { error: string; message: string };
    expect(body.error).toBe("rate_limited");
    expect(body.message).toMatch(/wait a minute/i);
    expect(body.message).toMatch(/invite link still works/i);
    expect((await finishAs(w, "196.0.0.1")).status).toBe(429);
  });

  it("another address is unaffected", async () => {
    const w = await makeWorld({ limiters: { ip: new MemoryRateLimiter(3, 60_000), student: new MemoryRateLimiter(100, 60_000) } });
    for (let i = 0; i < 3; i++) expect((await startAs(w, "10.0.0.1", POLL_A, `S10000${i}`)).status).toBe(403);
    expect((await startAs(w, "10.0.0.1", POLL_A, "S1000009")).status).toBe(429);
    expect((await startAs(w, "10.0.0.2", POLL_A, "S1000009")).status).toBe(403);
  });

  it("keeps sign-in and ballot steps in separate buckets, so a busy sign-in minute does not block voting", async () => {
    const w = await makeWorld({ limiters: { ip: new MemoryRateLimiter(2, 60_000), student: new MemoryRateLimiter(100, 60_000) } });
    await startAs(w, "10.0.0.3", POLL_A, "S1000001");
    await startAs(w, "10.0.0.3", POLL_A, "S1000002");
    expect((await startAs(w, "10.0.0.3", POLL_A, "S1000003")).status).toBe(429);
    const ballot = await w.request(`/api/vote/${POLL_A}/ballot`, { headers: { "cf-connecting-ip": "10.0.0.3", authorization: "Bearer nope" } });
    expect(ballot.status).toBe(403); // session_expired, not rate_limited
    expect(((await ballot.json()) as { error: string }).error).toBe("session_expired");
  });

  it("also limits ballot and cast requests per address", async () => {
    const w = await makeWorld({ limiters: { ip: new MemoryRateLimiter(2, 60_000), student: new MemoryRateLimiter(100, 60_000) } });
    const cast = () =>
      w.request(`/api/vote/${POLL_A}/cast`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "10.0.0.4", authorization: "Bearer nope" },
        body: JSON.stringify({ idempotencyKey: "k".repeat(20), selections: [{ questionId: POLL_A, optionId: POLL_B }] }),
      });
    expect((await cast()).status).toBe(403);
    expect((await cast()).status).toBe(403);
    expect((await cast()).status).toBe(429);
  });

  it("uses the Cloudflare binding when present", async () => {
    const w = await makeWorld();
    const calls: string[] = [];
    const binding = { limit: async ({ key }: { key: string }) => (calls.push(key), { success: false }) };
    const res = await w.app.request(`/api/vote/${POLL_A}/start`, {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" }, body: JSON.stringify({ code: CODE, studentNumber: "S1" }),
    }, { ...w.env, RATE_LIMIT_IP: binding });
    expect(res.status).toBe(429);
    expect(calls).toEqual(["ip:auth:9.9.9.9"]);
  });
});

describe("per poll and student number on /start", () => {
  it("limits repeated attempts for one student in one poll; other students and other polls are independent", async () => {
    const w = await makeWorld();
    let n = 0;
    const fresh = () => `10.1.${Math.floor(n / 250)}.${n++ % 250}`; // a new address each time: only the student throttle is in play
    for (let i = 0; i < STUDENT_LIMIT.limit; i++) expect((await startAs(w, fresh(), POLL_A, "S1234567")).status).toBe(403);
    const over = await startAs(w, fresh(), POLL_A, "S1234567");
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: string }).error).toBe("rate_limited_student");
    expect((await startAs(w, fresh(), POLL_A, "S7654321")).status).toBe(403); // another student
    expect((await startAs(w, fresh(), POLL_B, "S1234567")).status).toBe(403); // same number, another poll
  });

  it("treats spacing and case as the same student", async () => {
    const w = await makeWorld({ limiters: { ip: new MemoryRateLimiter(1000, 60_000), student: new MemoryRateLimiter(2, 60_000) } });
    expect((await startAs(w, "10.2.0.1", POLL_A, "S1234567")).status).toBe(403);
    expect((await startAs(w, "10.2.0.2", POLL_A, " s 1234567 ")).status).toBe(403);
    expect((await startAs(w, "10.2.0.3", POLL_A, "s1234567")).status).toBe(429);
  });

  it("limits a number that is not on the roll exactly as one that is, so the limit reveals nothing about the roll", async () => {
    const w2 = await makeWorld({ limiters: { ip: new MemoryRateLimiter(1000, 60_000), student: new MemoryRateLimiter(3, 60_000) } });
    const e2 = await runElection(w2, { voters: 12, votes: 0 });
    const codes: Record<string, number[]> = { on: [], off: [] };
    for (let i = 0; i < 5; i++) {
      codes.on!.push((await startAs(w2, "10.3.0.1", e2.pollId, e2.voters[0]!.number, e2.invite)).status);
      codes.off!.push((await startAs(w2, "10.3.0.1", e2.pollId, "S0000001", e2.invite)).status);
    }
    expect(codes.on!.map((s) => (s === 429 ? 429 : 0))).toEqual(codes.off!.map((s) => (s === 429 ? 429 : 0)));
    expect(codes.on![3]).toBe(429);
  });

  it("never puts a plain student number, or the invite code, in a limiter key", async () => {
    const seen: string[] = [];
    const spy: RateLimiter = { allow: async (k) => (seen.push(k), true) };
    const w = await makeWorld({ limiters: { ip: spy, student: spy } });
    for (const number of ["S1234567", " s 1234567 ", "s-9876543"]) await startAs(w, "10.4.0.1", POLL_A, number);
    await finishAs(w, "10.4.0.1");
    expect(seen.length).toBe(7);
    for (const k of seen) {
      expect(k.toLowerCase()).not.toContain("1234567");
      expect(k.toLowerCase()).not.toContain("9876543");
      expect(k).not.toContain(CODE);
    }
    const studentKeys = seen.filter((k) => k.startsWith("s:"));
    expect(studentKeys.length).toBe(3);
    expect(studentKeys[0]).toBe(studentKeys[1]); // normalised before hashing
    expect(studentKeys[0]).toMatch(new RegExp(`^s:${POLL_A}:[0-9a-f]{64}$`));
  });

  it("derives the key with a secret, so it cannot be reversed by trying student numbers without it", async () => {
    const secret = await deriveSecret(AUTH_SECRET, "ratelimit-v1");
    const a = await studentKey(secret, POLL_A, "S1234567");
    const b = await studentKey(await deriveSecret("another-secret-another-secret-1234567", "ratelimit-v1"), POLL_A, "S1234567");
    expect(a).not.toBe(b);
  });
});

describe("legitimate flows are unaffected", () => {
  it("a whole poll with every voter signing in once from one address passes under the default limits", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 40, votes: 40 });
    for (const v of e.voters) expect((await startAs(w, "196.1.1.1", e.pollId, v.number, e.invite)).status).toBe(200);
  });
});
