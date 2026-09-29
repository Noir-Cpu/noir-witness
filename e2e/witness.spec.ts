import AxeBuilder from "@axe-core/playwright";
import { expect, test, devices, type Page, type BrowserContext } from "@playwright/test";

const numbers = Array.from({ length: 12 }, (_, i) => `S${2000000 + i}`);
const csv = ["Student number", ...numbers].join("\n");

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations, JSON.stringify(results.violations.map((v) => v.id))).toEqual([]);
}

// Chromium's virtual authenticator stands in for a phone's fingerprint or face unlock.
async function withAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

test("home page and verify page are accessible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Votes you can check" })).toBeVisible();
  await axe(page);
  await page.goto("/verify");
  await expect(page.getByRole("heading", { name: "Check a receipt" })).toBeVisible();
  await axe(page);
});

test("health endpoint responds", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  expect(res.headers()["x-request-id"]).toBeTruthy();
});

test("a small electorate gets a warning", async ({ page }) => {
  await page.goto("/organiser");
  await page.getByLabel("Organisation").fill("Tiny Club");
  await page.getByLabel("Poll title").fill("Tiny poll");
  await page.getByLabel("Question").fill("Yes or no?");
  await page.getByLabel("Options").fill("Yes\nNo");
  await page.getByRole("button", { name: "Create poll" }).click();
  await expect(page.getByRole("heading", { name: "Tiny poll" })).toBeVisible();
  await page.getByLabel(/Upload a CSV/).setInputFiles({ name: "roll.csv", mimeType: "text/csv", buffer: Buffer.from("S1000001\nS1000002\nS1000003\n") });
  await expect(page.getByRole("note")).toContainText("fewer than 10");
  await axe(page);
});

test("organiser to voter to verified receipt", async ({ page, browser }) => {
  // --- Organiser: create, add an option, upload the roll, invite, open.
  await page.goto("/organiser");
  await expect(page.getByRole("heading", { name: "Your polls" })).toBeVisible();
  await axe(page);
  await page.getByLabel("Organisation").fill("Developer Society");
  await page.getByLabel("Poll title").fill("Chair 2026");
  await page.getByLabel("Question").fill("Who should chair?");
  await page.getByLabel("Options").fill("Ada\nBo");
  await page.getByRole("button", { name: "Create poll" }).click();
  await expect(page.getByRole("heading", { name: "Chair 2026" })).toBeVisible();
  const pollId = page.url().split("/").pop()!;

  await page.getByLabel("New option").fill("Cy");
  await page.getByRole("button", { name: "Add option" }).click();
  await expect(page.getByText("Cy", { exact: true })).toBeVisible();
  await page.getByLabel(/Upload a CSV/).setInputFiles({ name: "roll.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByText("12 voters on the roll.")).toBeVisible();
  await page.getByRole("button", { name: "Create invite link" }).click();
  const inviteLink = (await page.getByTestId("invite-link").textContent())!;
  expect(inviteLink).toContain(`/vote/${pollId}#code=`);
  await axe(page);
  await page.getByRole("button", { name: "Open poll" }).click();
  await expect(page.getByText("The poll is open.").first()).toBeVisible();

  // --- Voter on a phone: invite, student number, passkey, ballot, receipt.
  const phone = await browser.newContext({ ...devices["Pixel 7"] });
  const v = await phone.newPage();
  await withAuthenticator(phone, v);
  await v.goto(inviteLink);
  await expect(v.getByRole("heading", { name: "Chair 2026" })).toBeVisible();
  await expect(v.getByLabel(/Invite code/)).not.toHaveValue("");
  await axe(v);
  // 16px side gutters at phone width, no horizontal scroll.
  expect(await v.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await v.evaluate(() => parseFloat(getComputedStyle(document.querySelector("main")!).paddingLeft))).toBeGreaterThanOrEqual(16);

  await v.getByLabel(/Student number/).fill("s2000003");
  await v.getByRole("button", { name: "Continue" }).click();
  await expect(v.getByRole("heading", { name: "Set up your passkey" })).toBeVisible();
  await axe(v);
  await v.getByRole("button", { name: "Create passkey" }).click();

  await expect(v.getByRole("heading", { name: "Chair 2026" })).toBeVisible();
  await axe(v);
  // Keyboard only from here: focus the first radio, move to the second with the arrow key, then submit.
  await v.getByRole("radio", { name: "Ada" }).focus();
  await v.keyboard.press("ArrowDown");
  await expect(v.getByRole("radio", { name: "Bo" })).toBeChecked();
  await v.getByRole("button", { name: "Review my vote" }).press("Enter");
  await expect(v.getByRole("heading", { name: "Confirm your vote" })).toBeVisible();
  await expect(v.getByText("Bo", { exact: true })).toBeVisible();
  await axe(v);
  await v.getByRole("button", { name: "Cast my vote" }).press("Enter");
  await expect(v.getByRole("heading", { name: "Your vote is in" })).toBeVisible();
  const receipt = (await v.getByTestId("receipt").textContent())!.trim();
  expect(receipt).toMatch(/^[0-9a-f]{32}$/);
  await axe(v);

  // Same voter returns: the passkey now authenticates instead of registering, and the poll says they have voted.
  await v.goto("/");
  await v.goto(inviteLink);
  await v.getByLabel(/Student number/).fill("S2000003");
  await v.getByRole("button", { name: "Continue" }).click();
  await expect(v.getByRole("heading", { name: "Confirm it is you" })).toBeVisible();
  await v.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(v.getByRole("heading", { name: "You have already voted" })).toBeVisible();

  // A wrong student number gets a plain refusal.
  await v.goto("/");
  await v.goto(inviteLink);
  await v.getByLabel(/Student number/).fill("S9999999");
  await v.getByRole("button", { name: "Continue" }).click();
  await expect(v.getByRole("alert")).toContainText("do not match");

  // --- Organiser closes and publishes.
  await page.reload();
  await page.getByRole("button", { name: "Close poll…" }).click();
  await page.getByRole("button", { name: "Yes, close it" }).click();
  await expect(page.getByText("1 of 12 eligible voters cast a ballot.")).toBeVisible();
  await expect(page.getByRole("table")).toContainText("Bo");
  await page.getByRole("button", { name: "Publish results" }).click();
  await expect(page.getByText(/^Published\. Share/)).toBeVisible();
  await axe(page);

  // --- Anyone: public results and receipt check.
  const results = await phone.newPage();
  await results.goto(`/results/${pollId}`);
  await expect(results.getByRole("heading", { name: "Chair 2026" })).toBeVisible();
  await expect(results.getByText(/recomputed the tally and Merkle root/)).toBeVisible();
  await axe(results);

  await results.goto(`/verify?poll=${pollId}`);
  await results.getByRole("textbox", { name: /^Receipt/ }).fill(receipt);
  await results.getByRole("button", { name: "Check" }).click();
  await expect(results.getByTestId("receipt-result")).toContainText("Your receipt is in the count");
  await expect(results.getByTestId("receipt-result")).toContainText("Who should chair?: Bo");
  await axe(results);
  await results.getByRole("textbox", { name: /^Receipt/ }).fill("0".repeat(32));
  await results.getByRole("button", { name: "Check" }).click();
  await expect(results.getByTestId("receipt-result")).toContainText("not in the published ballot list");
  await phone.close();
});
