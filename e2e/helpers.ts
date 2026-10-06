import AxeBuilder from "@axe-core/playwright";
import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

export async function axe(page: Page, tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]) {
  const results = await new AxeBuilder({ page }).withTags(tags).analyze();
  expect(results.violations, JSON.stringify(results.violations.map((v) => v.id))).toEqual([]);
}

// Chromium's virtual authenticator stands in for a phone's fingerprint or face unlock.
export async function withAuthenticator(context: BrowserContext, page: Page, opts: { verified?: boolean } = {}) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: opts.verified ?? true, automaticPresenceSimulation: true,
    },
  });
  return {
    setVerified: (isUserVerified: boolean) => cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified }),
  };
}

/**
 * Records every Content-Security-Policy violation and every console error in every page of the context: the
 * securitypolicyviolation event (reported through a binding that survives navigations) and the browser's own console
 * message. A test calls `.problems()` at the end and expects an empty list.
 */
export async function watchPolicy(context: BrowserContext) {
  const found: string[] = [];
  await context.exposeBinding("__cspReport", (_src, report: string) => void found.push(`csp: ${report}`));
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      void (window as unknown as { __cspReport(s: string): void }).__cspReport(`${e.violatedDirective} blocked ${e.blockedURI || "inline"} at ${e.sourceFile || location.pathname}:${e.lineNumber}`);
    });
  });
  const attach = (page: Page) => {
    page.on("console", (m) => {
      const text = m.text();
      if (m.type() === "error" || /content security policy|refused to|permissions-policy|permissions policy/i.test(text)) found.push(`console ${m.type()}: ${text}`);
    });
    page.on("pageerror", (e) => found.push(`pageerror: ${e.message}`));
  };
  context.on("page", attach);
  for (const p of context.pages()) attach(p);
  return { problems: () => [...found] };
}

export const numbers = (n: number, from = 3000000) => Array.from({ length: n }, (_, i) => `S${from + i}`);

/** Creates and opens a poll through the API (the dev server's organiser is fixed). Returns the invite link and ids. */
export async function openPoll(request: APIRequestContext, opts: { voters?: string[]; title?: string; question?: string; options?: string[] } = {}) {
  const ok = async (r: Awaited<ReturnType<APIRequestContext["post"]>>) => (expect(r.ok(), await r.text()).toBe(true), r);
  const voters = opts.voters ?? numbers(12);
  const created = await ok(await request.post("/api/organiser/polls", {
    data: { organisation: "Keyboard Society", title: opts.title ?? "Treasurer 2026", description: "", question: opts.question ?? "Who should be treasurer?", options: opts.options ?? ["Ada", "Bo", "Cy"] },
  }));
  const { id } = (await created.json()) as { id: string };
  await ok(await request.put(`/api/organiser/polls/${id}/roll`, { headers: { "content-type": "text/csv" }, data: ["Student number", ...voters].join("\n") }));
  const { code } = (await (await ok(await request.post(`/api/organiser/polls/${id}/invite`, { data: {} }))).json()) as { code: string };
  await ok(await request.post(`/api/organiser/polls/${id}/open`));
  return { id, code, voters, link: `/vote/${id}#code=${code}` };
}

/** The e2e build carries fake Sentry and PostHog keys. Answer those hosts locally so nothing leaves the machine and no real server replies 401. */
export async function stubTelemetry(context: BrowserContext) {
  await context.route((u) => /(^|\.)(sentry\.io|posthog\.com)$/.test(u.hostname), (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
}
