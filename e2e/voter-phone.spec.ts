import { expect, test, type Page } from "@playwright/test";
import { axe, openPoll, watchPolicy, withAuthenticator } from "./helpers";

// A first-time voter on a very small phone: 320 CSS pixels wide, touch, using only the keyboard where stated.
test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

// What the focused element is called, the way a screen reader would say it.
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "body";
    const labelled = el.getAttribute("aria-labelledby");
    const label = (el as HTMLInputElement).labels?.[0]?.textContent ?? (labelled ? document.getElementById(labelled)?.textContent : null);
    return `${el.tagName.toLowerCase()}:${(label ?? el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ")}`;
  });

async function tabTo(page: Page, want: RegExp, max = 12) {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const now = await focused(page);
    seen.push(now);
    if (want.test(now)) return seen;
  }
  throw new Error(`never focused ${want}; saw ${seen.join(" | ")}`);
}

// Every control must be at least 44 by 44 CSS pixels (24 is the WCAG 2.2 AA floor; 44 is what a thumb needs).
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
    };
    for (const el of document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=radio]):not([type=hidden]), textarea, select")) {
      if (el.closest(".skip")) continue; // off-screen until focused
      const b = box(el);
      if (b.visible && (b.h < 44 || b.w < 44)) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(b.w)}x${Math.round(b.h)}`);
    }
    for (const el of document.querySelectorAll<HTMLInputElement>("input[type=radio]")) {
      const b = box(el.closest("label") ?? el);
      if (b.h < 44) out.push(`radio ${Math.round(b.w)}x${Math.round(b.h)}`);
    }
    return out;
  });
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("full voter flow with the keyboard only, at 320px, with a sensible focus order and no dead ends", async ({ page, request, context }) => {
  const problems = await watchPolicy(context);
  const poll = await openPoll(request);
  await withAuthenticator(context, page);

  // Step 1: the invite link.
  await page.goto(poll.link);
  await expect(page.getByRole("heading", { name: "Treasurer 2026" })).toBeFocused(); // focus starts on the page heading
  expect(await noSideScroll(page)).toBe(true);
  expect(await smallTargets(page)).toEqual([]);

  // The heading has focus, so the first Tab goes straight into the form. Walking backwards shows the order of the page:
  // skip link, brand, the two navigation links, then the form.
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("input:Invite code");
  const back: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Shift+Tab");
    back.push(await focused(page));
  }
  expect(back).toEqual(["a:Check a receipt", "a:Organise", "a:WITNESS", "a:Skip to content"]);
  await page.keyboard.press("Enter"); // the skip link: moves past the header
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("input:Invite code");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("input:Student number");
  await page.keyboard.type("S3000000"); // typed, not filled
  await expect(page.getByLabel("Student number")).toHaveValue("S3000000");
  expect(await tabTo(page, /Continue/)).toEqual(["button:Continue"]);
  await page.keyboard.press("Enter");

  // Step 2: the passkey. The heading takes focus; the next Tab is the action.
  await expect(page.getByRole("heading", { name: "Set up your passkey" })).toBeFocused();
  expect(await noSideScroll(page)).toBe(true);
  expect(await smallTargets(page)).toEqual([]);
  expect(await tabTo(page, /Create passkey/)).toEqual(["button:Create passkey"]);
  await page.keyboard.press("Space");

  // Step 3: the ballot, by arrow keys.
  await expect(page.getByRole("heading", { name: "Treasurer 2026" })).toBeFocused();
  expect(await smallTargets(page)).toEqual([]);
  await page.keyboard.press("Tab");
  expect((await focused(page)).startsWith("input:")).toBe(true); // into the radio group
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "Cy" })).toBeChecked();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("radio", { name: "Bo" })).toBeChecked();
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("button:Review my vote");
  await page.keyboard.press("Enter");

  // Review, then cast.
  await expect(page.getByRole("heading", { name: "Confirm your vote" })).toBeFocused();
  await expect(page.getByText("Bo", { exact: true })).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("button:Cast my vote");
  await page.keyboard.press("Enter");

  // Receipt.
  await expect(page.getByRole("heading", { name: "Your vote is in" })).toBeFocused();
  expect(await noSideScroll(page)).toBe(true);
  expect(await smallTargets(page)).toEqual([]);
  const receipt = (await page.getByTestId("receipt").textContent())!.trim();
  expect(receipt).toMatch(/^[0-9a-f]{32}$/);
  await axe(page);
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("button:Copy receipt"); // reachable and nothing before it traps focus
  expect(problems.problems()).toEqual([]);
});

test("the passkey step explains a failure in plain words and offers a way forward", async ({ page, request, context }) => {
  const poll = await openPoll(request, { voters: ["S3100001", "S3100002", "S3100003"], title: "Fail poll" });
  const auth = await withAuthenticator(context, page, { verified: false }); // the phone's unlock fails
  await page.goto(poll.link);
  await page.getByLabel("Student number").fill("S3100001");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create passkey" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("cancelled or timed out");
  await expect(alert).toContainText("Tap the button to try again");
  await expect(alert).not.toContainText(/NotAllowed|Error|exception|undefined/i);
  await axe(page);
  await expect(page.getByRole("button", { name: "Create passkey" })).toBeEnabled();

  // Not a dead end: fix the unlock and try again on the same screen...
  await auth.setVerified(true);
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(page.getByRole("heading", { name: "Fail poll" })).toBeVisible();
});

test("a voter can go back from the passkey step to correct their details", async ({ page, request, context }) => {
  const poll = await openPoll(request, { voters: ["S3200001", "S3200002", "S3200003"], title: "Back poll" });
  await withAuthenticator(context, page);
  await page.goto(poll.link);
  await page.getByLabel("Student number").fill("S3200001");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Change my details" }).click();
  await expect(page.getByLabel("Student number")).toBeVisible();
  await expect(page.getByLabel("Invite code")).not.toHaveValue("");
  await page.getByLabel("Student number").fill("S3200002");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Set up your passkey" })).toBeVisible();
});

test("a browser without passkey support is told so before the voter tries", async ({ page, request }) => {
  const poll = await openPoll(request, { voters: ["S3300001", "S3300002", "S3300003"], title: "NoPasskey poll" });
  await page.addInitScript(() => Object.defineProperty(window, "PublicKeyCredential", { value: undefined }));
  await page.goto(poll.link);
  await page.getByLabel("Student number").fill("S3300001");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("note")).toContainText("cannot use passkeys");
  await axe(page);
});

test("a wrong student number gets one calm sentence that says what to check, and the form stays usable", async ({ page, request }) => {
  const poll = await openPoll(request, { voters: ["S3400001", "S3400002", "S3400003"], title: "Typo poll" });
  await page.goto(poll.link);
  await page.getByLabel("Student number").fill("S9999999");
  await page.getByRole("button", { name: "Continue" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("do not match");
  await expect(alert).toContainText("Check your student number");
  await expect(page.getByLabel("Student number")).toHaveValue("S9999999"); // what they typed is kept
  await axe(page);
});

test("a link to a poll that does not exist, a poll not yet open and a closed poll each say what to do", async ({ page, request }) => {
  await page.goto("/vote/00000000-0000-4000-8000-000000000000#code=abcdefghijk");
  await expect(page.getByRole("heading", { name: "We could not find this poll" })).toBeVisible();
  await expect(page.getByText(/Check that you copied the whole link/)).toBeVisible();
  await axe(page);

  const created = await request.post("/api/organiser/polls", { data: { organisation: "S", title: "Later poll", description: "", question: "Q?", options: ["a", "b"] } });
  const { id } = (await created.json()) as { id: string };
  await page.goto(`/vote/${id}#code=abcdefghijk`);
  await expect(page.getByRole("note")).toContainText("has not opened yet");
  await axe(page);

  const open = await openPoll(request, { voters: ["S3500001", "S3500002", "S3500003"], title: "Done poll" });
  expect((await request.post(`/api/organiser/polls/${open.id}/close`)).ok()).toBe(true);
  await page.goto(open.link);
  await expect(page.getByRole("note")).toContainText("has closed");
  await expect(page.getByRole("note")).toContainText("not published the results yet");
  expect((await request.post(`/api/organiser/polls/${open.id}/publish`)).ok()).toBe(true);
  await page.goto("/");
  await page.goto(open.link);
  await expect(page.getByRole("link", { name: "See the results" })).toBeVisible();
});

test("the receipt check page is usable at 320px and its fields have separate names and descriptions", async ({ page }) => {
  await page.goto("/verify");
  expect(await noSideScroll(page)).toBe(true);
  expect(await smallTargets(page)).toEqual([]);
  const receipt = page.getByRole("textbox", { name: "Receipt", exact: true });
  await expect(receipt).toHaveAccessibleDescription(/Leave blank/);
  await axe(page);
});

// Axe in both colour schemes on every screen a voter or organiser sees, not just the privacy notice.
for (const scheme of ["light", "dark"] as const) {
  test(`axe passes on every voter and organiser screen in ${scheme} mode`, async ({ page, request, context }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await withAuthenticator(context, page);
    const poll = await openPoll(request, { voters: ["S3600001", "S3600002", "S3600003"], title: `Contrast ${scheme}` });
    for (const path of ["/", "/privacy", "/verify", "/organiser", `/organiser/polls/${poll.id}`, "/no-such-page"]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      await axe(page);
    }
    await page.goto(poll.link);
    await axe(page);
    await page.getByLabel("Student number").fill("S9999999"); // an error state
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await axe(page);
    await page.getByLabel("Student number").fill("S3600001");
    await page.getByRole("button", { name: "Continue" }).click();
    await axe(page);
    await page.getByRole("button", { name: "Create passkey" }).click();
    await page.getByRole("radio", { name: "Ada" }).check();
    await axe(page);
    await page.getByRole("button", { name: "Review my vote" }).click();
    await axe(page);
    await page.getByRole("button", { name: "Cast my vote" }).click();
    await expect(page.getByRole("heading", { name: "Your vote is in" })).toBeVisible();
    await axe(page);
    await request.post(`/api/organiser/polls/${poll.id}/close`);
    await request.post(`/api/organiser/polls/${poll.id}/publish`);
    await page.goto(`/results/${poll.id}`);
    await expect(page.getByText(/recomputed the tally/)).toBeVisible();
    await axe(page);
  });
}
