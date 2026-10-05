import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type Env } from "./app";
import { scrubSentryEvent } from "./scrub";
import { makeWorld, newKey, voterSession } from "./test-helpers";
import { runElection } from "./lifecycle";

// Invite codes and student numbers travel in request bodies on the voter routes. Nothing the Worker logs or exports as
// a trace may contain them (ADR 0015).

const OTLP = { GRAFANA_OTLP_ENDPOINT: "https://otlp.example.test/otlp", GRAFANA_OTLP_AUTH: "Basic abc" };
let out: string[];
let exported: unknown[];

beforeEach(() => {
  out = [];
  exported = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    exported.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const secrets = (code: string, number: string) => [code, number, number.toLowerCase()];
const expectClean = (code: string, number: string) => {
  const everything = JSON.stringify({ out, exported });
  for (const s of secrets(code, number)) expect(everything, s).not.toContain(s);
};

describe("logs and trace spans", () => {
  it("never contain the invite code or a student number across the voter routes", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    const env = { ...w.env, ...OTLP } as Env;
    const number = e.voters[0]!.number;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      w.app.request(`/api/vote/${e.pollId}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, env);

    expect((await post("/start", { code: e.invite, studentNumber: number })).status).toBe(200); // success
    expect((await post("/start", { code: e.invite, studentNumber: "S9999999" })).status).toBe(403); // unknown number
    expect((await post("/start", { code: "z".repeat(22), studentNumber: number })).status).toBe(403); // wrong code
    expect((await post("/start", { code: e.invite })).status).toBe(400); // malformed
    expect((await post("/finish", { token: "a.b", response: {} })).status).toBe(403);
    const session = await voterSession(e.pollId, e.voters[0]!.id);
    expect((await post("/cast", { idempotencyKey: newKey(), selections: [{ questionId: e.questionId, optionId: e.options[0]!.id }] }, { authorization: `Bearer ${session}` })).status).toBe(201);

    expect(out.length).toBeGreaterThan(5);
    expect(exported.length).toBeGreaterThan(5);
    expectClean(e.invite, number);
    expectClean("z".repeat(22), "S9999999");
  });

  it("span attributes are only the method, the route pattern and the status", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    await w.app.request(
      `/api/vote/${e.pollId}/start`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: e.invite, studentNumber: e.voters[0]!.number }) },
      { ...w.env, ...OTLP } as Env,
    );
    const spans = exported.flatMap((x) => (x as { resourceSpans: { scopeSpans: { spans: { name: string; attributes: { key: string; value: Record<string, string> }[] }[] }[] }[] }).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.attributes.map((a) => a.key).sort()).toEqual(["http.request.method", "http.response.status_code", "http.route"]);
      expect(s.name).not.toContain(e.pollId); // a pattern, not the concrete path
      expect(s.attributes.find((a) => a.key === "http.route")!.value.stringValue).not.toContain(e.pollId);
    }
  });

  it("an unhandled error on a voter route logs the error class only, not a message that could echo the request", async () => {
    const code = "INVITE-CODE-SHOULD-NOT-APPEAR";
    const number = "S4242424";
    const app = createApp({
      db: () => {
        throw new Error(`database exploded while handling ${code} for ${number}`);
      },
    });
    const res = await app.request(
      "/api/vote/11111111-1111-4111-8111-111111111111/start",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, studentNumber: number }) },
      { DATABASE_URL: "x", BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234", ...OTLP } as Env,
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(number);
    expect(out.some((l) => l.includes('"msg":"unhandled"') && l.includes('"err":"Error"'))).toBe(true);
    expectClean(code, number);
  });
});

describe("error reports", () => {
  it("drop request bodies, query strings, fragments, cookies and credential headers", () => {
    const event = scrubSentryEvent({
      request: {
        url: "https://noir-witness.example/api/vote/abc/start?x=1#code=SECRET",
        data: { code: "SECRET", studentNumber: "S1234567" },
        query_string: "x=1",
        cookies: { a: "b" },
        headers: { Authorization: "Bearer tok", Cookie: "a=b", "User-Agent": "x", "CF-Connecting-IP": "1.2.3.4" },
      },
    });
    expect(event.request).toEqual({ url: "https://noir-witness.example/api/vote/abc/start", headers: { "User-Agent": "x" } });
  });
});
