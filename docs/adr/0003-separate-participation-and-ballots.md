# ADR 0003: Separate participation and ballot tables

Status: accepted

**Context.** We must know *who voted* (to enforce one vote) and *what was voted* (to count) without being able to join the two.

**Decision.** `participations(poll_id, voter_id)` and `ballots(receipt, selections)` are separate, with no foreign key, shared id, or timestamp between them.

**Consequences.** The database alone cannot say who cast which ballot. Row order, timestamps and physical location can re-link them, which ADR 0005 addresses. A malicious operator logging requests can still link them; blind signatures (v2) remove that trust.
