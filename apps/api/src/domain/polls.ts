import { and, asc, count, eq, sql } from "drizzle-orm";
import {
  auditEvents, ballots, eligibleVoters, options, organisations, participations, polls, questions, rowsOf, type Db,
} from "@noir/db";
import { buildBulletin, type Bulletin } from "@noir/bulletin";
import { hashInviteCode, hashStudentNumber, randomB64u, randomHex } from "./crypto";
import { loadBulletinPoll } from "./cast";
import { MAX_ROLL, parseRollCsv } from "./roll";

export const SMALL_ELECTORATE = 10;

export class DomainError extends Error {
  constructor(public code: string, message: string, public status: 400 | 403 | 404 | 409 | 429 = 409) {
    super(message);
  }
}

export async function audit(db: Db, pollId: string | null, actorUserId: string, action: string, detail: Record<string, unknown> = {}) {
  await db.insert(auditEvents).values({ pollId, actorUserId, action, detail });
}

export async function ownedPoll(db: Db, pollId: string, userId: string) {
  const [row] = await db
    .select({ poll: polls })
    .from(polls)
    .innerJoin(organisations, eq(organisations.id, polls.organisationId))
    .where(and(eq(polls.id, pollId), eq(organisations.ownerUserId, userId)));
  if (!row) throw new DomainError("not_found", "Poll not found", 404);
  return row.poll;
}

const needDraft = (status: string) => {
  if (status !== "draft") throw new DomainError("not_draft", "The poll can only be changed while it is a draft");
};

export async function createPoll(db: Db, userId: string, input: { organisation: string; title: string; description: string; question: string; options: string[] }) {
  let org = await db.query.organisations.findFirst({
    where: and(eq(organisations.ownerUserId, userId), eq(organisations.name, input.organisation)),
  });
  if (!org) [org] = await db.insert(organisations).values({ name: input.organisation, ownerUserId: userId }).returning();
  const [poll] = await db
    .insert(polls)
    .values({ organisationId: org!.id, title: input.title, description: input.description, rollSalt: randomHex(16), receiptKey: randomHex(32) })
    .returning();
  const [q] = await db.insert(questions).values({ pollId: poll!.id, prompt: input.question, position: 0 }).returning();
  if (input.options.length) {
    await db.insert(options).values(input.options.map((label, position) => ({ questionId: q!.id, label, position })));
  }
  await audit(db, poll!.id, userId, "poll.created");
  return poll!;
}

export async function addOption(db: Db, userId: string, pollId: string, label: string) {
  needDraft((await ownedPoll(db, pollId, userId)).status);
  const q = await db.query.questions.findFirst({ where: eq(questions.pollId, pollId) });
  if (!q) throw new DomainError("no_question", "Poll has no question", 404);
  const [{ n }] = (await db.select({ n: count() }).from(options).where(eq(options.questionId, q.id))) as [{ n: number }];
  const [row] = await db.insert(options).values({ questionId: q.id, label, position: n }).returning();
  return row!;
}

export async function removeOption(db: Db, userId: string, pollId: string, optionId: string) {
  needDraft((await ownedPoll(db, pollId, userId)).status);
  const q = await db.query.questions.findFirst({ where: eq(questions.pollId, pollId) });
  if (q) await db.delete(options).where(and(eq(options.id, optionId), eq(options.questionId, q.id)));
}

export async function updatePoll(db: Db, userId: string, pollId: string, patch: { title?: string; description?: string }) {
  needDraft((await ownedPoll(db, pollId, userId)).status);
  if (Object.keys(patch).length) await db.update(polls).set(patch).where(eq(polls.id, pollId));
}

export async function uploadRoll(db: Db, userId: string, pollId: string, csv: string) {
  const poll = await ownedPoll(db, pollId, userId);
  needDraft(poll.status);
  const parsed = parseRollCsv(csv);
  if (parsed.invalid.length) throw new DomainError("invalid_roll", `Unreadable student numbers at ${parsed.invalid.slice(0, 5).join(", ")}`, 400);
  if (parsed.numbers.length === 0) throw new DomainError("empty_roll", "The file has no student numbers", 400);
  if (parsed.numbers.length > MAX_ROLL) throw new DomainError("roll_too_large", `At most ${MAX_ROLL} voters per poll`, 400);
  const rows = await Promise.all(parsed.numbers.map(async (n) => ({ pollId, studentHash: await hashStudentNumber(poll.rollSalt, n) })));
  await db.delete(eligibleVoters).where(eq(eligibleVoters.pollId, pollId));
  for (let i = 0; i < rows.length; i += 500) await db.insert(eligibleVoters).values(rows.slice(i, i + 500));
  await audit(db, pollId, userId, "roll.uploaded", { voters: rows.length, duplicatesIgnored: parsed.duplicates });
  return { voters: rows.length, duplicatesIgnored: parsed.duplicates };
}

// Lets a voter whose number was claimed by someone else start again. Refused once that voter has cast.
export async function resetVoterPasskey(db: Db, userId: string, pollId: string, studentNumber: string) {
  const poll = await ownedPoll(db, pollId, userId);
  const hash = await hashStudentNumber(poll.rollSalt, studentNumber);
  const v = await db.query.eligibleVoters.findFirst({ where: and(eq(eligibleVoters.pollId, pollId), eq(eligibleVoters.studentHash, hash)) });
  if (!v) throw new DomainError("not_found", "That student number is not on the roll", 404);
  const voted = await db.query.participations.findFirst({ where: and(eq(participations.pollId, pollId), eq(participations.voterId, v.id)) });
  if (voted) throw new DomainError("already_voted", "That voter has already cast a ballot");
  await db
    .update(eligibleVoters)
    .set({ credentialId: null, credentialPublicKey: null, credentialCounter: null, credentialTransports: null })
    .where(eq(eligibleVoters.id, v.id));
  await audit(db, pollId, userId, "voter.passkey_reset");
}

// Shown once. Only the hash is stored (ADR 0008).
export async function rotateInvite(db: Db, userId: string, pollId: string) {
  const poll = await ownedPoll(db, pollId, userId);
  if (poll.status === "closed") throw new DomainError("closed", "The poll is closed");
  const code = randomB64u(16);
  await db.update(polls).set({ inviteHash: await hashInviteCode(code) }).where(eq(polls.id, pollId));
  await audit(db, pollId, userId, "invite.rotated");
  return code;
}

export async function openPoll(db: Db, userId: string, pollId: string, now: Date) {
  const poll = await ownedPoll(db, pollId, userId);
  needDraft(poll.status);
  const shape = await loadBulletinPoll(db, pollId);
  if (!shape || shape.questions.some((q) => q.options.length < 2)) throw new DomainError("needs_options", "Add at least two options first", 400);
  const [{ n }] = (await db.select({ n: count() }).from(eligibleVoters).where(eq(eligibleVoters.pollId, pollId))) as [{ n: number }];
  if (n === 0) throw new DomainError("needs_roll", "Upload the voter roll first", 400);
  if (!poll.inviteHash) throw new DomainError("needs_invite", "Create the invite code first", 400);
  const rows = await db.update(polls).set({ status: "open", openedAt: now }).where(and(eq(polls.id, pollId), eq(polls.status, "draft"))).returning({ id: polls.id });
  if (!rows.length) throw new DomainError("not_draft", "The poll is no longer a draft");
  await audit(db, pollId, userId, "poll.opened", { eligible: n });
}

// Idempotent: a close that failed part-way (status closed, no bulletin) is completed by calling it again.
export async function closePoll(db: Db, userId: string, pollId: string, now: Date, signingKey: string) {
  const poll = await ownedPoll(db, pollId, userId);
  if (poll.status === "draft") throw new DomainError("not_open", "The poll has not been opened");
  if (poll.status === "open") {
    // Waits for in-flight casts that hold the share lock (see castBallot), so the ballot read below is complete.
    await db.update(polls).set({ status: "closed", closedAt: now }).where(and(eq(polls.id, pollId), eq(polls.status, "open")));
    await audit(db, pollId, userId, "poll.closed");
  }
  return finaliseBulletin(db, pollId, signingKey);
}

async function counts(db: Db, pollId: string) {
  const rows = rowsOf<{ eligible: number; claimed: number; turnout: number }>(
    await db.execute(sql`
      SELECT (SELECT count(*)::int FROM eligible_voters WHERE poll_id = ${pollId}::uuid) AS eligible,
             (SELECT count(credential_id)::int FROM eligible_voters WHERE poll_id = ${pollId}::uuid) AS claimed,
             (SELECT count(*)::int FROM participations WHERE poll_id = ${pollId}::uuid) AS turnout`),
  );
  return rows[0]!;
}

async function finaliseBulletin(db: Db, pollId: string, signingKey: string): Promise<Bulletin> {
  const fresh = await db.query.polls.findFirst({ where: eq(polls.id, pollId) });
  if (fresh?.bulletin) return JSON.parse(fresh.bulletin) as Bulletin;
  const shape = await loadBulletinPoll(db, pollId);
  const { eligible, claimed, turnout } = await counts(db, pollId);
  const rows = await db.select({ receipt: ballots.receipt, selections: ballots.selections }).from(ballots).where(eq(ballots.pollId, pollId)).orderBy(asc(ballots.receipt));
  const bulletin = await buildBulletin({
    poll: shape!,
    closedAt: fresh!.closedAt!,
    eligibleCount: eligible,
    participationCount: turnout,
    ballots: rows,
    privateKey: signingKey,
  });
  await db.update(polls).set({ bulletin: JSON.stringify(bulletin) }).where(eq(polls.id, pollId));
  return bulletin;
}

export async function publishPoll(db: Db, userId: string, pollId: string, now: Date) {
  const poll = await ownedPoll(db, pollId, userId);
  if (poll.status !== "closed" || !poll.bulletin) throw new DomainError("not_closed", "Close the poll first");
  await db.update(polls).set({ publishedAt: poll.publishedAt ?? now }).where(eq(polls.id, pollId));
  await audit(db, pollId, userId, "poll.published");
}

export async function pollDetail(db: Db, userId: string, pollId: string) {
  const poll = await ownedPoll(db, pollId, userId);
  const shape = await loadBulletinPoll(db, pollId);
  const live = await counts(db, pollId);
  // Once signed, the bulletin's own counts are the record. The rows they were counted from may have been erased (ADR 0016).
  const signed = poll.bulletin ? (JSON.parse(poll.bulletin) as Bulletin) : null;
  const eligible = signed?.eligibleCount ?? live.eligible;
  const turnout = signed?.participationCount ?? live.turnout;
  const claimed = live.claimed;
  return {
    id: poll.id,
    title: poll.title,
    description: poll.description,
    status: poll.status,
    published: poll.publishedAt !== null,
    hasInvite: poll.inviteHash !== null,
    questions: shape?.questions ?? [],
    eligible,
    passkeysRegistered: claimed,
    // Hidden while open: a live turnout counter would show when each vote lands (ADR 0005, 0007).
    turnout: poll.status === "closed" ? turnout : null,
    smallElectorate: eligible > 0 && eligible < SMALL_ELECTORATE,
    signedRoot: poll.bulletin ? (JSON.parse(poll.bulletin) as Bulletin).merkleRoot : null,
  };
}

export async function listPolls(db: Db, userId: string) {
  return db
    .select({ id: polls.id, title: polls.title, status: polls.status, published: polls.publishedAt, organisation: organisations.name })
    .from(polls)
    .innerJoin(organisations, eq(organisations.id, polls.organisationId))
    .where(eq(organisations.ownerUserId, userId))
    .orderBy(asc(polls.createdAt));
}
