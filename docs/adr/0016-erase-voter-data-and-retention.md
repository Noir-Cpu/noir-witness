# ADR 0016: Voter data is erased after close; ballots and the bulletin are kept

Status: accepted

**Context.** The identity side of a poll (`eligible_voters`: hashed student numbers and stored passkeys; `participations`: who voted, to the hour) is personal information under POPIA and has no use once a poll is closed and signed. The ballots and the signed bulletin are anonymous and must stay for the result to remain checkable.

**Decision.**
1. **What is erased:** all `eligible_voters` rows of the poll. `participations` references them with `ON DELETE CASCADE`, so it goes in the same statement. **Never touched:** `ballots`, `polls.bulletin`, questions, options, `audit_events`, and any poll that is not closed with a signed bulletin.
2. **Verification does not depend on the deleted rows.** The bulletin carries its own `eligibleCount` and `participationCount` and the verifier (the package and `scripts/verify.ts`) reads only the bulletin. Nothing in the bulletin needed changing, so existing polls are unaffected. `closePoll` returns the stored bulletin if there is one, so a repeated close cannot rebuild it from erased rows. The organiser page reads the eligible and turnout counts from the bulletin once it exists.
3. **No schema change and no migration.** "Erased" is derived: a closed poll with a bulletin and no voter rows. The date comes from the audit event. Deploys run migrations against production on every push, so avoiding one removes that risk.
4. **One atomic statement** (`apps/api/src/domain/retention.ts`): a CTE selects the poll only if `status = 'closed' AND bulletin IS NOT NULL` (and, for the purge, `closed_at <= cutoff`), deletes its voters, and writes the audit row only if something was deleted. The guard is in the SQL, so no race or caller mistake can erase an open poll. Running it again deletes nothing and writes nothing. The Neon HTTP driver has no transactions, which is why it is one statement.
5. **Audit:** `voter_data.erased` with `{ voters: <count>, trigger: "organiser" | "retention" }`. No ids, hashes or numbers. The actor is the organiser, or null for the cron.
6. **Organiser action:** `POST /api/organiser/polls/:id/erase-voter-data`, owner only, closed polls only, behind a confirmation on the poll page. The poll page states the retention period and the date the automatic erasure will happen.
7. **Automatic purge:** a Worker cron trigger, daily at 03:17 UTC (`[triggers]` in `wrangler.toml`, one of the account's five slots), calls `purgeExpired` for polls closed more than `PURGE_DAYS` days ago. `PURGE_DAYS` is a plain `[vars]` entry, default 90; a value that is not a whole number of at least 1 falls back to 90 so a typo cannot make it erase immediately. `purgeExpired` has a `dryRun` mode that lists what it would erase and writes nothing. The log line carries counts only.

**Consequences.**
- Irreversible by design: there is no undelete, and no backup is taken by the app. Neon's own history retention may keep deleted rows for its restore window; the privacy notice should say so if John keeps point-in-time restore on.
- After erasure a member cannot ask "do you hold my number": there is nothing to find, which is the point.
- Passkeys cannot be reset or re-used after erasure; closed polls take no votes anyway.
- Unproven on Neon: the CTE (`DELETE ... USING`, a cascade, an `INSERT ... SELECT` from a CTE) passes on PGlite, which is real Postgres compiled to WebAssembly, but has not run through the `neon-http` driver. The scheduled handler itself (`index.ts`) is not unit tested; the function it calls is.
