# ADR 0009: The receipt is derived from the idempotency key

Status: accepted. Amends ADR 0004.

**Context.** ADR 0004 says a retry after success returns the original receipt, but not where the server finds it. Looking up "the ballot for this voter" is exactly the link ADR 0003 forbids. Storing the idempotency key next to the ballot would create a new join key.

**Decision.** The client sends a random idempotency key with the cast. The receipt is `HMAC-SHA256(poll receipt key, "receipt:" + key)` truncated to 128 bits. The poll receipt key is a per-poll random secret stored on the poll row. The cast statement inserts that receipt.

A retry with the same key recomputes the same receipt. If the participation insert conflicts, the server looks for a ballot with that receipt: found means the retry is the original request, so it returns 200 with the same receipt; not found means the voter voted with a different key, so 409. Knowing the key is the proof of ownership. Nothing stored maps a voter to a ballot or a key.

**Consequences.**
- Retrying after a dropped response or a reload is safe and returns the same receipt.
- Two different voters presenting the same key would collide on the ballots primary key. That rolls back the whole statement (no participation is recorded either) and the API answers "try again". Keys are random 128-bit values, so this is not expected.
- Someone holding both the database and a voter's key could compute the receipt. The key travels only in the cast request, which the operator can see anyway (the operator-trust limit in ADR 0003).
- Receipts are not "random" in the sense of ADR 0005 but are indistinguishable from random without the poll key.
