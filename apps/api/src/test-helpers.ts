import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createPgliteDb } from "@noir/db/pglite";
import { eligibleVoters, options, organisations, polls, questions, user, type Db } from "@noir/db";
import { generateSigningKey } from "@noir/bulletin";
import { createApp, type Env } from "./app";
import type { VoterLimiters } from "./guards";
import { deriveSecret, hashStudentNumber, randomHex, signToken } from "./domain/crypto";

export const AUTH_SECRET = "test-secret-test-secret-test-secret-1234";

export async function makeWorld(opts: { organiser?: string | null; limiters?: VoterLimiters } = {}) {
  const db = await createPgliteDb();
  const key = await generateSigningKey();
  const env = { DATABASE_URL: "unused", BETTER_AUTH_SECRET: AUTH_SECRET, SIGNING_KEY: key.privateKey } as Env;
  let organiserId: string | null = opts.organiser === undefined ? "organiser-1" : opts.organiser;
  const clock = { now: new Date("2026-03-01T10:20:30Z") };
  for (const id of ["organiser-1", "organiser-2"]) {
    await db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  }
  const app = createApp({
    db,
    now: () => clock.now,
    limiters: opts.limiters,
    organiser: async () => (organiserId ? { id: organiserId, name: organiserId } : null),
  });
  const request = (path: string, init?: RequestInit) => app.request(path, init, env);
  const json = (method: string, path: string, body?: unknown) =>
    request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { db, app, env, key, clock, request, json, actAs: (id: string | null) => void (organiserId = id) };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;

export const studentNumbers = (n: number) => Array.from({ length: n }, (_, i) => `S${String(1000000 + i)}`);

// Builds an open poll straight in the database (fast path for volume tests). Returns ids only.
export async function seedOpenPoll(db: Db, voterCount: number, optionCount = 2) {
  const [org] = await db.insert(organisations).values({ name: "Test Society", ownerUserId: "organiser-1" }).returning();
  const rollSalt = randomHex(16);
  const [poll] = await db
    .insert(polls)
    .values({ organisationId: org!.id, title: "Test poll", status: "open", rollSalt, receiptKey: randomHex(32), openedAt: new Date() })
    .returning();
  const [q] = await db.insert(questions).values({ pollId: poll!.id, prompt: "Who?", position: 0 }).returning();
  const opts = await db
    .insert(options)
    .values(Array.from({ length: optionCount }, (_, i) => ({ questionId: q!.id, label: `Option ${i}`, position: i })))
    .returning();
  const nums = studentNumbers(voterCount);
  const voters = await db
    .insert(eligibleVoters)
    .values(await Promise.all(nums.map(async (n) => ({ pollId: poll!.id, studentHash: await hashStudentNumber(rollSalt, n) }))))
    .returning({ id: eligibleVoters.id });
  return { pollId: poll!.id, questionId: q!.id, optionIds: opts.map((o) => o.id), voterIds: voters.map((v) => v.id), studentNumbers: nums, salt: rollSalt };
}

export async function voterSession(pollId: string, voterId: string, exp = Date.now() + 600_000) {
  return signToken(await deriveSecret(AUTH_SECRET, "voter-token-v1"), { k: "session", v: voterId, p: pollId, exp });
}

export const newKey = () => randomUUID().replace(/-/g, "");

export async function pollRow(db: Db, id: string) {
  return (await db.select().from(polls).where(eq(polls.id, id)))[0]!;
}
