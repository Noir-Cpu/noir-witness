# ADR 0015: No analytics or error reporting on voter pages; scrubbed everywhere else

Status: accepted

**Context.** The invite link is `/vote/<poll>#code=<invite code>` and a receipt link is `/verify?poll=..&receipt=..`. Sentry and PostHog started on every page in `apps/web/src/telemetry.ts`. PostHog records the full page URL with every event, and Sentry records it with every error and breadcrumb, so the invite code (the fragment) and receipts (the query) would have been sent to two third parties.

**Decision.**
1. On `/vote/*` and `/verify*` telemetry is not initialised at all: no SDK call, no script, no request to either host. The decision is made from `location.pathname` when the page loads.
2. If a page that did start telemetry navigates (client-side) into one of those paths, capturing stops: Sentry is closed and PostHog opted out. Navigating out of a private page does not start it; that page load stays private.
3. As a second layer, `before_send` (Sentry and PostHog) drops anything captured on a private path, and every URL in an event, breadcrumb or stack frame has its query string and fragment removed everywhere else (`apps/web/src/scrub.ts`). Sentry's `sendDefaultPii` is not enabled, and referrer headers are removed.
4. On the server, the tracing middleware records the method, the route pattern (`/api/vote/:pollId/start`, not the concrete path), the status and the duration, in logs and in the exported span. Nothing from a body or header is read. The unhandled-error log on voter routes records the error class only, because an error message could echo a request. The Worker's Sentry `beforeSend` removes request bodies, query strings, cookies and credential headers.

**Evidence.** `e2e/privacy.spec.ts` builds the app with fake Sentry and PostHog keys, intercepts every request to those hosts, and shows: public pages do send (so the test is not vacuous) and never include a fragment; a voter page, the receipt-check page and a client-side navigation into either send nothing, including after a thrown error. Switching the path check off makes three of those tests fail. `apps/api/src/privacy-logs.test.ts` captures every console line and exported span while the voter routes run and asserts the invite code and student number appear in none.

**Consequences.** No error reports or page counts from voters; a bug there is found by the organiser or in the Worker logs. The decision rests on the URL path; a new voter-facing route must be added to `isPrivatePath`. Console output from the voter page is not captured by anything, because nothing runs there. Fonts and the app itself come from the same origin.
