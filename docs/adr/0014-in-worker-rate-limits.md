# ADR 0014: Voter endpoints are rate limited inside the Worker, with two Cloudflare bindings

Status: accepted. Replaces the "put a Cloudflare rate-limiting rule in front" advice in earlier setup notes.

**Context.** `POST /api/vote/:poll/start` and `/finish` take guessable input (a student number) and nothing limited how fast it could be tried. A dashboard rate-limiting rule is not available: those rules need a zone, and `workers.dev` has none. The sibling project noir-dispatch already limits requests in the Worker with the Workers Rate Limiting binding (`[[ratelimits]]`, `namespace_id` 1001). The binding accepts a `period` of 10 or 60 seconds only, and it is deliberately permissive and per-location, so it is a brake, not an exact counter.

The limit has to let a campus vote. Many students share one public address behind a university NAT, so a per-address limit that is too tight would lock out a whole lecture hall.

**Decision.** Two bindings, wired through `apps/api/src/guards.ts` (a port of noir-dispatch's `RateLimiter`, `MemoryRateLimiter` and `cloudflareLimiter`). When a binding is absent (tests, `dev:local`) an in-memory limiter with the same numbers is used.

| Binding | namespace_id | Key | Limit | Where |
| --- | --- | --- | --- | --- |
| `RATE_LIMIT_IP` | 2001 | `ip:auth:<cf-connecting-ip>` for `/start` and `/finish`; `ip:vote:<cf-connecting-ip>` for `/ballot` and `/cast` | 600 per 60 s | every voter route, before the body is read |
| `RATE_LIMIT_STUDENT` | 2002 | `s:<poll id>:<HMAC-SHA-256 of the normalised student number>` | 10 per 60 s | `/start` only |

**Arithmetic for the per-address limit.** Assume 300 students behind one address voting within 10 minutes.
- Clean path per student: `/start` once and `/finish` once, so 2 requests in the sign-in bucket. Allow one retry of each for a typo or a cancelled passkey prompt: 4 requests. Someone who returns after the 10-minute session expires adds 2 more.
- 300 students x 4 = 1,200 sign-in requests in 10 minutes, an average of 120 a minute.
- A 60-second period is the longer of the two allowed, so it smooths the most. 600 a minute is 5 times that average, and exactly covers the worst burst in which all 300 sign in within the same minute with no retries (300 x 2 = 600). Over 10 minutes the bucket has room for 6,000 requests against 1,200 needed.
- Ballot and cast requests (`/ballot` once, `/cast` once, one retry: 3 per student = 900 in 10 minutes) are in a separate bucket, so a busy sign-in minute cannot block people already signed in.
- Cost to an attacker from one address: at most 600 sign-in guesses a minute, each also counted against the per-student limit. The invite code is 128 bits and cannot be guessed at any rate; the limit exists to bound enumeration of student numbers and noisy abuse.

**Per-student throttle.** It limits attempts for one student number in one poll to 10 a minute. The key is an HMAC-SHA-256 of the normalised number (the same normalisation as the roll, so `s 123` and `S123` are one student), keyed by a secret derived from `BETTER_AUTH_SECRET`. The plain number never appears in the key, and unlike a bare SHA-256 the key cannot be reversed by trying every plausible student number. The throttle applies whether or not the number is on the roll, so hitting it reveals nothing about the roll.

**Amendment (security review, October 2026): the student throttle counts only requests that carry the right invite code.** As first built it counted every `/start` request before the code was checked. A poll id and a student number are not secrets, so anyone could send ten requests a minute for a chosen student and keep that student from signing in for as long as they liked, with no invite code at all. `app.ts` now checks the code first (`inviteCodeMatches`); a wrong code is answered `no_match` and counts only against the per-address limit, which is what bounds guessing the 128-bit code. A caller who holds the code can still spend a student's attempts (below). `security.test.ts` and `ratelimit.test.ts` prove a stranger cannot.

**What it does not do.** A person who holds the invite code could spend a victim's 10 attempts a minute and keep that student from signing in for as long as they keep it up. They could instead register a passkey for the victim's number (ADR 0008), which is worse, so this adds little. The organiser can reset a claim. Cast and ballot requests need a 256-bit HMAC session token; nothing there can be guessed, so their limit only protects the database from floods.

**Responses.** HTTP 429 with `Retry-After: 60` and a plain-language message the voter page shows in its alert: "Many people are using this network right now, or there were too many attempts in a row. Wait a minute and try again. Your invite link still works." (per-address) or "Too many attempts for this student number. Wait a minute and try again." (per-student). Codes `rate_limited` and `rate_limited_student`.

**Consequences.**
- `wrangler.toml` and `guards.ts` must agree. `ratelimit.test.ts` reads `wrangler.toml` and fails if they differ.
- Not proven on Cloudflare: the binding's behaviour at these limits, and whether it is available to this account's plan, are unverified. noir-dispatch already deploys the same kind of binding on the account.
- Locally and in tests everything shares one address (`local`) because `cf-connecting-ip` is absent; `scripts/load.ts` sets a distinct address per voter.
- Cloudflare's limiter keeps its counters for about a minute. Those keys are addresses and keyed hashes, not student numbers.
