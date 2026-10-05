import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, placeholders } from "./markdown";
import { Privacy, publicNotice } from "./pages/Privacy";
import { NOTICE, fillNotice } from "./notice-config";

describe("markdown renderer", () => {
  it("renders the supported subset as elements, escaping everything else", () => {
    const html = renderToStaticMarkup(
      <Markdown source={"# Title\n\n## Part\n\nText with **bold**, `code` and [a link](https://example.org/x).\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> **Note.** careful <script>alert(1)</script>"} />,
    );
    expect(html).toContain("<h2>Part</h2>");
    expect(html).not.toContain("Title");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<a href="https://example.org/x" rel="noopener noreferrer">a link</a>');
    expect(html).toContain("<li>two</li>");
    expect(html).toContain('<th scope="row" data-label="A">1</th>');
    expect(html).toContain('<td data-label="B">2</td>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("marks [placeholders] visibly and does not mistake links for them", () => {
    const html = renderToStaticMarkup(<Markdown source={"Contact [email address] or [the site](https://example.org)."} />);
    expect(html).toContain('<mark class="placeholder">[email address]</mark>');
    expect(placeholders("Contact [email address] or [the site](https://example.org) and `[code]`.")).toEqual(["[email address]"]);
  });
});

describe("the privacy notice page", () => {
  const html = renderToStaticMarkup(<Privacy />);

  it("renders the notice, without the maintainer's checklist", () => {
    expect(html).toContain("<h1");
    expect(html).toContain("How long we keep it");
    expect(html).not.toContain("Decisions needed");
    expect(publicNotice).not.toContain("Decisions needed");
  });

  it("states what the code does: erase button, retention, no telemetry on voter pages", () => {
    expect(html).toContain("Erase voter data");
    expect(html).toMatch(/do not run on the voting page or the receipt-check page|do <strong>not<\/strong> run on the voting page/);
  });

  it("shows the society, officer, contact and retention from notice-config.ts, once each in the config", () => {
    expect(html).toContain(NOTICE.society);
    expect(html).toContain(NOTICE.officer);
    expect(html).toContain(`<a href="mailto:${NOTICE.email}"`);
    expect(html).toContain(`erased automatically ${NOTICE.retentionDays} days after`);
    expect(NOTICE.retentionDays).toBe(30);
    expect(html).not.toContain("{{");
    expect(fillNotice("{{unknown}} {{email}}")).toContain("{{unknown}}");
  });

  it("highlights every unfilled placeholder: only the date and the organiser-account retention remain", () => {
    const left = placeholders(publicNotice);
    expect(left.sort()).toEqual(["[2]", "[date]"]); // John's; PRIVACY_STRICT=1 turns these into a failure
    expect((html.match(/class="placeholder"/g) ?? []).length).toBe(left.length);
  });

  // Off by default so CI stays green until the notice is finished. Run `PRIVACY_STRICT=1 npm test -w @noir/web` (and in
  // the deploy workflow once the notice is final) to make an unfilled placeholder fail the build.
  it.skipIf(process.env.PRIVACY_STRICT !== "1")("STRICT: no unfilled [placeholder] and no draft box remain in /privacy", () => {
    expect(placeholders(publicNotice)).toEqual([]);
    expect(html).not.toContain("[");
    expect(html).not.toContain("{{");
    expect(html).not.toContain("DRAFT");
  });
});
