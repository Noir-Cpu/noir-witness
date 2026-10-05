// Defence in depth for error reports (ADR 0015). Voter requests carry an invite code and a student number in the body
// and a session token in a header. Sentry does not send them by default; this makes sure of it.
type Event = {
  request?: { url?: string; data?: unknown; query_string?: unknown; cookies?: unknown; headers?: Record<string, string> };
};

const stripUrl = (u: string) => u.replace(/[?#].*$/, "");

export function scrubSentryEvent<T extends Event>(event: T): T {
  const r = event.request;
  if (r) {
    if (r.url) r.url = stripUrl(r.url);
    delete r.data;
    delete r.query_string;
    delete r.cookies;
    if (r.headers) {
      for (const k of Object.keys(r.headers)) if (/^(authorization|cookie|referer|x-forwarded-for|cf-connecting-ip)$/i.test(k)) delete r.headers[k];
    }
  }
  return event;
}
