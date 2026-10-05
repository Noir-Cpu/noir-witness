import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:8787", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The real API on in-process Postgres (PGlite) with a fixed organiser, serving the built web app. wrangler dev needs a database.
  webServer: {
    command: "npm run build -w @noir/web && npm run dev:local -w @noir/api",
    url: "http://localhost:8787/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      WRANGLER_SEND_METRICS: "false",
      // Fake telemetry keys baked into the web build, so e2e/privacy.spec.ts can prove that voter pages send nothing to
      // these hosts while public pages (the positive control) do. The requests are intercepted and never leave the browser.
      VITE_SENTRY_DSN: "https://abc123@o123456.ingest.sentry.io/1234",
      VITE_POSTHOG_KEY: "phc_fake_key_for_e2e",
      VITE_POSTHOG_HOST: "https://eu.i.posthog.com",
    },
  },
});
