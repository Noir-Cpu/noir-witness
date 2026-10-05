# CASE 001 / WITNESS

**Verdict: a society can run an invite-only vote where each member votes once, gets a receipt, and anyone can recompute the count from one public file, provided they accept that the operator is trusted not to log who voted for what.** Live at https://noir-witness.noir-cpu.workers.dev (a push to `main` that passes CI deploys it). Status: MVP built and tested against in-process Postgres; the Neon and Workers behaviour is largely unmeasured (see the evidence table).

## The brief

Student societies run votes on Google Forms and WhatsApp: no eligibility control, easy double voting, no audit trail, results taken on trust. WITNESS gives an organiser a poll with a member roll, gives each voter one ballot and a receipt, and publishes a signed, sorted ballot list that a stand-alone script can check. Full requirements: [docs/PRD.md](docs/PRD.md).

**Not for public or government elections.** Internet voting is widely considered unsafe for those, and there is no real identity verification here. This is a tool for clubs, societies and meetings where the stakes are social.

## What the eligibility check proves, and what it does not

The organiser uploads a CSV of student numbers. A voter enters the invite code and their student number, then creates a passkey (first time) or confirms it (later). Numbers are stored only as per-poll salted hashes ([ADR 0010](docs/adr/0010-student-number-roll.md)).

It proves: the voter knew the invite code and a student number on the organiser's list, and holds the passkey created when that number was first used. Each number can vote once.

It does not prove: that the person is that student. A student number is not a secret. Whoever has the invite code and a member's number first can claim that member's slot; the real member is then locked out until the organiser clears the claim, which they can do only while that member has not voted. Share the invite link only where members are. It also does not stop an organiser who controls the roll from listing extra numbers before opening.

The salted hash stops precomputed tables and matching across polls. It does not stop someone who steals the database from testing every plausible student number.

## The evidence

All numbers below come from runs on this machine (Node 22.22.2, Linux) on 2026-09-29. Nothing here was measured on Neon or Cloudflare Workers.

| Claim | Result | Command |
| --- | --- | --- |
| Unit and integration tests | 97 pass in `apps/api`, 17 in `packages/bulletin`, 11 in `apps/web` (plus 1 skipped: the `PRIVACY_STRICT` check, which fails until the notice placeholders are filled in) | `npm test` |
| No duplicate ballots under concurrent attempts | 1,000 attempts from 100 voters gave exactly 100 ballots and 100 participations | `npm run test:concurrency -w @noir/api` |
| Property test (fast-check) | 200 generated runs, 9,454 cast attempts from 1,777 voters (in that run) gave 1,777 ballots and 1,777 participations; never more than one per voter; stored tally equals the winning attempts. Attempts per run vary with the random seed. | same |
| Same, through the HTTP endpoint | 200 attempts from 20 voters gave 20 ballots | same |
| A mutated cast statement is caught | Making the ballot insert ignore the participation result fails 4 tests | manual edit, reverted |
| Verifier catches tampering | Changing one ballot, removing, adding or reordering ballots, or re-signing with another key each make `scripts/verify.ts` exit 1 | `npm test -w @noir/api` (`verify.test.ts`) |
| Secrecy checks | 13 tests: table columns, no shared column but `poll_id`, foreign keys, hour buckets, sorted output, no voter ids in the published file | `secrecy.test.ts` |
| End to end | 10 Playwright tests pass in Chromium, including passkey creation and re-authentication with a virtual authenticator, a ballot chosen and submitted from the keyboard (arrow keys and Enter), and axe (WCAG 2.2 AA tags) on the main voter, organiser, results, receipt-check and privacy screens, the organiser erasing voter data and the result still verifying afterwards, a check that voter pages send nothing to Sentry or PostHog (fake keys, intercepted requests), and the rate-limit message. A manual screen-reader pass was not done | `npm run e2e` |
| Rate limits | 600 per minute per address and 10 per minute per poll and student, with 300 students behind one address passing. In-memory limiter only: the Cloudflare binding has not been exercised | `ratelimit.test.ts` |
| Erase and purge | Erasing voter data keeps ballots and bulletin byte-identical, the package and `scripts/verify.ts` still pass, open and recent polls are untouched, a second run is a no-op. PGlite only | `retention.test.ts` |
| Cast latency, local | 700 casts at a paced 35/s: p50 4.2 ms, p95 6.5 ms, p99 7.1 ms. At an offered 1,000/s the process sustained about 577/s and latency climbed to p95 1,628 ms (queueing). **In-process Hono + PGlite, no network, one connection: not a production figure.** | `npx tsx scripts/load.ts` and `--rate 1000 --seconds 2` |
| Close, local | Building and signing a bulletin for 2,000 ballots took 79 ms in Node. Not measured on Workers | ad hoc script |
| Code coverage | not measured | |
| p95 under 300 ms at 35 req/s on staging Neon (PRD criterion 3) | **not measured**; needs a Neon branch and k6 | |
| Invite link to confirmed vote under 60 seconds | not timed with real users | |
| Manual screen-reader pass | not done | |

Limits of the concurrency evidence: PGlite runs one statement at a time on one connection. The tests exercise the statement's logic and the unique constraint, not two Postgres backends racing on rows. The close-versus-cast locking ([ADR 0012](docs/adr/0012-close-waits-for-casts.md)) is reasoned, not measured, and must be checked on a Neon branch.

## The method

```
apps/api        Hono + Zod on Workers. Organiser API, voter API, public bulletin.
apps/web        React + Vite. Organiser screens, voter flow, results, receipt check.
packages/db     Drizzle schema, migrations, Neon client, PGlite client (tests and local dev)
packages/bulletin  Canonical ballots, Merkle tree, Ed25519 signing, verification (WebCrypto only)
scripts/verify.ts  Stand-alone verifier. Imports nothing from the repo.
scripts/load.ts    Local cast-path load script
```

**Data model.** `organisations`, `polls`, `questions`, `options`, `eligible_voters` (salted student-number hash and the passkey bound on first use), `participations` (poll, voter, hour bucket), `ballots` (poll, receipt, selections), `audit_events` (organiser actions only). Better Auth tables serve organisers. `participations` and `ballots` share only `poll_id` and have no foreign key between them.

**Cast** is one SQL statement: a CTE inserts the participation with `ON CONFLICT DO NOTHING` and inserts the ballot only if that insert happened ([ADR 0004](docs/adr/0004-atomic-cast-statement.md)). The receipt is derived from the client's idempotency key, so retries are safe without a stored link ([ADR 0009](docs/adr/0009-receipt-derived-from-idempotency-key.md)).

**Close** locks out new casts, sorts ballots by receipt, builds an RFC 6962-style Merkle tree, signs `witness/v1 | poll | root | count` with Ed25519, and stores the bulletin. **Publish** makes it public at `/api/polls/:id/bulletin`.

**Check it yourself.** Save the published file, then:

```
node scripts/verify.ts bulletin.json --pubkey <public key from the organiser> --receipt <your receipt>
```

Node 22.18 or later runs the TypeScript file directly. Without `--pubkey` the script says the signer is unauthenticated.

**Decisions** (each has an ADR in [docs/adr](docs/adr)): in-Worker rate limits (0014), no telemetry on voter pages (0015), erasing voter data and retention (0016), passkeys not fingerprints (0002), separate tables (0003), atomic cast (0004), no timing side channel (0005), Merkle commitment (0006), live results off (0007), voter authentication and why not Better Auth's passkey plugin (0008), receipts from idempotency keys (0009), the student-number roll (0010), independent verifier and key pinning (0011), close waits for casts (0012), manual invites and hidden turnout (0013).

**Privacy.** Voter pages load no analytics or error reporting; the invite code lives in the URL fragment and never reaches a server or a log ([ADR 0015](docs/adr/0015-no-telemetry-on-voter-pages.md)). After a poll closes, the organiser can erase the voter list, passkeys and who-voted records, and a daily job does it after `PURGE_DAYS` (default 30); ballots and the signed bulletin stay and still verify ([ADR 0016](docs/adr/0016-erase-voter-data-and-retention.md)). The notice voters see is [docs/PRIVACY-NOTICE.md](docs/PRIVACY-NOTICE.md), served at `/privacy`; it is a draft with highlighted placeholders to fill in.

**Run it locally** (no database needed):

```
npm install
npm test
npm run e2e                      # builds the web app, starts the dev server on PGlite, runs Playwright
npm run build -w @noir/web && npm run dev:local -w @noir/api   # http://localhost:8787, fixed organiser
```

`wrangler dev` needs a real `DATABASE_URL`; see [docs/SETUP.md](docs/SETUP.md).

## Secrecy: what holds and what does not

Holds (tested): the database cannot join a participation to a ballot; ballots have no timestamp or sequence; participation times are bucketed to the hour; the published list is sorted by receipt, not cast order; nothing is public before the organiser publishes; turnout is hidden while a poll is open.

Does not hold:
- The operator can see a cast request (voter session and selections together), so a malicious or compromised server can link them. Blind signatures (v2) would remove that trust.
- Physical row order in Postgres was not examined; the API never exposes it.
- A receipt is proof of how you voted to anyone you show it to. Vote buying is not prevented.
- With under 10 eligible voters, results say a lot about individuals. The organiser screen warns.
- The operator holds the signing key and could sign a false root. Pin the public key you got from the organiser.

## The verdict, cost at 10k users

Free tier covers the MVP as designed. At 10k daily users the PRD estimate stands: about $5/month for Workers Paid. That estimate is not measured. One concrete risk: signature and attestation checks, and closing a large poll, may exceed the Workers Free 10 ms CPU limit; the local 79 ms close figure is Node, not Workers.

## Open leads

- Rate limits exist ([ADR 0014](docs/adr/0014-in-worker-rate-limits.md)) but the Cloudflare binding has not been seen working on the live Worker. A code holder can lock one student out by spending their per-minute attempts. Turnstile is not used.
- Never run against Neon. The `neon-http` driver path (`db.execute` result shape, relational queries) is untested; PGlite is the only database used so far.
- Close-versus-cast locking needs a run on a Neon branch.
- Per-member invite codes instead of one shared code and a guessable number.
- Interim signed roots (ADR 0006 open question), blind signatures, ranked choice.
- POPIA: the privacy notice is drafted and served at `/privacy` but has unfilled placeholders (society, information officer, contact, date, retention period); written permission from the society is not in hand; nobody with POPIA experience has read it. Neon's point-in-time restore may keep erased rows for its restore window.
- The daily purge handler (`scheduled` in `apps/api/src/index.ts`) and the erase SQL have not run on Neon or on a deployed Worker.
- The receipt check in the browser needs Ed25519 in WebCrypto; older browsers will report a failed signature check.
- The passkey ceremony is covered by Playwright only, not by unit tests.
