# ADR 0012: Close waits for in-flight casts

Status: accepted. Refines ADR 0004.

**Context.** The Merkle root must cover every ballot. A cast that read `status = 'open'` just before the poll closed could insert its ballot after the root was computed, leaving a counted-nowhere ballot and a failing "ballots equal participations" check.

**Decision.** The cast statement selects the poll row `FOR SHARE` inside the same statement that inserts. Closing is an `UPDATE polls SET status = 'closed'` on that row, which needs an exclusive lock: it waits for casts already past the check and commits before any later cast can see the row. The bulletin is built after that update returns. A cast that arrives after sees `closed` and inserts nothing. Close is idempotent: if the process dies between the status change and the bulletin write, calling close again finishes the bulletin.

**Consequences.** Untestable on PGlite, which runs one statement at a time. The logic is tested (a cast racing a close is either counted or refused), the locking is reasoned about, not measured under real concurrent backends. It must be checked on a Neon branch before the pilot.
