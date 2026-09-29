import { and, eq, sql } from "drizzle-orm";
import { ballots, participations, polls, rowsOf, type Db } from "@noir/db";
import { canonicalSelections, selectionsValid, type BulletinPoll, type Selection } from "@noir/bulletin";
import { deriveReceipt } from "./crypto";

export type CastResult =
  | { status: "cast"; receipt: string }
  | { status: "replayed"; receipt: string }
  | { status: "already_voted" }
  | { status: "not_open" }
  | { status: "invalid_selection" }
  | { status: "receipt_collision" };

export const hourBucket = (now: Date) => new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);

export async function loadBulletinPoll(db: Db, pollId: string): Promise<BulletinPoll | null> {
  const p = await db.query.polls.findFirst({ where: eq(polls.id, pollId), columns: { id: true, title: true } });
  if (!p) return null;
  const qs = await db.query.questions.findMany({
    where: (q, { eq }) => eq(q.pollId, pollId),
    orderBy: (q, { asc }) => asc(q.position),
  });
  const opts = qs.length
    ? await db.query.options.findMany({
        where: (o, { inArray }) => inArray(o.questionId, qs.map((q) => q.id)),
        orderBy: (o, { asc }) => asc(o.position),
      })
    : [];
  return {
    id: p.id,
    title: p.title,
    questions: qs.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      options: opts.filter((o) => o.questionId === q.id).map((o) => ({ id: o.id, label: o.label })),
    })),
  };
}

// ADR 0004: one statement records the participation and, only if that insert happened, the ballot. The poll row is
// share-locked so a concurrent close (which updates that row) waits for in-flight casts and later casts see it closed.
// The receipt is derived from the idempotency key (ADR 0009), so a retry needs no lookup that joins voter to ballot.
export async function castBallot(
  db: Db,
  input: { pollId: string; voterId: string; idempotencyKey: string; selections: Selection[]; now: Date },
): Promise<CastResult> {
  const { pollId, voterId, idempotencyKey, now } = input;
  const poll = await db.query.polls.findFirst({ where: eq(polls.id, pollId), columns: { receiptKey: true } });
  if (!poll) return { status: "not_open" };
  const shape = await loadBulletinPoll(db, pollId);
  if (!shape || !selectionsValid(shape, input.selections)) return { status: "invalid_selection" };

  const receipt = await deriveReceipt(poll.receiptKey, idempotencyKey);
  const selections = canonicalSelections(input.selections);
  const bucket = hourBucket(now).toISOString();

  let inserted: { receipt: string }[];
  try {
    inserted = rowsOf(
      await db.execute(sql`
        WITH open_poll AS (
          SELECT p.id FROM polls p
          JOIN eligible_voters v ON v.poll_id = p.id AND v.id = ${voterId}::uuid
          WHERE p.id = ${pollId}::uuid AND p.status = 'open'
          FOR SHARE OF p
        ), ins AS (
          INSERT INTO participations (poll_id, voter_id, hour_bucket)
          SELECT id, ${voterId}::uuid, ${bucket}::timestamptz FROM open_poll
          ON CONFLICT (poll_id, voter_id) DO NOTHING
          RETURNING 1
        )
        INSERT INTO ballots (poll_id, receipt, selections)
        SELECT ${pollId}::uuid, ${receipt}, ${selections}::jsonb FROM ins
        RETURNING receipt`),
    );
  } catch (err) {
    // Only the ballots primary key can fail here: two voters presented the same idempotency key. The whole statement
    // rolled back, so no participation was recorded either.
    if (/ballots_pkey|duplicate key/i.test(String(err) + String((err as { cause?: unknown }).cause))) return { status: "receipt_collision" };
    throw err;
  }
  if (inserted[0]) return { status: "cast", receipt: inserted[0].receipt };

  // Nothing inserted: not open, not on the roll, or this voter already has a participation.
  const mine = await db.query.participations.findFirst({
    where: and(eq(participations.pollId, pollId), eq(participations.voterId, voterId)),
    columns: { voterId: true },
  });
  if (!mine) return { status: "not_open" };
  // A retry with the same key: the ballot with the derived receipt exists. Knowing the key is the proof of ownership.
  const existing = await db.query.ballots.findFirst({
    where: and(eq(ballots.pollId, pollId), eq(ballots.receipt, receipt)),
    columns: { receipt: true },
  });
  return existing ? { status: "replayed", receipt } : { status: "already_voted" };
}
