# Deploying WITNESS: what John must do

Nothing below has been done. No database exists and nothing is deployed. Run everything from the repository root unless a step says otherwise. Do not paste secrets into chat, commits or issues.

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

- Put a Cloudflare rate-limiting rule on `/api/vote/*/start` (or add Turnstile). No rate limit is built in.
- Run the Neon-branch checks below.
- Get written permission from the society and write a privacy notice (POPIA).

**Neon branch checks:** create a branch of the project in Neon, point a copy of the dev environment at it, then (a) run the cast property test against it and (b) run a load test with k6 at 35 req/s against the deployed staging Worker. Neither has been done. The `neon-http` driver has never been exercised by this codebase.

## 7. Restore the deploy workflow

The template's deploy workflow was removed because it needed a database. To restore it, add `.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
jobs:
  deploy:
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'push' &&
      github.event.workflow_run.head_repository.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { ref: "${{ github.event.workflow_run.head_sha }}" }
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build -w @noir/web
        env:
          VITE_SENTRY_DSN: ${{ vars.SENTRY_DSN_WEB }}
          VITE_POSTHOG_KEY: ${{ vars.POSTHOG_KEY }}
          VITE_POSTHOG_HOST: ${{ vars.POSTHOG_HOST }}
      - run: npm run migrate -w @noir/db
        env:
          DATABASE_URL_DIRECT: ${{ secrets.DATABASE_URL_DIRECT }}
      - run: npx wrangler deploy
        working-directory: apps/api
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Repository secrets it needs (values from you, not from this file):

```
gh secret set DATABASE_URL_DIRECT -R Noir-Cpu/noir-witness
gh secret set CLOUDFLARE_API_TOKEN -R Noir-Cpu/noir-witness      # token with "Edit Cloudflare Workers"
gh secret set CLOUDFLARE_ACCOUNT_ID -R Noir-Cpu/noir-witness
```

Worker secrets from step 4 live on Cloudflare, not in GitHub. The workflow's migration step runs on every deploy; migrations are additive files, so re-running is safe.
