# ADR 0004: Cast is one SQL statement

Status: accepted

**Context.** The Neon HTTP driver used on Workers has no interactive transactions, so "insert participation, then insert ballot" could leave a voter marked as voted with no ballot, or the reverse.

**Decision.** One statement:

```sql
WITH p AS (
  INSERT INTO participations (poll_id, voter_id, hour_bucket)
  VALUES ($1, $2, $3)
  ON CONFLICT (poll_id, voter_id) DO NOTHING
  RETURNING 1
)
INSERT INTO ballots (poll_id, receipt, selections)
SELECT $1, $4, $5 FROM p
RETURNING receipt;
```

A conflict inserts nothing and returns no receipt; the API answers "already voted".

**Consequences.** Atomic without a WebSocket pool. The unique constraint is the ground truth for "once". Property-based tests hammer this with concurrent duplicate attempts. Idempotency keys make client retries safe: a retry after success returns the original receipt only to the same voter session, never from the ballot table.
