import * as Sentry from "@sentry/cloudflare";
import { createDb } from "@noir/db";
import { app, type Env } from "./app";
import { purgeDaysFrom, purgeExpired } from "./domain/retention";
import { scrubSentryEvent } from "./scrub";

const handler = {
  fetch: app.fetch,
  // Daily (wrangler.toml [triggers]): erase the identity side of polls closed more than PURGE_DAYS ago (ADR 0016).
  // Ballots, bulletins and open polls are never touched. The log line carries counts only.
  async scheduled(event: ScheduledController, env: Env) {
    if (!env.DATABASE_URL) return;
    const days = purgeDaysFrom(env.PURGE_DAYS);
    const r = await purgeExpired(createDb(env.DATABASE_URL), { now: new Date(event.scheduledTime), days });
    console.log(JSON.stringify({ level: "info", msg: "retention purge", days, polls: r.polls.length, erasedVoters: r.erasedVoters }));
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN_API,
    // Errors only: traces go to Grafana.
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
  }),
  handler,
);
