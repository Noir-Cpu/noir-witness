import { describe, expect, it } from "vitest";
import { API_HEADERS } from "../../api/src/security";
import { headFor } from "./seo";
import { NOINDEX_PATHS, PUBLIC_PAGES, headersFile, pagePolicy, robotsTxt, sitemapXml, telemetryOrigins } from "../site";

describe("static security headers (apps/web/site.ts)", () => {
  const file = headersFile();
  const rules = file.trim().split(/\n\n/).map((b) => {
    const [path, ...lines] = b.split("\n");
    return { path: path!, headers: Object.fromEntries(lines.map((l) => [l.slice(2, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 2)])) };
  });
  const all = rules.find((r) => r.path === "/*")!.headers;

  it("the page policy has no inline script, only this origin, no framing, forms and base locked down", () => {
    const csp = all["content-security-policy"]!;
    for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'self'", "base-uri 'none'", "object-src 'none'"]) {
      expect(csp.split("; ")).toContain(d);
    }
    expect(csp).not.toMatch(/unsafe-|\*|https?:/);
  });

  it("matches the API's values for everything they share, so the app has one policy", () => {
    for (const k of ["strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy", "cross-origin-opener-policy", "cross-origin-resource-policy"]) {
      expect(all[k], k).toBe(API_HEADERS[k]);
    }
    // Pages use a shorter permissions list than the API (the same grants, fewer denials); the passkey grants are identical.
    for (const f of ["publickey-credentials-get=(self)", "publickey-credentials-create=(self)", "camera=()", "microphone=()"]) {
      expect(all["permissions-policy"]).toContain(f);
      expect(API_HEADERS["permissions-policy"]).toContain(f);
    }
  });

  it("no header appears in two rules (Cloudflare would join the values)", () => {
    const seen = new Map<string, string[]>();
    for (const r of rules) for (const k of Object.keys(r.headers)) seen.set(k, [...(seen.get(k) ?? []), r.path]);
    // X-Robots-Tag is in the six noindex rules, which never match the same URL.
    for (const [k, paths] of seen) if (paths.length > 1) expect(k, paths.join(",")).toBe("x-robots-tag");
    expect(rules.find((r) => r.path === "/assets/*")!.headers["x-robots-tag"]).toBeUndefined();
  });

  it("every private path is noindex; public pages are in no noindex rule", () => {
    for (const p of NOINDEX_PATHS) {
      const r = rules.find((x) => x.path === p)!;
      expect(r.headers["x-robots-tag"]).toContain("noindex");
    }
    for (const p of PUBLIC_PAGES) expect(NOINDEX_PATHS.some((n) => n === p || (n.endsWith("/*") && p.startsWith(n.slice(0, -1))))).toBe(false);
  });

  it("allows telemetry hosts only when they were configured", () => {
    expect(telemetryOrigins({})).toEqual([]);
    expect(pagePolicy(telemetryOrigins({}))).toContain("connect-src 'self';");
    const origins = telemetryOrigins({ VITE_SENTRY_DSN: "https://abc@o1.ingest.sentry.io/2", VITE_POSTHOG_KEY: "phc_x", VITE_POSTHOG_HOST: "https://eu.i.posthog.com" });
    expect(origins).toEqual(["https://o1.ingest.sentry.io", "https://eu.i.posthog.com", "https://eu-assets.i.posthog.com"]);
    expect(telemetryOrigins({ VITE_POSTHOG_KEY: "k", VITE_POSTHOG_HOST: "https://ph.example.org" })).toEqual(["https://ph.example.org"]);
    expect(telemetryOrigins({ VITE_SENTRY_DSN: "not a url" })).toEqual([]);
  });
});

describe("robots.txt, sitemap.xml and in-page indexing rules agree", () => {
  it("the sitemap lists exactly the public pages, absolute, and robots.txt points at it", () => {
    const site = "https://example.org";
    expect([...sitemapXml(site).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual(["https://example.org/", "https://example.org/privacy"]);
    expect(robotsTxt(site)).toContain("Sitemap: https://example.org/sitemap.xml");
    expect(robotsTxt(site)).not.toMatch(/^Disallow: \/\s*$/m);
  });

  it("the in-page head says index only for the pages the sitemap lists", () => {
    for (const p of PUBLIC_PAGES) expect(headFor(p).index, p).toBe(true);
    for (const p of ["/vote/11111111-1111-4111-8111-111111111111", "/organiser", "/organiser/polls/x", "/verify", "/results/x", "/nope"]) {
      expect(headFor(p).index, p).toBe(false);
      expect(headFor(p).canonical, p).toBeUndefined();
    }
  });

  it("titles are distinct and short enough for a search result, and the home description fits", () => {
    const titles = ["/", "/privacy", "/verify", "/vote/x", "/organiser", "/results/x", "/nope"].map((p) => headFor(p).title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const t of titles) expect(t.length).toBeLessThanOrEqual(60);
    const d = headFor("/").description!;
    expect(d.length).toBeGreaterThanOrEqual(110);
    expect(d.length).toBeLessThanOrEqual(160);
  });
});
