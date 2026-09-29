# ADR 0013: Invite links are shared by hand; turnout is hidden while a poll is open

Status: accepted. Amends ADR 0007.

**Context (email).** No free-tier email sender has been chosen and none is needed to run a society vote.

**Decision (email).** The service sends no email. The organiser gets the invite link once and shares it. The invite is created by one route, `POST /api/organiser/polls/:id/invite`. An email sender can later be added there, given a `recipients` list and a future email column on the roll, without changing the voter flow. Nothing in the roll or voter tables is email-shaped today.

**Context (turnout).** ADR 0007 keeps running tallies off. A running turnout count is a smaller leak, but it shows the moment each ballot lands, which is the clock ADR 0005 removes elsewhere.

**Decision (turnout).** The organiser sees how many passkeys are registered while the poll is open, and turnout only after close. Live results are not implemented; the `live_results` column exists but the setting is not exposed.
