// Build-time generation of everything a crawler or a browser reads before the app runs: the static security headers
// (`_headers`, served by Workers static assets), robots.txt, sitemap.xml, and a /privacy page with its own title and
// canonical link. One module, so the policy, the noindex list and the sitemap cannot drift apart.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

export const DEFAULT_SITE_URL = "https://noir-witness.noir-cpu.workers.dev";

// Pages worth finding in a search engine. Everything else is private (an invite, an organiser screen, a receipt) or
// per-poll, and is marked noindex both here (X-Robots-Tag) and in the page itself (src/seo.ts).
export const PUBLIC_PAGES = ["/", "/privacy"];
export const NOINDEX_PATHS = ["/vote/*", "/organiser", "/organiser/*", "/verify", "/verify/*", "/results/*"];

const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

/** Origins the browser may send telemetry to: only those configured at build time. With none set the policy is 'self'. */
export function telemetryOrigins(env: Record<string, string | undefined>): string[] {
  const sentry = hostOf(env.VITE_SENTRY_DSN?.replace(/\/\/[^@/]*@/, "//"));
  const posthog = env.VITE_POSTHOG_KEY ? hostOf(env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com") : null;
  // PostHog's cloud also serves its project configuration (data, not code) from <region>-assets.i.posthog.com.
  const assets = posthog?.match(/^https:\/\/(\w+)\.i\.posthog\.com$/)?.[1];
  return [sentry, posthog, assets ? `https://${assets}-assets.i.posthog.com` : null].filter((o): o is string => Boolean(o));
}

export function pagePolicy(connect: string[] = []) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    `connect-src ${["'self'", ...connect].join(" ")}`,
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
  ].join("; ");
}

// Same values as apps/api/src/security.ts (security.test.ts compares them).
const HSTS = "max-age=31536000; includeSubDomains";
const PERMISSIONS =
  "publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=()";

export function headersFile(connect: string[] = []): string {
  const blocks: string[] = [];
  const block = (path: string, headers: Record<string, string>) =>
    blocks.push([path, ...Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`)].join("\n"));

  block("/*", {
    "Content-Security-Policy": pagePolicy(connect),
    "Strict-Transport-Security": HSTS,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": PERMISSIONS,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  // Cloudflare adds the headers of every matching rule together, so a header must appear in one rule only.
  // (The page shells hold no secrets and stay cacheable, which keeps the browser's back/forward cache working.)
  for (const p of NOINDEX_PATHS) {
    block(p, { "X-Robots-Tag": "noindex, nofollow, noarchive" });
  }
  block("/assets/*", { "Cache-Control": "public, max-age=31536000, immutable" });
  return blocks.join("\n\n") + "\n";
}

export const robotsTxt = (site: string) =>
  [
    "User-agent: *",
    // The API is not a page. Private pages are deliberately NOT disallowed here: a crawler that may not fetch them
    // can never see their noindex, and could still list the bare URL. They are served with X-Robots-Tag: noindex.
    "Disallow: /api/",
    "",
    `Sitemap: ${site}/sitemap.xml`,
    "",
  ].join("\n");

export const sitemapXml = (site: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  PUBLIC_PAGES.map((p) => `  <url><loc>${site}${p === "/" ? "/" : p}</loc></url>`).join("\n") +
  `\n</urlset>\n`;

export const PRIVACY_TITLE = "Privacy notice | WITNESS";
export const PRIVACY_DESCRIPTION =
  "What WITNESS stores when you vote, what it never stores, who can see it, and how long voter data is kept before it is erased.";

export function witnessSite(env: Record<string, string | undefined>): Plugin {
  const site = (env.VITE_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, "");
  let outDir = "dist";
  return {
    name: "witness-site",
    apply: "build",
    configResolved(c) {
      outDir = join(c.root, c.build.outDir);
    },
    transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", site),
    closeBundle() {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "_headers"), headersFile(telemetryOrigins(env)));
      writeFileSync(join(outDir, "robots.txt"), robotsTxt(site));
      writeFileSync(join(outDir, "sitemap.xml"), sitemapXml(site));
      // /privacy gets its own head so it is a distinct page to a crawler that does not run scripts.
      const index = readFileSync(join(outDir, "index.html"), "utf8");
      const privacy = index
        .replace(/<title>[^<]*<\/title>/, `<title>${PRIVACY_TITLE}</title>`)
        .replace(/(<meta name="description" content=")[^"]*(")/, `$1${PRIVACY_DESCRIPTION}$2`)
        .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${site}/privacy$2`)
        .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${site}/privacy$2`)
        .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${PRIVACY_TITLE}$2`)
        .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${PRIVACY_DESCRIPTION}$2`)
        .replace(/\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
      writeFileSync(join(outDir, "privacy.html"), privacy);
    },
  };
}
