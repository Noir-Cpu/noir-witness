import { describe, expect, it } from "vitest";
import { isPrivatePath, scrubBreadcrumb, scrubCapture, scrubEvent, stripUrl } from "./scrub";

describe("isPrivatePath", () => {
  it("is true for voter and receipt-check pages only", () => {
    for (const p of ["/vote/11111111-1111-4111-8111-111111111111", "/vote/x", "/vote", "/verify", "/verify/"]) expect(isPrivatePath(p), p).toBe(true);
    for (const p of ["/", "/organiser", "/organiser/polls/1", "/results/1", "/privacy", "/voter", "/verification", "/votes"]) expect(isPrivatePath(p), p).toBe(false);
  });
});

describe("stripUrl", () => {
  it("removes query strings and fragments", () => {
    expect(stripUrl("https://x.test/vote/1#code=SECRET")).toBe("https://x.test/vote/1");
    expect(stripUrl("https://x.test/verify?poll=1&receipt=abc")).toBe("https://x.test/verify");
    expect(stripUrl("/a?b#c")).toBe("/a");
    expect(stripUrl("https://x.test/plain")).toBe("https://x.test/plain");
    expect(stripUrl(undefined)).toBeUndefined();
  });
});

describe("scrubEvent (Sentry)", () => {
  it("strips fragments and query strings everywhere a URL can appear", () => {
    const e = scrubEvent({
      request: { url: "https://x.test/organiser?token=1#frag", query_string: "token=1", cookies: { a: "b" }, headers: { Referer: "https://x.test/vote/1#code=SECRET", "User-Agent": "ua" } },
      transaction: "/results/1?x=1",
      breadcrumbs: [
        { category: "navigation", data: { from: "/vote/1#code=SECRET", to: "/organiser?a=1" } },
        { category: "fetch", data: { url: "/api/polls/1?x=2", method: "GET" } },
      ],
      exception: { values: [{ stacktrace: { frames: [{ filename: "https://x.test/assets/a.js?v=1#x", abs_path: "https://x.test/assets/a.js#y" }] } }] },
    });
    const text = JSON.stringify(e);
    expect(text).not.toMatch(/SECRET|#|\?/);
    expect(e.request).toEqual({ url: "https://x.test/organiser", headers: { "User-Agent": "ua" } });
  });

  it("scrubs a breadcrumb on its own", () => {
    expect(scrubBreadcrumb({ data: { url: "/a#b" } })).toEqual({ data: { url: "/a" } });
  });
});

describe("scrubCapture (PostHog)", () => {
  it("strips the URL properties PostHog adds", () => {
    const c = scrubCapture({ properties: { $current_url: "https://x.test/#code=SECRET", $referrer: "https://x.test/verify?receipt=r", $pathname: "/", other: "kept" } });
    expect(c!.properties).toEqual({ $current_url: "https://x.test/", $referrer: "https://x.test/verify", $pathname: "/", other: "kept" });
    expect(scrubCapture(null)).toBeNull();
  });
});
