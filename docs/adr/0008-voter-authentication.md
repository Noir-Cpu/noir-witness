# ADR 0008: Voters sign in with invite code, student number, then their own passkey flow

Status: accepted

**Context.** Voters must prove they are on the roll, be bound to one identity, and re-authenticate right before casting. They must not need an account. Organisers use Better Auth (GitHub sign-in); the template also ships Better Auth's passkey plugin.

**Decision.**
1. The invite link carries a poll-wide code in the URL fragment (`/vote/<poll>#code=...`). The fragment is never sent to a server or written to a log. Only its SHA-256 is stored.
2. The voter enters their student number. The server looks up its per-poll salted hash on the roll (ADR 0010).
3. The voter then does a WebAuthn ceremony. First use registers a passkey and binds it to that roll entry (first claim wins, enforced by `UPDATE ... WHERE credential_id IS NULL`). Later use authenticates with it. User verification is required, so the phone's own unlock runs.
4. A successful ceremony returns a stateless HMAC-signed session token valid for 10 minutes. Cast requires it. A voter who waits longer re-confirms the passkey.
5. The WebAuthn challenge also travels as a signed, 5-minute, stateless token, so there is no challenge table.

I implemented this with `@simplewebauthn/server` directly and did not reuse the Better Auth passkey plugin. The plugin is built around the `user` and `session` tables: using it would create a `user` row (name, email) for every voter, next to organisers, and issue a Better Auth session. Voter identity would then live in the same tables as accounts, with fields voters do not have, and the plugin's flows assume the person is already signed in or has an email. The voter flow is about 100 lines in `apps/api/src/domain/voter-auth.ts` on the same underlying library the plugin uses. Organisers keep the plugin.

**Consequences.**
- A student number is not a secret. Whoever knows the invite code and a member's number first can claim that member's slot and vote as them. The passkey stops a second person taking over afterwards; it does not prove the first person is the member. The organiser can clear a claim before that voter has voted (audited). The README states this.
- A wrong code and an unknown student number return the identical error, so the roll cannot be probed without the code.
- No rate limiting is built yet (see open leads).
- The server-side ceremony is exercised by the Playwright test with Chromium's virtual authenticator, not by unit tests. Unit tests mint session tokens directly.
- Session tokens sit in page memory, not storage. A reload means one more passkey tap.
