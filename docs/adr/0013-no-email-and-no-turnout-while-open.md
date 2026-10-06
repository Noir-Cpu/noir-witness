# ADR 0013: Invite links are shared by hand; turnout is hidden while a poll is open

Status: accepted. Amends ADR 0007.

**Context (email).** No free-tier email sender has been chosen and none is needed to run a society vote.

**Decision (email).** The service sends no email. The organiser gets the invite link once and shares it. The invite is created by one route, `POST /api/organiser/polls/:id/invite`. An email sender can later be added there, given a `recipients` list and a future email column on the roll, without changing the voter flow. Nothing in the roll or voter tables is email-shaped today.

**Context (turnout).** ADR 0007 keeps running tallies off. A running turnout count is a smaller leak, but it shows the moment each ballot lands, which is the clock ADR 0005 removes elsewhere.

**Decision (turnout).** The organiser sees how many passkeys are registered while the poll is open, and turnout only after close. Live results are not implemented; the `live_results` column exists but the setting is not exposed.

**Rule (October 2026): nothing the organiser can do may reveal who has voted.** The organiser sees counts only. In particular `POST /api/organiser/polls/:id/voters/reset` answers 200 `{"ok":true}` in every case: a number on the roll or not, a voter who has voted or not, a passkey set or not. It runs the same operations each time (look up the poll, one `UPDATE` keyed by the salted student-number hash that matches one row or none, one audit insert), so neither the response nor the work done tells the two apart. It used to refuse with 409 for a voter who had voted and 404 for an unknown number, which let an organiser test any student, during the poll, for having voted. Resetting a voter who has already voted is allowed and harmless: their participation row is untouched, so they cannot cast a second ballot. The audit row is `voter.passkey_reset_requested` with no detail: no student number, no outcome. `reset.test.ts` compares the responses byte for byte, counts the database operations, and checks the audit rows.
