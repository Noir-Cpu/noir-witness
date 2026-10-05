import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The web build for e2e carries fake Sentry and PostHog keys (playwright.config.ts). Every request to those hosts is
// intercepted and recorded; nothing leaves the machine.
const TELEMETRY_HOSTS = /(^|\.)(sentry\.io|posthog\.com)$/;
const POLL = "11111111-1111-4111-8111-111111111111";
const SECRET = "SECRETINVITECODE123";

type Seen = { url: string; body: string };
async function watch(page: Page) {
  const seen: Seen[] = [];
  await page.route((u) => TELEMETRY_HOSTS.test(u.hostname), async (route) => {
    seen.push({ url: route.request().url(), body: route.request().postData() ?? "" });
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  return seen;
}
const hostOf = (r: { url: string }) => new URL(r.url).hostname;
const sentSentry = (seen: { url: string }[]) => seen.some((r) => hostOf(r).endsWith(".sentry.io"));
const sentPosthog = (seen: { url: string }[]) => seen.some((r) => hostOf(r).endsWith(".posthog.com"));
const boom = (page: Page) => page.evaluate(() => void setTimeout(() => { throw new Error("test error"); }, 0));

test("control: public pages do send telemetry to the configured hosts, with no fragment or query", async ({ page }) => {
  const seen = await watch(page);
  await page.goto(`/#code=${SECRET}`);
  await expect(page.getByRole("heading", { name: "Votes you can check" })).toBeVisible();
  await boom(page);
  await expect.poll(() => sentSentry(seen), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => sentPosthog(seen), { timeout: 10_000 }).toBe(true);
  // What was sent never contains the fragment.
  for (const r of seen) {
    expect(r.url).not.toContain(SECRET);
    expect(decodeURIComponent(r.body)).not.toContain(SECRET);
  }
});

test("a voter page sends nothing to Sentry or PostHog, even on error or navigation", async ({ page }) => {
  const seen = await watch(page);
  await page.goto(`/vote/${POLL}#code=${SECRET}`);
  await expect(page.getByLabel(/Invite code/)).toHaveValue(SECRET);
  await boom(page);
  await page.getByLabel(/Student number/).fill("S1234567");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.waitForTimeout(3000); // PostHog and Sentry both batch for a couple of seconds
  expect(seen).toEqual([]);
});

test("the receipt-check page sends nothing either, including its query string", async ({ page }) => {
  const seen = await watch(page);
  await page.goto(`/verify?poll=${POLL}&receipt=${"a".repeat(32)}`);
  await expect(page.getByRole("heading", { name: "Check a receipt" })).toBeVisible();
  await boom(page);
  await page.waitForTimeout(3000);
  expect(seen).toEqual([]);
});

test("navigating from a public page into a voter page stops capturing", async ({ page }) => {
  const seen = await watch(page);
  await page.goto("/");
  await expect.poll(() => sentPosthog(seen), { timeout: 10_000 }).toBe(true);
  await page.getByRole("link", { name: "Check a receipt" }).first().click();
  await expect(page).toHaveURL(/\/verify$/);
  await page.waitForTimeout(500);
  seen.length = 0;
  await boom(page);
  await page.evaluate(() => (window as unknown as { history: History }).history.pushState(null, "", `/verify?receipt=${"b".repeat(32)}`));
  await page.waitForTimeout(3000);
  expect(seen).toEqual([]);
});

test("a voter who goes over the sign-in limit sees a kind message, and it is accessible", async ({ page }) => {
  await page.goto(`/vote/${POLL}#code=${SECRET}`);
  await page.getByLabel(/Student number/).fill("S7654321");
  const go = page.getByRole("button", { name: "Continue" });
  for (let i = 0; i < 10; i++) {
    await go.click();
    await expect(page.getByRole("alert")).toContainText("do not match");
  }
  await go.click();
  await expect(page.getByRole("alert")).toContainText("Too many attempts for this student number");
  await expect(page.getByRole("alert")).toContainText("Wait a minute");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations, JSON.stringify(results.violations.map((v) => v.id))).toEqual([]);
});

test.describe("privacy notice", () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true });

  test("is linked from every page and from the voter start page, reads well on a phone, and passes axe", async ({ page, context }) => {
    await page.goto("/");
    await page.getByRole("contentinfo").getByRole("link", { name: "Privacy notice" }).click();
    await expect(page.getByRole("heading", { name: "Privacy notice" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "How long we keep it" })).toBeVisible();
    await expect(page.locator("mark.placeholder").first()).toBeVisible(); // unfilled placeholders are loud
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations, JSON.stringify(results.violations.map((v) => v.id))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Tables turned into stacked rows: each value is labelled.
    await expect(page.locator("table.stack td[data-label]").first()).toBeVisible();
    expect(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector("main")!).paddingLeft))).toBeGreaterThanOrEqual(16);

    for (const path of ["/organiser", "/verify", "/results/" + POLL, `/vote/${POLL}`]) {
      await page.goto(path);
      await expect(page.getByRole("contentinfo").getByRole("link", { name: "Privacy notice" })).toBeVisible();
    }

    await page.goto(`/vote/${POLL}#code=${SECRET}`);
    const [popup] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: /How your data is handled/ }).click()]);
    await expect(popup.getByRole("heading", { name: "Privacy notice" })).toBeVisible();
    await expect(page.getByLabel(/Invite code/)).toHaveValue(SECRET); // the form was not lost
  });
});
