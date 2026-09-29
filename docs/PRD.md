# CASE 001 / WITNESS: PRD

Status: MVP built; revised after John's decisions (see section 13). Owner: John Balogun. Target: pilot with the Stellenbosch Developer Society, date not fixed.

## 1. Problem

Student societies and clubs run votes on Google Forms or WhatsApp polls: no eligibility control, easy double voting, no audit trail, results taken on trust.

## 2. Users

| User | Goal | Constraint |
| --- | --- | --- |
| Organiser | Run a poll for a known member list, trust the result | Not technical; no time to set up accounts for 200 people |
| Voter | Vote once, quickly, and be able to check their vote counted | Phone in hand, poor signal, no patience |
| Auditor (any member) | Recompute the tally without trusting the organiser or the server | Wants a script and a public file, not a promise |

## 3. Goals and measurable success criteria

1. **One voter, one ballot.** 0 duplicate ballots when 1,000 concurrent cast attempts come from 100 voters (property-based test in CI).
2. **Independent tally.** A script that reads only the published data reproduces the published result 100% of the time.
3. **Performance.** p95 cast latency under 300 ms at 35 req/s (k6, staging Neon branch).
4. **Usability.** Invite link to confirmed vote in under 60 seconds on a phone; WCAG 2.2 AA (axe in CI, manual keyboard and screen-reader pass).
5. **Real use.** One real election run for the Stellenbosch Developer Society, with a public result page.

## 4. Non-goals

- Public or government elections. Security researchers broadly consider internet voting unsafe for those; the README says so plainly.
- Coercion resistance and receipt-freeness. A voter who keeps a receipt can prove how they voted; this is a known, stated limitation of the MVP.
- Hardware, biometrics stored by us, payments, multi-language, dark-mode extras.

## 5. Scope

**MVP (4 to 6 weeks):** single-choice polls, invite links, passkey sign-in, cast with receipt, results on close, public bulletin board, verifier script.
**v1.1:** ranked choice, organisation admin roles.
**v2:** RSA blind signatures ([RFC 9474](https://www.rfc-editor.org/rfc/rfc9474)) for cryptographic unlinkability; STRIDE threat-model write-up.

## 6. Key design decisions

Each is an ADR in `docs/adr/`.

1. **Passkeys, not fingerprints (ADR 0002).** WebAuthn uses the phone's own biometric unlock; we never receive biometric data. No hardware, no POPIA special-information duties.
2. **Participation and ballots are separate tables with no link (ADR 0003).** `participations(poll, voter)` records *who voted*; `ballots(receipt, selections)` records *what was voted*.
3. **One atomic statement to cast (ADR 0004).** The Neon HTTP driver has no interactive transactions, so cast is a single SQL statement (a CTE that inserts the participation and, only if that insert succeeded, the ballot). The unique constraint on (poll, voter) is the ground truth for "once".
4. **No timing side channel (ADR 0005).** Ballots have no timestamp and a random receipt id; participations store only an hour bucket; results and ballots are published only after the poll closes, sorted by receipt id, never in insertion order; physical row identifiers are never exposed.
5. **Tamper evidence (ADR 0006).** At close, the server computes a Merkle root over ballot leaves (`SHA-256(poll_id || receipt || canonical selections)`, sorted by receipt), signs it with an Ed25519 key, and publishes root, signature and the full ballot list to a public repo. A hash *chain* over insertion order was rejected: it would record who voted when.
6. **Live results are off by default (ADR 0007).** Running tallies influence late voters. Organisers may enable it per poll.

## 7. Flows

**Organiser:** sign in with GitHub, create poll and options, upload a CSV of student numbers, create the invite link and share it by hand, open poll, close poll, publish.
**Voter:** open invite link, enter student number, create or confirm a passkey (biometric prompt), see ballot, choose, confirm, receive receipt code.
**Auditor:** download the published file, run `verify.ts`, compare root, tally and their own receipt.

## 8. Data model (draft)

`organisations`, `polls`, `questions`, `options`, `eligible_voters` (salted hash of the student number, plus the passkey bound on first use), `participations` (unique poll + voter, hour bucket only), `ballots` (random receipt, selections, no timestamp, no voter reference), `audit_events` (organiser actions only, never voter actions).

## 9. Threat model summary (full STRIDE in v2)

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Ballot stuffing by organiser | Eligible list fixed at open; count of ballots must equal count of participations; both published at close | Organiser who controls the list can add fake voters before opening |
| Double voting | Unique constraint + atomic statement + idempotency key | None known |
| Server links voter to ballot | Separate tables, no timestamps, sorted output | A malicious server operator could log requests; MVP trusts the operator, v2 blind signatures remove that trust |
| Ballot tampering after close | Signed Merkle root published outside the database | Depends on the signing key staying secret |
| Vote buying via receipt | Not prevented (non-goal) | Stated in the README |
| Invite link leaks | Code hashed at rest and kept in the URL fragment; the student number must also be on the roll; the passkey binds on first use; the organiser can rotate the code and clear a claim | Student numbers are not secret: whoever has the code and a member's number first can claim that member's slot (ADR 0008, 0010) |
| Small polls deanonymise by turnout order | Publish only after close, no order information | Very small polls (under 10) reveal more; UI warns |

## 10. Risks and open questions

1. **Pilot date.** Undecided. There is no deadline pressure; the MVP was built properly rather than to a date.
2. **Small electorates.** Below a minimum size, secrecy is weak by construction. Suggested: warn under 10 voters.
3. **Interim commitments.** Publishing signed roots while a poll is open commits to a set that changes as ballots arrive, so roots are not consistent with each other. Decide whether to publish interim roots at all, or only the final one.
4. **Signing key custody.** Cloudflare secret for MVP; document the trust assumption honestly.
5. **Email delivery for invites.** Decided: none. The organiser shares links manually (ADR 0013); a sender can be added later.
6. **Legal.** POPIA: privacy notice, retention job, synthetic data in all public demos, written permission from the society before the pilot.

## 11. Capacity estimate (10k DAU shape)

A society of 2,000 voting in a 10 minute window is about 3 writes/s average, spiky. At 35 req/s peak the Worker is far below its limits; the binding constraints are Neon connections (use the pooled endpoint) and the 100k requests/day Workers Free quota, which a 2,000-voter election does not approach. Cost at 10k users: $5/month (Workers Paid).

## 12. Milestones

1. Week 1: schema, invite + passkey sign-in, ADRs 0002 to 0007 written.
2. Week 2: cast endpoint with atomic statement, concurrency property test, k6 script.
3. Week 3: close, Merkle root, signature, bulletin board, verifier script.
4. Week 4: organiser UI, accessibility pass, dry run with 10 friends.
5. Week 5 to 6: buffer, threat-model page, pilot with the society, postmortem.

## 13. Decisions since the first draft

1. **Pilot date undecided.** Build properly; no deadline.
2. **Public elections stay out of scope.** Eligibility may be checked against a student-number roll inside a university: the organiser uploads a CSV, voters enter their number and the invite code, numbers are stored only as per-poll salted hashes (ADR 0010). This shows the voter knew a number on the list; it does not prove they are that student.
3. **No email sending.** Organisers share invite links by hand (ADR 0013).
4. **Voter authentication** is invite code, student number, then a WebAuthn passkey through `@simplewebauthn/server` (ADR 0008). Better Auth stays for organisers.
5. **Load testing** uses a Node script against PGlite in-process (`scripts/load.ts`). It is not a substitute for the k6 run against a Neon staging branch in criterion 3, which has not been done.
