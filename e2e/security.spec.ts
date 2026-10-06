import { expect, test, devices } from "@playwright/test";
import { axe, numbers, openPoll, stubTelemetry, watchPolicy, withAuthenticator } from "./helpers";

const POLL = "11111111-1111-4111-8111-111111111111";

// ---- Headers on what the server really sends (static files from dist/_headers, API responses from the Worker code) ----

const COMMON = ["content-security-policy", "strict-transport-security", "x-content-type-options", "referrer-policy", "permissions-policy", "cross-origin-opener-policy", "cross-origin-resource-policy"];

test.describe("response headers", () => {
  test("every static page and asset carries the policy, with no header repeated", async ({ request }) => {
    for (const path of ["/", "/privacy", "/verify", "/organiser", `/vote/${POLL}`, `/results/${POLL}`, "/robots.txt", "/sitemap.xml", "/og.png", "/no-such-page"]) {
      const res = await request.get(path);
      const h = res.headers();
      for (const name of COMMON) expect(h[name], `${path} ${name}`).toBeTruthy();
      for (const [name, value] of Object.entries(h)) expect(value, `${path} ${name} is repeated`).not.toMatch(/^(.+), \1$/);
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["referrer-policy"]).toBe("no-referrer");
      expect(h["cross-origin-opener-policy"]).toBe("same-origin");
      expect(h["cross-origin-resource-policy"]).toBe("same-origin");
      expect(h["strict-transport-security"]).toMatch(/max-age=\d{8}/);
      expect(h["permissions-policy"]).toContain("publickey-credentials-get=(self)");
      expect(h["permissions-policy"]).toContain("publickey-credentials-create=(self)");
      const csp = h["content-security-policy"]!;
      for (const d of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'self'", "base-uri 'none'", "object-src 'none'"]) expect(csp, path).toContain(d);
      expect(csp, path).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(csp, path).not.toMatch(/script-src[^;]*(\*|https?:|data:)/);
    }
  });

  test("private pages are noindex; public pages are indexable", async ({ request }) => {
    for (const path of [`/vote/${POLL}`, "/organiser", "/organiser/polls/" + POLL, "/verify", `/results/${POLL}`]) {
      const h = (await request.get(path)).headers();
      expect(h["x-robots-tag"], path).toContain("noindex");
    }
    for (const path of ["/", "/privacy", "/robots.txt", "/sitemap.xml"]) {
      expect((await request.get(path)).headers()["x-robots-tag"], path).toBeUndefined();
    }
    expect((await request.get("/privacy")).status()).toBe(200);
  });

  test("hashed assets are cached for a year", async ({ request }) => {
    const html = await (await request.get("/")).text();
    const js = /src="(\/assets\/[^"]+\.js)"/.exec(html)![1]!;
    expect((await request.get(js)).headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  test("API responses carry the policy, and voter and organiser responses are no-store", async ({ request }) => {
    for (const [path, method] of [["/api/health", "GET"], [`/api/polls/${POLL}`, "GET"], [`/api/vote/${POLL}/ballot`, "GET"], ["/api/organiser/polls", "GET"], ["/api/nope", "GET"], [`/api/vote/${POLL}/start`, "POST"]] as const) {
      const res = await request.fetch(path, { method, data: method === "POST" ? { code: "x".repeat(10), studentNumber: "S1" } : undefined });
      const h = res.headers();
      for (const name of COMMON) expect(h[name], `${path} ${name}`).toBeTruthy();
      expect(h["content-security-policy"]).toContain("default-src 'none'");
      expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(h["x-robots-tag"]).toContain("noindex");
      expect(h["cache-control"], path).toBe("no-store");
      expect(h["access-control-allow-origin"], path).toBeUndefined();
    }
  });
});

// ---- Indexing ----

test.describe("search engines", () => {
  test("robots.txt and sitemap.xml are real files and list only the public pages", async ({ request, baseURL }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.headers()["content-type"]).toContain("text/plain");
    const text = await robots.text();
    expect(text).toMatch(/User-agent: \*/);
    expect(text).toMatch(/Sitemap: https:\/\/.+\/sitemap\.xml/);
    expect(text).not.toMatch(/Disallow: \/\s*$/m); // never blocks the site
    const sm = await request.get("/sitemap.xml");
    expect(sm.headers()["content-type"]).toMatch(/xml/);
    const locs = [...(await sm.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname);
    expect(locs).toEqual(["/", "/privacy"]);
    expect(baseURL).toBeTruthy();
  });

  test("the landing page has a title, description, canonical, share image and valid JSON-LD", async ({ page }) => {
    await page.goto("/");
    const title = await page.title();
    expect(title.length).toBeGreaterThan(20);
    expect(title.length).toBeLessThanOrEqual(60);
    const desc = await page.locator('meta[name="description"]').getAttribute("content");
    expect(desc!.length).toBeGreaterThanOrEqual(110);
    expect(desc!.length).toBeLessThanOrEqual(160);
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toMatch(/^https:\/\/[^/]+\/$/);
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toMatch(/^index/);
    expect(await page.locator('meta[property="og:image"]').getAttribute("content")).toMatch(/^https:\/\/.+\/og\.png$/);
    expect(await page.locator('meta[name="twitter:card"]').getAttribute("content")).toBe("summary_large_image");
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!);
    expect(ld["@type"]).toBe("WebApplication");
    expect(ld.name).toBe("WITNESS");
    await expect(page.locator("h1")).toHaveCount(1);
  });

  test("the share image and icons exist", async ({ request }) => {
    for (const [path, type] of [["/og.png", "image/png"], ["/favicon.svg", "image/svg"], ["/apple-touch-icon.png", "image/png"], ["/favicon.ico", "image/"]] as const) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()["content-type"], path).toContain(type);
    }
  });

  test("/privacy is its own indexable page, with its own title and canonical, even without running scripts", async ({ request, page }) => {
    const html = await (await request.get("/privacy")).text();
    expect(html).toMatch(/<title>Privacy notice \| WITNESS<\/title>/);
    expect(html).toMatch(/<link rel="canonical" href="https:\/\/[^"]+\/privacy"/);
    expect(html).not.toContain("ld+json");
    await page.goto("/privacy");
    await expect(page).toHaveTitle("Privacy notice | WITNESS");
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toMatch(/^index/);
  });

  test("voter, organiser, receipt and results pages say noindex inside the page too, and claim no canonical", async ({ page }) => {
    for (const path of [`/vote/${POLL}#code=abcdefgh`, "/organiser", "/verify", `/results/${POLL}`, "/no-such-page"]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      expect(await page.locator('meta[name="robots"]').getAttribute("content"), path).toMatch(/^noindex/);
      await expect(page.locator('link[rel="canonical"]'), path).toHaveCount(0);
    }
    // And a client-side move from the public page to a private one flips it, then back.
    await page.goto("/");
    await page.getByRole("link", { name: "Check a receipt" }).first().click();
    await expect(page).toHaveURL(/\/verify$/);
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toMatch(/^noindex/);
    await page.getByRole("link", { name: "WITNESS" }).click();
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toMatch(/^index/);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
  });
});

// ---- Content Security Policy across the whole happy path ----

test("no Content-Security-Policy violation, console error or page error anywhere on the full happy path, passkey included", async ({ page, browser }) => {
  const policy = await watchPolicy(page.context());
  await stubTelemetry(page.context());
  // Organiser
  await page.goto("/organiser");
  await page.getByLabel("Organisation").fill("CSP Society");
  await page.getByLabel("Poll title").fill("CSP poll");
  await page.getByLabel("Question").fill("Pick one");
  await page.getByLabel("Options").fill("Ada\nBo");
  await page.getByRole("button", { name: "Create poll" }).click();
  await expect(page.getByRole("heading", { name: "CSP poll" })).toBeVisible();
  const pollId = page.url().split("/").pop()!;
  await page.getByLabel(/Upload a CSV/).setInputFiles({ name: "roll.csv", mimeType: "text/csv", buffer: Buffer.from(["Student number", ...numbers(12, 4000000)].join("\n")) });
  await expect(page.getByText("12 voters on the roll.")).toBeVisible();
  await page.getByRole("button", { name: "Create invite link" }).click();
  const inviteLink = (await page.getByTestId("invite-link").textContent())!;
  await page.getByRole("button", { name: "Open poll" }).click();
  await expect(page.getByText("The poll is open.").first()).toBeVisible();

  // Voter on a phone, with the passkey ceremony (registration, then authentication on a second visit)
  const phone = await browser.newContext({ ...devices["Pixel 7"] });
  const phonePolicy = await watchPolicy(phone);
  await stubTelemetry(phone);
  const v = await phone.newPage();
  await withAuthenticator(phone, v);
  await v.goto(inviteLink);
  await v.getByLabel(/Student number/).fill("S4000003");
  await v.getByRole("button", { name: "Continue" }).click();
  await expect(v.getByRole("heading", { name: "Set up your passkey" })).toBeVisible();
  await v.getByRole("button", { name: "Create passkey" }).click();
  await expect(v.getByRole("heading", { name: "CSP poll" })).toBeVisible();
  await v.getByRole("radio", { name: "Bo" }).check();
  await v.getByRole("button", { name: "Review my vote" }).click();
  await v.getByRole("button", { name: "Cast my vote" }).click();
  await expect(v.getByRole("heading", { name: "Your vote is in" })).toBeVisible();
  const receipt = (await v.getByTestId("receipt").textContent())!.trim();
  await v.getByRole("button", { name: "Copy receipt" }).click();
  await v.goto("/");
  await v.goto(inviteLink);
  await v.getByLabel(/Student number/).fill("S4000003");
  await v.getByRole("button", { name: "Continue" }).click();
  await expect(v.getByRole("heading", { name: "Confirm it is you" })).toBeVisible();
  await v.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(v.getByRole("heading", { name: "You have already voted" })).toBeVisible();

  // Close, publish, results, receipt check, privacy notice
  await page.reload();
  await page.getByRole("button", { name: "Close poll…" }).click();
  await page.getByRole("button", { name: "Yes, close it" }).click();
  await expect(page.getByRole("table")).toContainText("Bo");
  await page.getByRole("button", { name: "Publish results" }).click();
  await expect(page.getByText(/^Published\. Share/)).toBeVisible();
  await page.getByRole("button", { name: "Erase voter data…" }).click();
  await page.getByRole("button", { name: "Yes, erase it" }).click();
  await expect(page.getByTestId("retention-erased")).toBeVisible();
  const anyone = await phone.newPage();
  await anyone.goto(`/results/${pollId}`);
  await expect(anyone.getByText(/recomputed the tally and Merkle root/)).toBeVisible();
  await anyone.goto(`/verify?poll=${pollId}`);
  await anyone.getByRole("textbox", { name: /^Receipt/ }).fill(receipt);
  await anyone.getByRole("button", { name: "Check" }).click();
  await expect(anyone.getByTestId("receipt-result")).toContainText("Your receipt is in the count");
  await anyone.goto("/privacy");
  await expect(anyone.getByRole("heading", { name: "Privacy notice", level: 1 })).toBeVisible();
  await anyone.goto("/");
  await expect(anyone.getByRole("heading", { level: 1 })).toBeVisible();
  await axe(anyone);

  expect(policy.problems()).toEqual([]);
  expect(phonePolicy.problems()).toEqual([]);
  await phone.close();
});

test("the policy really is enforced: an injected inline script and an off-site request are blocked and reported", async ({ page }) => {
  const policy = await watchPolicy(page.context());
  await page.goto("/");
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__ran = true";
    document.body.appendChild(s);
  });
  expect(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran)).toBeUndefined();
  const offsite = await page.evaluate(() => fetch("https://example.com/").then(() => "sent", () => "blocked"));
  expect(offsite).toBe("blocked");
  const framed = await page.evaluate(() => document.querySelector("meta[http-equiv]") === null);
  expect(framed).toBe(true);
  await expect.poll(() => policy.problems().some((p) => p.startsWith("csp: script-src")), { timeout: 5000 }).toBe(true);
  await expect.poll(() => policy.problems().some((p) => p.startsWith("csp: connect-src")), { timeout: 5000 }).toBe(true);
});

test("a page cannot be framed", async ({ page, baseURL }) => {
  await page.goto("/");
  const blocked = await page.evaluate(
    (src) =>
      new Promise<string>((resolve) => {
        const f = document.createElement("iframe");
        f.src = src;
        f.onload = () => resolve("loaded");
        f.onerror = () => resolve("error");
        document.body.appendChild(f);
        setTimeout(() => resolve("timeout"), 3000);
      }),
    `${baseURL}/privacy`,
  ).catch(() => "blocked");
  // The frame's own document is refused (frame-ancestors 'none'), so it never has the app's content.
  const frame = page.frames().find((f) => f.url().endsWith("/privacy"));
  const hasApp = frame ? await frame.evaluate(() => Boolean(document.querySelector("#root h1"))).catch(() => false) : false;
  expect(hasApp, `iframe result: ${blocked}`).toBe(false);
});

test("an organiser who is signed in but not approved sees a clear screen, not a broken page", async ({ page }) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ user: null, error: "not_approved", message: "This deployment only allows approved organisers." }) }),
  );
  await page.goto("/organiser");
  await expect(page.getByRole("heading", { name: "Not an approved organiser" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("only allows approved organisers");
  await expect(page.getByRole("button", { name: "Create poll" })).toHaveCount(0);
  await axe(page);
});
