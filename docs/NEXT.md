# Next

## Actions only John can do (in order)

1. Read `docs/SETUP.md` and do steps 1 to 5: create the Neon project, run the migration, create the GitHub OAuth app (callback `https://noir-witness.noir-cpu.workers.dev/api/auth/callback/github`), deploy once, set the secrets (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SIGNING_KEY` via the generation command in the doc).
2. Done: the deploy workflow is live (see SETUP step 7). Rate limiting is built in as Worker bindings (SETUP step 6, ADR 0014); no dashboard rule is needed or possible on workers.dev.
3. Fill in the privacy notice (`docs/PRIVACY-NOTICE.md`, served at `/privacy`) and then set the repository variable `PRIVACY_STRICT=1` so CI refuses any leftover placeholder. You need to decide: the responsible party (the society or you), the society's name, the information officer's name and contact, a privacy contact email, the date, and the retention period (the notice says 90 days; `PURGE_DAYS` in `apps/api/wrangler.toml` must match).
4. Create a Neon branch and run the concurrency test and a k6 run at 35 req/s against it; record the numbers in the README.
5. Do a dry run with about 10 friends, including a phone without a passkey-capable lock screen.
6. Ask the society for a date, written permission, and a real member CSV; have someone with POPIA experience read the privacy notice once.
7. After the first deploy with these changes: confirm the two rate-limit bindings and the daily cron appear in the Cloudflare dashboard, and close a throwaway poll to try "Erase voter data" once on the real database.

## Questions

1. Is a shared invite code plus student number acceptable for the pilot, or do you want per-member codes first? Default: shared code for the pilot, per-member codes in v1.1.
2. Workers Free (10 ms CPU) or Workers Paid ($5/month) for the pilot? Default: try Free, upgrade if close or passkey verification errors on CPU.
3. Should the poll keep one signing key for all polls or a key per poll? Default: one key, published and pinned.
4. Do you want interim signed roots while a poll is open? Default: no; final root only.
5. Should a passkey-less fallback exist (organiser-issued one-time link)? Default: not for the pilot; ask members to test their phones first.
