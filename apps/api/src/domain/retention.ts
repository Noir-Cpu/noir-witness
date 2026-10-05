import { sql } from "drizzle-orm";
import { rowsOf, type Db } from "@noir/db";
import { DomainError, ownedPoll } from "./polls";

// Erasing the identity side of a poll (ADR 0016).
//
// What goes: eligible_voters (hashed student numbers and stored passkeys) and, by the foreign key's cascade,
// participations (who voted, hour bucket). What never goes: ballots, the signed bulletin, the poll itself, audit rows.
// The bulletin carries its own eligible and participation counts, so verification does not read the deleted rows.

export const DEFAULT_PURGE_DAYS = 30;
const DAY_MS = 86_400_000;

// PURGE_DAYS is a plain var. Anything that is not a whole number of at least 1 falls back to the default, so a typo can
// never make the purge erase immediately.
export function purgeDaysFrom(raw: string | undefined): number {
  if (raw === undefined || !/^\d{1,4}$/.test(raw.trim())) return DEFAULT_PURGE_DAYS;
  const n = Number(raw.trim());
  return n >= 1 ? n : DEFAULT_PURGE_DAYS;
}

export const purgeCutoff = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

// One statement, so the guard and the delete cannot be separated by a concurrent request and a failure leaves nothing
// half done (the Neon HTTP driver has no transactions). The guard is inside the SQL: only a closed poll with a signed
// bulletin, and, for the purge, one closed at or before `olderThan`, can lose rows. Idempotent: with nothing left to
// delete no audit row is written.
async function erase(db: Db, pollId: string, by: { actorUserId: string | null; trigger: "organiser" | "retention" }, olderThan: Date | null) {
  const rows = rowsOf<{ voters: number }>(
    await db.execute(sql`
      WITH guard AS (
        SELECT id FROM polls
        WHERE id = ${pollId}::uuid AND status = 'closed' AND bulletin IS NOT NULL
          AND (${olderThan ? olderThan.toISOString() : null}::timestamptz IS NULL OR closed_at <= ${olderThan ? olderThan.toISOString() : null}::timestamptz)
      ),
      gone AS (
        DELETE FROM eligible_voters v USING guard g WHERE v.poll_id = g.id RETURNING v.id
      ),
      audited AS (
        INSERT INTO audit_events (poll_id, actor_user_id, action, detail)
        SELECT g.id, ${by.actorUserId}::text, 'voter_data.erased',
               jsonb_build_object('voters', (SELECT count(*) FROM gone), 'trigger', ${by.trigger}::text)
        FROM guard g WHERE EXISTS (SELECT 1 FROM gone)
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM gone)::int AS voters`),
  );
  return rows[0]?.voters ?? 0;
}

// The organiser's button. Only for a closed poll, and only the owner.
export async function eraseVoterData(db: Db, userId: string, pollId: string, _now: Date) {
  const poll = await ownedPoll(db, pollId, userId);
  if (poll.status !== "closed" || !poll.bulletin) throw new DomainError("not_closed", "Voter data can only be erased after the poll is closed and signed");
  return { erasedVoters: await erase(db, pollId, { actorUserId: userId, trigger: "organiser" }, null) };
}

export type PurgeResult = { dryRun: boolean; days: number; cutoff: string; polls: { pollId: string; voters: number }[]; erasedVoters: number };

// The daily job. Candidates: closed, signed, closed at or before the cutoff, still holding voter rows. With
// dryRun nothing is written and the result lists what would be erased.
export async function purgeExpired(db: Db, opts: { now: Date; days: number; dryRun?: boolean }): Promise<PurgeResult> {
  const cutoff = purgeCutoff(opts.now, opts.days);
  const candidates = rowsOf<{ id: string; voters: number }>(
    await db.execute(sql`
      SELECT p.id, (SELECT count(*)::int FROM eligible_voters v WHERE v.poll_id = p.id) AS voters
      FROM polls p
      WHERE p.status = 'closed' AND p.bulletin IS NOT NULL AND p.closed_at IS NOT NULL
        AND p.closed_at <= ${cutoff.toISOString()}::timestamptz
        AND EXISTS (SELECT 1 FROM eligible_voters v WHERE v.poll_id = p.id)
      ORDER BY p.closed_at`),
  );
  const result: PurgeResult = {
    dryRun: Boolean(opts.dryRun), days: opts.days, cutoff: cutoff.toISOString(),
    polls: candidates.map((c) => ({ pollId: c.id, voters: c.voters })), erasedVoters: 0,
  };
  if (opts.dryRun) return result;
  for (const c of candidates) result.erasedVoters += await erase(db, c.id, { actorUserId: null, trigger: "retention" }, cutoff);
  return result;
}

// What the organiser's poll page says about retention. `erasedAt` comes from the audit log, so erasure needs no schema
// change; `erased` is derived from the rows themselves.
export async function retentionStatus(db: Db, pollId: string, days: number) {
  const rows = rowsOf<{ status: string; closed_at: Date | string | null; voters: number; erased_at: Date | string | null }>(
    await db.execute(sql`
      SELECT p.status, p.closed_at,
             (SELECT count(*)::int FROM eligible_voters v WHERE v.poll_id = p.id) AS voters,
             (SELECT min(a.created_at) FROM audit_events a WHERE a.poll_id = p.id AND a.action = 'voter_data.erased') AS erased_at
      FROM polls p WHERE p.id = ${pollId}::uuid`),
  );
  const row = rows[0];
  if (!row || row.status !== "closed") return { days, erasesAt: null, erasedAt: null, erased: false };
  const erased = row.voters === 0;
  const erasesAt = row.closed_at && !erased ? new Date(new Date(row.closed_at).getTime() + days * DAY_MS).toISOString() : null;
  return { days, erasesAt, erasedAt: erased && row.erased_at ? new Date(row.erased_at).toISOString() : null, erased };
}
