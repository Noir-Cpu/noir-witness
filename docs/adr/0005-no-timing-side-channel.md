# ADR 0005: Remove ordering and timing signals

Status: accepted

**Context.** Even with separate tables, insertion order, timestamps and physical row order can let an observer match the nth participation to the nth ballot.

**Decision.**
- Ballots carry no timestamp; the receipt is a random 128-bit value.
- Participations store only an hour bucket, not a precise time.
- Nothing is published until the poll closes. Published ballots are sorted by receipt, never by insertion.
- Physical identifiers (`ctid`, sequence ids) are never exposed or used as ballot ids.

**Consequences.** Live tallies are impossible unless the organiser turns them on and accepts the risk (ADR 0007). Very small polls stay weak by construction; the UI warns under 10 voters.
