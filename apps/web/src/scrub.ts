// Pure helpers for keeping personal data out of analytics and error reports (ADR 0015). No imports, so they are
// unit-testable without a browser.

// Pages where the address or the page itself carries something private: /vote/<poll>#code=<invite code> and
// /verify?poll=..&receipt=<receipt>. No analytics or error reporting runs on them at all.
export const isPrivatePath = (pathname: string) => /^\/(vote|verify)(\/|$)/.test(pathname);

/** Removes the query string and fragment from a URL or path. Anything that is not a string is returned unchanged. */
export const stripUrl = <T>(u: T): T => (typeof u === "string" ? (u.replace(/[?#].*$/s, "") as unknown as T) : u);

type Json = Record<string, unknown>;
const URL_KEYS = ["url", "from", "to", "href"];

/** Sentry `beforeSend` / `beforeBreadcrumb`: strip query strings and fragments from every URL in the event. */
export function scrubEvent<T extends Json>(event: T): T {
  const e = event as Json;
  const req = e.request as Json | undefined;
  if (req) {
    if (typeof req.url === "string") req.url = stripUrl(req.url);
    delete req.query_string;
    delete req.cookies;
    const headers = req.headers as Record<string, string> | undefined;
    if (headers) for (const k of Object.keys(headers)) if (/^referer$/i.test(k)) delete headers[k];
  }
  if (typeof e.transaction === "string") e.transaction = stripUrl(e.transaction);
  const crumbs = e.breadcrumbs as Json[] | { values?: Json[] } | undefined;
  for (const b of Array.isArray(crumbs) ? crumbs : (crumbs?.values ?? [])) scrubBreadcrumb(b);
  const exceptions = (e.exception as { values?: { stacktrace?: { frames?: Json[] } }[] } | undefined)?.values ?? [];
  for (const ex of exceptions) for (const f of ex.stacktrace?.frames ?? []) for (const k of ["filename", "abs_path"]) f[k] = stripUrl(f[k]);
  return event;
}

export function scrubBreadcrumb<T extends Json>(crumb: T): T {
  const data = (crumb as Json).data as Json | undefined;
  if (data) for (const k of URL_KEYS) if (typeof data[k] === "string") data[k] = stripUrl(data[k]);
  return crumb;
}

/** PostHog `before_send`: strip query strings and fragments from the URL properties it adds to every event. */
export function scrubCapture<T extends { properties?: Json } | null>(capture: T): T {
  const p = capture?.properties;
  if (p) for (const k of ["$current_url", "$referrer", "$initial_referrer", "$initial_current_url", "$pathname", "$host"]) if (typeof p[k] === "string") p[k] = stripUrl(p[k]);
  return capture;
}
