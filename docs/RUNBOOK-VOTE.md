# Runbook: freeze and run a real vote

One page. Do the freeze at least a day before opening the poll. Every push to `main` deploys and migrates the real database, so "freeze" means nothing reaches `main` until the vote is over.

## Freeze (the day before)

1. **Protect `main`.** Settings, Rules, New branch ruleset on `main`: require a pull request, require the `check`, `e2e` and `gitleaks` checks, block force pushes and deletion. (Without this, any push deploys.)
2. **Pause automatic merges and deploys.** Turn off Dependabot auto-merge (or remove the `dependabot-automerge` workflow for now) and close or leave unmerged any open Dependabot pull request until the result is published. Do not merge anything else. If the Actions tab shows a queued Deploy, cancel it. To stop all deploys, disable the Deploy workflow (Actions, Deploy, "..." , Disable workflow).
3. **Allow only the organisers** (SETUP.md 6b): set `ORGANISERS_ALLOWED_GITHUB_IDS`, then sign in to confirm you still can.
4. **Take a Neon restore point.** Neon console, your project, Branches: create a branch from `main` now and name it `before-vote-YYYY-MM-DD`. Note the time. (Restore window and retention are in the Neon plan; a branch is your own marker.)
5. **Check the service.** `curl https://noir-witness.noir-cpu.workers.dev/api/health` and `/api/health/db` must both return `"ok":true`. Confirm the cron and both rate-limit bindings show in the Cloudflare dashboard (SETUP.md 6).
6. **Rehearse on a throwaway poll** (a dozen made-up numbers, you and a friend voting from phones): close it, publish it, download the bulletin and run `node scripts/verify.ts bulletin.json --pubkey <key from /api/signing-key> --receipt <your receipt>`. It must exit 0. Then erase its voter data.
7. Fill in the privacy notice placeholders and set `PRIVACY_STRICT=1` (NEXT.md item 3).

## During

- Do not deploy, rotate secrets or change `wrangler.toml`. Watch Worker logs for `level":"error"`.
- Do not use "Reset passkey" except when a member reports their number was claimed; it does not say whether they have voted, by design.

## Closing and publishing

- Close the poll once. If the page shows an error, wait a minute and press close again: close is safe to repeat and finishes a half-done close.
- **If close fails with a CPU-limit error** (Cloudflare error 1102 or "Worker exceeded CPU time limit" in the logs; the Free plan allows 10 ms of CPU per request and building and signing the bulletin for a large poll may exceed it): do not retry in a loop. Upgrade the account to Workers Paid ($5 a month; it raises the CPU limit), then press close again. The ballots are safe: closing only stops new votes and builds the signed file. Tell voters nothing until the result is published.
- Publish, then run the verifier on the published file and keep a copy of `bulletin.json` and the signing public key.

## After

Merge the freeze changes back only when the result is published and the voter data is erased or you have decided to keep it for the retention period (30 days).
