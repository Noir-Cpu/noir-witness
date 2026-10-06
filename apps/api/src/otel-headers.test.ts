import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { tracing } from "./otel";

describe("tracing middleware and read-only response headers", () => {
  it("adds x-request-id to ordinary responses", async () => {
    const app = new Hono().use("*", tracing()).get("/ok", (c) => c.json({ ok: true }));
    const res = await app.request("/ok");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does not fail when a handler returns a response with read-only headers (e.g. from a Durable Object stub)", async () => {
    // Response.redirect() returns immutable headers, like a response returned by fetch() inside a Worker.
    const app = new Hono().use("*", tracing()).get("/ro", () => Response.redirect("http://example.com/", 302));
    const res = await app.request("/ro");
    expect(res.status).toBe(302);
  });
});
