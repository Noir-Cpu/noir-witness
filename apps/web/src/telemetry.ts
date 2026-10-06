import { isPrivatePath } from "./scrub";

// ADR 0015. The Sentry and PostHog code lives in its own chunk (telemetry-sdk.ts) that is requested only when both
// (a) a key was configured at build time and (b) the page is not a private one. With no keys the chunk is not even
// built, so a voter's phone downloads none of it; on /vote/* and /verify* it is never requested.
export function initTelemetry() {
  if (!import.meta.env.VITE_SENTRY_DSN && !import.meta.env.VITE_POSTHOG_KEY) return;
  if (isPrivatePath(location.pathname)) return;
  void import("./telemetry-sdk").then((m) => m.startTelemetry()).catch(() => undefined); // telemetry must never break the app
}
