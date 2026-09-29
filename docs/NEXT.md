# Next

## Actions only John can do (in order)

1. Read `docs/SETUP.md` and do steps 1 to 5: create the Neon project, run the migration, create the GitHub OAuth app (callback `https://noir-witness.noir-cpu.workers.dev/api/auth/callback/github`), deploy once, set the secrets (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SIGNING_KEY` via the generation command in the doc).
2. Restore `.github/workflows/deploy.yml` from step 7 and set `DATABASE_URL_DIRECT`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` with `gh secret set`.
3. Put a Cloudflare rate-limit rule on `/api/vote/*/start`.
4. Create a Neon branch and run the concurrency test and a k6 run at 35 req/s against it; record the numbers in the README.
5. Do a dry run with about 10 friends, including a phone without a passkey-capable lock screen.
6. Ask the society for a date, written permission, and a real member CSV; write the POPIA privacy notice.

## Questions

1. Is a shared invite code plus student number acceptable for the pilot, or do you want per-member codes first? Default: shared code for the pilot, per-member codes in v1.1.
2. Workers Free (10 ms CPU) or Workers Paid ($5/month) for the pilot? Default: try Free, upgrade if close or passkey verification errors on CPU.
3. Should the poll keep one signing key for all polls or a key per poll? Default: one key, published and pinned.
4. Do you want interim signed roots while a poll is open? Default: no; final root only.
5. Should a passkey-less fallback exist (organiser-issued one-time link)? Default: not for the pilot; ask members to test their phones first.
