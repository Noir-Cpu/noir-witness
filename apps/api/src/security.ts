import type { Context, MiddlewareHandler } from "hono";

// Response headers for everything the Worker itself generates (every /api/* response). Static files get the same
// policy from apps/web/public/_headers (generated at build time, see apps/web/headers.ts). Keep the two in step:
// e2e/security.spec.ts and security.test.ts check both.

// JSON only: nothing here is ever rendered, so the policy forbids loading anything at all.
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const HSTS = "max-age=31536000; includeSubDomains";

// WebAuthn is allowed for this origin only. Everything else the app never uses is switched off.
export const PERMISSIONS_POLICY =
  "publickey-credentials-get=(self), publickey-credentials-create=(self), " +
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), hid=(), " +
  "accelerometer=(), gyroscope=(), magnetometer=(), midi=(), display-capture=()";

export const API_HEADERS: Record<string, string> = {
  "content-security-policy": API_CSP,
  "strict-transport-security": HSTS,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": PERMISSIONS_POLICY,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

/**
 * Adds the security headers to every response and marks it uncacheable unless the handler chose a Cache-Control
 * itself (only the published bulletin does). Voter and organiser responses can carry session tokens, invite codes
 * and passkey challenges, so the default is no-store, not "whatever a proxy decides".
 */
export const securityHeaders = (): MiddlewareHandler => async (c, next) => {
  await next();
  const set = (res: Response) => {
    for (const [k, v] of Object.entries(API_HEADERS)) res.headers.set(k, v);
    if (!res.headers.has("cache-control")) res.headers.set("cache-control", "no-store");
  };
  try {
    set(c.res);
  } catch {
    // Read-only headers (a response returned by fetch(), e.g. a proxied one): rebuild it with mutable headers.
    c.res = new Response(c.res.body, c.res);
    set(c.res);
  }
};

/** The origin this deployment is served from: the configured public URL, else the request's own. */
export const ownOrigin = (c: Context): string => {
  const configured = (c.env as { BETTER_AUTH_URL?: string } | undefined)?.BETTER_AUTH_URL;
  try {
    return new URL(configured || c.req.url).origin;
  } catch {
    return new URL(c.req.url).origin;
  }
};

/**
 * Cross-site request forgery check for cookie-authenticated writes. SameSite=Lax cookies already stop most cross-site
 * writes; this refuses them explicitly as well, using what the browser itself reports:
 *  - Sec-Fetch-Site, when present, must be same-origin (or none: typed address or bookmark; a write never is).
 *  - Origin, when present, must be exactly this deployment's origin.
 * A request with neither header is not from a browser (curl, scripts, tests) and carries no ambient cookie to abuse.
 */
export function assertSameOriginWrite(c: Context): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== ownOrigin(c)) return false;
  return true;
}
