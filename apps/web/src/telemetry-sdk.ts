import * as Sentry from "@sentry/react";
import posthog from "posthog-js";
import { isPrivatePath, scrubBreadcrumb, scrubCapture, scrubEvent } from "./scrub";
import { onNavigate } from "./router";

const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const posthogKey = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const posthogHost = import.meta.env.VITE_POSTHOG_HOST as string | undefined;

// ADR 0015. On /vote/* and /verify* nothing is initialised: no Sentry, no PostHog, no script or request to either.
// The decision is made from the path at load. If a page that did start telemetry navigates into one of those paths,
// capturing stops for the rest of the page's life. Navigating out of a private page does not start it: that page
// load has already been private, and a reload is cheap.
let running = false;
let started = false;

function stop() {
  if (!running) return;
  running = false;
  void Sentry.close(0).catch(() => undefined);
  try {
    posthog.opt_out_capturing();
  } catch {
    // PostHog was never fully started; nothing to stop.
  }
}

export function startTelemetry() {
  if (started || isPrivatePath(location.pathname)) return; // the path may have changed while this chunk was loading
  started = true;
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      tracesSampleRate: 0,
      beforeSend: (event) => (isPrivatePath(location.pathname) ? null : scrubEvent(event as never)),
      beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb as never),
    });
    running = true;
  }
  if (posthogKey) {
    posthog.init(posthogKey, {
      api_host: posthogHost,
      // Cookieless by default: nothing is stored in the browser, so no consent banner is needed.
      persistence: "memory",
      autocapture: false,
      disable_session_recording: true,
      // The page's Content-Security-Policy allows only this site and the configured ingest hosts (site.ts), and no
      // third-party script, so PostHog may not load any code from its CDN. Only named events are sent.
      disable_external_dependency_loading: true,
      disable_surveys: true,
      person_profiles: "identified_only",
      capture_pageview: "history_change",
      before_send: (capture) => (isPrivatePath(location.pathname) ? null : scrubCapture(capture)),
    });
    running = true;
  }
  if (running) onNavigate(() => isPrivatePath(location.pathname) && stop());
}
