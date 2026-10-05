# Deploying WITNESS: what John must do

Steps 1 to 5 are the one-off first set-up. The service is deployed at https://noir-witness.noir-cpu.workers.dev and a push to `main` that passes CI deploys automatically, running the migrations against the real database first (step 7). Run everything from the repository root unless a step says otherwise. Do not paste secrets into chat, commits or issues.

## 1. Create the database (Neon, free tier)

1. In the Neon console create a project named `witness`. Pick the region nearest your users (Neon has no South Africa region; a European one is closest).
2. Connection details, database `neondb`, role as given. You need two strings:
   - **Pooled** (host contains `-pooler`): this is `DATABASE_URL`, used by the Worker.
   - **Direct** (same host without `-pooler`): this is `DATABASE_URL_DIRECT`, used for migrations.
3. Apply the migration once from your machine:

   ```
   read -rs DATABASE_URL_DIRECT && export DATABASE_URL_DIRECT
   npm run migrate -w @noir/db
   ```

   `read -rs` keeps the string out of your shell history. The migration creates the Better Auth tables and the WITNESS tables (single file `packages/db/migrations/0000_init.sql`).

## 2. GitHub OAuth app (organiser sign-in)

GitHub, Settings, Developer settings, OAuth Apps, New OAuth App:

- Application name: `WITNESS`
- Homepage URL: `https://noir-witness.noir-cpu.workers.dev`
- Authorization callback URL: `https://noir-witness.noir-cpu.workers.dev/api/auth/callback/github`

Generate a client secret and keep the client ID and secret for step 4. The worker name `noir-witness` is set in `apps/api/wrangler.toml`; if you rename it, change both URLs.

## 3. First deploy of the Worker (creates it, so secrets can be attached)

```
npm ci
npm run build -w @noir/web
cd apps/api && npx wrangler deploy
```

## 4. Set the Worker secrets

Run from `apps/api`. Each command prompts for the value unless piped.

```
npx wrangler secret put DATABASE_URL            # the pooled string from step 1
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
echo -n "https://noir-witness.noir-cpu.workers.dev" | npx wrangler secret put BETTER_AUTH_URL
openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET
```

`BETTER_AUTH_URL` is also the WebAuthn origin: if it is wrong, no passkey will verify.

**Signing key** (Ed25519, base64url PKCS#8). Generate and store it in one step, so it is never printed:

```
node -e 'crypto.subtle.generateKey({name:"Ed25519"},true,["sign"]).then(k=>crypto.subtle.exportKey("pkcs8",k.privateKey)).then(b=>process.stdout.write(Buffer.from(b).toString("base64url")))' | npx wrangler secret put SIGNING_KEY
```

Consequences to know: the operator (you) can sign a false root; losing or rotating the key means new polls carry a new public key, and old bulletins still verify against the key embedded in them. Publish the public key somewhere members can pin it: `curl https://noir-witness.noir-cpu.workers.dev/api/signing-key`. Keep an offline backup of the private key if you want polls to keep one identity across redeploys.

Optional, same way: `SENTRY_DSN_API`, `GRAFANA_OTLP_ENDPOINT`, `GRAFANA_OTLP_AUTH`.

## 5. Smoke test

- `https://noir-witness.noir-cpu.workers.dev/api/health` returns `{"ok":true}`.
- `/api/health/db` returns `{"ok":true,...}`. If it returns 503, check `DATABASE_URL` and that the migration ran.
- Sign in with GitHub on `/organiser`, create a poll with a fake roll of 12 numbers, open it, vote from your phone, close, publish, run `node scripts/verify.ts` on the downloaded file with `--pubkey`.
- Close a poll with a few hundred test ballots and watch for Worker CPU-limit errors in the Cloudflare dashboard. The Workers Free plan gives 10 ms of CPU per request; the local Node figure (79 ms for 2,000 ballots) suggests Workers Paid ($5/month) may be needed for close. This is unmeasured.

## 6. Before any real vote

- **Rate limits are built in** (ADR 0014). Do not add a Cloudflare dashboard rate-limiting rule: those rules need a zone, and `workers.dev` has none. The limits are two Workers Rate Limiting bindings declared in `apps/api/wrangler.toml` and applied by `wrangler deploy`, so there is nothing to click: `RATE_LIMIT_IP` (namespace 2001, 600 requests per 60 s per client address) and `RATE_LIMIT_STUDENT` (namespace 2002, 10 per 60 s per poll and student number). Namespace ids must be unique within the Cloudflare account (noir-dispatch uses 1001). Check after the first deploy that the bindings show under the Worker's Settings, Bindings, and that a burst of requests to `/api/vote/<poll>/start` eventually returns 429.
- **Retention is built in** (ADR 0016). A daily cron (03:17 UTC) erases the voter list, passkeys and who-voted records of polls closed more than `PURGE_DAYS` days ago. `PURGE_DAYS` is a plain variable in `apps/api/wrangler.toml` (`[vars]`), default 30, not a secret; change it there and push. The cron uses one of the account's five cron slots. Check in the Cloudflare dashboard (Worker, Settings, Triggers) that the cron is listed, and in the Worker logs that a `retention purge` line appears daily.
- **Fill in the privacy notice** (`docs/PRIVACY-NOTICE.md`, shown at `/privacy`): the society's name, the information officer, a contact email, the date and the retention period. Placeholders in `[brackets]` show highlighted on the page. When done, set the repository variable `PRIVACY_STRICT` to `1` (Settings, Secrets and variables, Actions, Variables): CI then fails while any placeholder remains. Locally: `PRIVACY_STRICT=1 npm test -w @noir/web`.
- Run the Neon-branch checks below.
- Get written permission from the society.

**Neon branch checks:** create a branch of the project in Neon, point a copy of the dev environment at it, then (a) run the cast property test against it and (b) run a load test with k6 at 35 req/s against the deployed staging Worker. Neither has been done. The `neon-http` driver has never been exercised by this codebase.

## 7. Automatic deploys

`.github/workflows/deploy.yml` runs after CI succeeds on a push to `main` (or by hand from the Actions tab): it builds the web app, runs `npm run migrate -w @noir/db` against the real database with `DATABASE_URL_DIRECT`, then `wrangler deploy`. Consequences to remember:

- Every push to `main` goes live. Work on a branch and merge a pull request only when CI is green.
- A new migration file runs against production data on the next deploy. Keep migrations additive. The privacy and rate-limit work added none.
- Repository secrets it needs: `DATABASE_URL_DIRECT`, `CLOUDFLARE_API_TOKEN` ("Edit Cloudflare Workers"), `CLOUDFLARE_ACCOUNT_ID`. Optional repository variables for the web build: `SENTRY_DSN_WEB`, `POSTHOG_KEY`, `POSTHOG_HOST`. Worker secrets from step 4 live on Cloudflare, not in GitHub.
