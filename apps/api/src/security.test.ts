import { describe, expect, it } from "vitest";
import { createApp, type Env } from "./app";
import { API_HEADERS } from "./security";
import { closeAndPublish, runElection } from "./lifecycle";
import { makeWorld, newKey, voterSession, AUTH_SECRET, type World } from "./test-helpers";
import { parseRollCsv } from "./domain/roll";
import { deriveSecret, signToken, deriveReceipt } from "./domain/crypto";

const ORIGIN = "http://localhost"; // what app.request() uses for a relative path
const evil = "https://evil.example";

describe("response headers on everything the Worker generates", () => {
  it("every API response carries the security headers, errors and 404s included", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 1 });
    const responses: [string, Response][] = [
      ["health", await w.request("/api/health")],
      ["unknown route", await w.request("/api/nope")],
      ["bad uuid", await w.request("/api/polls/not-a-uuid")],
      ["public poll", await w.request(`/api/polls/${e.pollId}`)],
      ["organiser list", await w.request("/api/organiser/polls")],
      ["organiser 403", await (async () => (w.actAs(null), w.request("/api/organiser/polls")))()],
      ["vote start, wrong code", await w.json("POST", `/api/vote/${e.pollId}/start`, { code: "x".repeat(22), studentNumber: "S1" })],
      ["vote ballot, no session", await w.request(`/api/vote/${e.pollId}/ballot`)],
      ["signing key", await w.request("/api/signing-key")],
    ];
    w.actAs("organiser-1");
    for (const [name, res] of responses) {
      for (const [k, v] of Object.entries(API_HEADERS)) expect(res.headers.get(k), `${name}: ${k}`).toBe(v);
      expect(res.headers.get("cache-control"), name).toBe("no-store");
    }
  });

  it("the policy is as strict as the brief asks", () => {
    const csp = API_HEADERS["content-security-policy"]!;
    for (const d of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) expect(csp).toContain(d);
    expect(API_HEADERS["strict-transport-security"]).toMatch(/max-age=\d{7,}/);
    expect(API_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(API_HEADERS["referrer-policy"]).toBe("no-referrer");
    expect(API_HEADERS["permissions-policy"]).toContain("publickey-credentials-get=(self)");
    expect(API_HEADERS["permissions-policy"]).toContain("publickey-credentials-create=(self)");
    expect(API_HEADERS["cross-origin-opener-policy"]).toBe("same-origin");
    expect(API_HEADERS["cross-origin-resource-policy"]).toBe("same-origin");
    expect(API_HEADERS["x-robots-tag"]).toContain("noindex");
  });

  it("voter and organiser responses are never cacheable, and the published bulletin keeps its short public cache", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 3 });
    const session = await voterSession(e.pollId, e.voters[8]!.id);
    for (const res of [
      await w.request(`/api/vote/${e.pollId}/ballot`, { headers: { authorization: `Bearer ${session}` } }),
      await w.json("POST", `/api/vote/${e.pollId}/start`, { code: e.invite, studentNumber: e.voters[0]!.number }),
      await w.request(`/api/organiser/polls/${e.pollId}`),
      await w.json("POST", `/api/organiser/polls/${e.pollId}/invite`),
    ]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    await closeAndPublish(w, e.pollId);
    const pub = await w.request(`/api/polls/${e.pollId}/bulletin`);
    expect(pub.headers.get("cache-control")).toBe("public, max-age=60");
    expect(pub.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("repairs a response whose headers are read-only instead of failing", async () => {
    const app = createApp({ db: undefined });
    app.get("/ro", () => Response.redirect("http://localhost/x", 302)); // Response.redirect() headers are immutable
    const res = await app.request("/api/ro");
    expect(res.status).toBe(302);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("CORS: none", () => {
  it("sends no Access-Control headers to a foreign origin, and a preflight gets nothing useful", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    for (const path of ["/api/health", `/api/polls/${e.pollId}`, "/api/organiser/polls", "/api/me", "/api/signing-key"]) {
      const res = await w.request(path, { headers: { origin: evil } });
      expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-")), path).toEqual([]);
    }
    for (const path of ["/api/organiser/polls", `/api/vote/${e.pollId}/start`, "/api/health"]) {
      const pre = await w.request(path, {
        method: "OPTIONS",
        headers: { origin: evil, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" },
      });
      expect(pre.status, path).toBeGreaterThanOrEqual(400);
      expect(pre.headers.get("access-control-allow-origin"), path).toBeNull();
    }
  });
});

describe("CSRF on organiser writes", () => {
  const writes = (id: string): [string, string, unknown?][] => [
    ["POST", "/api/organiser/polls", { organisation: "X", title: "T", question: "Q?", options: ["a", "b"] }],
    ["PATCH", `/api/organiser/polls/${id}`, { title: "Hijacked" }],
    ["POST", `/api/organiser/polls/${id}/invite`],
    ["POST", `/api/organiser/polls/${id}/open`],
    ["POST", `/api/organiser/polls/${id}/close`],
    ["POST", `/api/organiser/polls/${id}/publish`],
    ["POST", `/api/organiser/polls/${id}/erase-voter-data`],
    ["POST", `/api/organiser/polls/${id}/voters/reset`, { studentNumber: "S1000000" }],
  ];
  const send = (w: World, [method, path, body]: [string, string, unknown?], headers: Record<string, string | undefined>) =>
    w.request(path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } as Record<string, string>, body: body === undefined ? undefined : JSON.stringify(body) });

  it("refuses every write that the browser says came from another origin or site, and changes nothing", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    for (const wr of writes(e.pollId)) {
      for (const headers of [{ origin: evil }, { origin: "null" }, { "sec-fetch-site": "cross-site", origin: evil }, { "sec-fetch-site": "same-site" }]) {
        const res = await send(w, wr, headers);
        expect(res.status, `${wr[0]} ${wr[1]} ${JSON.stringify(headers)}`).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe("cross_site");
      }
    }
    const detail = (await (await w.request(`/api/organiser/polls/${e.pollId}`)).json()) as { title: string; status: string };
    expect(detail).toMatchObject({ title: "Chair 2026", status: "open" });
  });

  it("allows the same origin, and non-browser clients that send neither header", async () => {
    const w = await makeWorld();
    const body = { organisation: "X", title: "T", question: "Q?", options: ["a", "b"] };
    expect((await send(w, ["POST", "/api/organiser/polls", body], { origin: ORIGIN, "sec-fetch-site": "same-origin" })).status).toBe(201);
    expect((await send(w, ["POST", "/api/organiser/polls", body], {})).status).toBe(201);
  });

  it("honours the configured public URL as the one allowed origin", async () => {
    const w = await makeWorld();
    const env = { ...w.env, BETTER_AUTH_URL: "https://witness.example.org" } as Env;
    const post = (origin: string) =>
      w.app.request("/api/organiser/polls", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ organisation: "X", title: "T", question: "Q?", options: ["a", "b"] }) }, env);
    expect((await post("https://witness.example.org")).status).toBe(201);
    expect((await post(ORIGIN)).status).toBe(403);
  });

  it("reads are not affected, and a form-style content type cannot carry a write", async () => {
    const w = await makeWorld();
    expect((await w.request("/api/organiser/polls", { headers: { origin: evil } })).status).toBe(200); // a read: cross-site pages cannot read the reply (no CORS)
    const res = await w.request("/api/organiser/polls", { method: "POST", headers: { "content-type": "text/plain" }, body: '{"organisation":"X"}' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_content_type");
    const form = await w.request("/api/organiser/polls", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=b" });
    expect(form.status).toBe(400);
  });

  it("sign-in endpoints refuse a cross-site POST too, but still accept the app's own", async () => {
    const w = await makeWorld();
    const post = (headers: Record<string, string>) =>
      w.request("/api/auth/sign-in/social", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ provider: "github", callbackURL: "https://evil.example/x" }) });
    expect((await post({ origin: evil })).status).toBe(403);
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ origin: ORIGIN, "sec-fetch-site": "same-origin" })).status).not.toBe(403);
    expect((await w.request("/api/auth/ok", { headers: { origin: evil } })).status).toBe(200); // reads (and the GitHub callback) pass
  });

  it("a write with no body (open, close, publish) still works without a content type", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 1 });
    expect((await w.request(`/api/organiser/polls/${e.pollId}/close`, { method: "POST" })).status).toBe(200);
  });
});

describe("input size limits", () => {
  it("rejects an oversized JSON body on voter and organiser routes with 413, before parsing it", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    const big = JSON.stringify({ code: "a".repeat(200_000), studentNumber: "S1" });
    const res = await w.request(`/api/vote/${e.pollId}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large", message: "The request is too large" });
    const org = await w.request("/api/organiser/polls", { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(org.status).toBe(413);
  });

  it("enforces the limit while reading even when Content-Length is absent (chunked upload)", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    const chunk = new TextEncoder().encode("a".repeat(16 * 1024));
    const stream = () =>
      new ReadableStream({
        pull(c) {
          c.enqueue(chunk);
        },
      });
    const res = await w.app.request(
      `/api/vote/${e.pollId}/start`,
      { method: "POST", headers: { "content-type": "application/json" }, body: stream(), duplex: "half" } as RequestInit,
      w.env,
    );
    expect(res.status).toBe(413);
  });

  it("caps the roll upload (a huge file is refused with 413 and nothing is stored)", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    const create = await w.json("POST", "/api/organiser/polls", { organisation: "Y", title: "Fresh", question: "Q?", options: ["a", "b"] });
    const { id } = (await create.json()) as { id: string };
    const huge = "S1000000\n".repeat(200_000); // about 1.8 MB
    const res = await w.request(`/api/organiser/polls/${id}/roll`, { method: "PUT", headers: { "content-type": "text/csv" }, body: huge });
    expect(res.status).toBe(413);
    const ok = await w.request(`/api/organiser/polls/${id}/roll`, { method: "PUT", headers: { "content-type": "text/csv" }, body: "S1000000\nS1000001\n" });
    expect(ok.status).toBe(200);
    expect(e.pollId).toBeTruthy();
  });

  it("refuses more than 5,000 distinct numbers and a file with a hostile line, with a plain message", async () => {
    const w = await makeWorld();
    const { id } = (await (await w.json("POST", "/api/organiser/polls", { organisation: "Y", title: "Big", question: "Q?", options: ["a", "b"] })).json()) as { id: string };
    const many = Array.from({ length: 5001 }, (_, i) => `S${1000000 + i}`).join("\n"); // about 45 KB: under the byte cap, over the row cap
    const res = await w.request(`/api/organiser/polls/${id}/roll`, { method: "PUT", headers: { "content-type": "text/csv" }, body: many });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("roll_too_large");
    const bad = await w.request(`/api/organiser/polls/${id}/roll`, { method: "PUT", headers: { "content-type": "text/csv" }, body: "S1000000\n=HYPERLINK(\"http://evil\")\n" });
    expect(bad.status).toBe(400);
  });
});

describe("CSV formula injection", () => {
  it("the roll only admits plain student numbers, so no cell can start a spreadsheet formula", () => {
    const hostile = ["=cmd|' /C calc'!A0", "+1+1", "-2+3", "@SUM(1,1)", "\t=1+1", "\r=1+1", "=HYPERLINK(\"http://evil\")", "'=1", "S123,=1+1"];
    for (const h of hostile) {
      const r = parseRollCsv(`Student number\n${h}\n`);
      for (const n of r.numbers) expect(n, h).toMatch(/^[A-Z0-9][A-Z0-9-]{2,19}$/);
      expect(r.numbers.some((n) => /^[=+\-@]/.test(n)), h).toBe(false);
    }
    expect(parseRollCsv("=1+1\n+1\n-2\n@x\n").invalid.length).toBe(4);
  });

  it("no endpoint returns CSV (there is no roll or results export), so there is nothing to inject into", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 2 });
    await closeAndPublish(w, e.pollId);
    for (const path of [`/api/organiser/polls/${e.pollId}`, `/api/organiser/polls/${e.pollId}/bulletin`, `/api/polls/${e.pollId}/bulletin`, `/api/polls/${e.pollId}`]) {
      const res = await w.request(path);
      expect(res.headers.get("content-type"), path).toMatch(/^application\/json/);
    }
  });
});

describe("error responses do not leak internals", () => {
  it("an unexpected failure returns a generic message: no stack, no connection string, no SQL", async () => {
    const secret = "postgres://admin:hunter2@ep-secret.neon.tech/db";
    const app = createApp({
      db: () => {
        throw new Error(`could not connect to ${secret} select * from eligible_voters`);
      },
    });
    const env = { DATABASE_URL: "x", BETTER_AUTH_SECRET: AUTH_SECRET } as Env;
    for (const [method, path, body] of [
      ["GET", "/api/polls/11111111-1111-4111-8111-111111111111"],
      ["POST", "/api/vote/11111111-1111-4111-8111-111111111111/start", { code: "c".repeat(22), studentNumber: "S1" }],
    ] as const) {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: "internal", message: "Something went wrong" });
      expect(text).not.toMatch(/hunter2|neon|postgres|select|at \w+ \(|\.ts:/i);
    }
  });

  it("a malformed id in an organiser path is a 404, not a 500", async () => {
    const w = await makeWorld();
    for (const path of ["/api/organiser/polls/not-a-uuid", "/api/organiser/polls/not-a-uuid/bulletin", "/api/organiser/polls/%00"]) {
      const res = await w.request(path);
      expect(res.status, path).toBe(404);
    }
  });

  it("malformed JSON and wrong shapes are 400 with no echo of the input", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    const bad = await w.request(`/api/vote/${e.pollId}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"code": "SECRETCODE12345", ' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("SECRETCODE12345");
    const wrong = await w.json("POST", `/api/vote/${e.pollId}/start`, { code: "SECRETCODE12345", studentNumber: 42 });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).not.toContain("SECRETCODE12345");
  });
});

describe("enumeration resistance on sign-in", () => {
  it("a student on the roll, one off it and a wrong code are indistinguishable without the code", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    const attempts = [
      { code: "w".repeat(22), studentNumber: e.voters[0]!.number },
      { code: "w".repeat(22), studentNumber: "S0000001" },
      { code: e.invite, studentNumber: "S0000001" },
    ];
    const seen = [];
    for (const a of attempts) {
      const res = await w.json("POST", `/api/vote/${e.pollId}/start`, a);
      seen.push({ status: res.status, body: await res.json(), cache: res.headers.get("cache-control"), type: res.headers.get("content-type") });
    }
    expect(new Set(seen.map((s) => JSON.stringify(s))).size).toBe(1);
  });

  it("the invite code and the session MAC are compared in constant time (code reads: timingSafeEqualHex only)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./domain/voter-auth.ts", import.meta.url), "utf8") + readFileSync(new URL("./domain/crypto.ts", import.meta.url), "utf8");
    expect(src).toContain("timingSafeEqualHex");
    // No ordinary equality between a computed hash/MAC and the stored or supplied value.
    expect(src).not.toMatch(/inviteHash\s*[!=]==/);
    expect(src).not.toMatch(/\bmac\s*[!=]==/);
  });
});

describe("voter tokens", () => {
  it("a challenge token is not a session, and a session is not a challenge (no fixation by swapping kinds)", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    const secret = await deriveSecret(AUTH_SECRET, "voter-token-v1");
    const challenge = await signToken(secret, { k: "challenge", v: e.voters[0]!.id, p: e.pollId, c: "x", m: "authenticate", exp: Date.now() + 60_000 });
    const asSession = await w.request(`/api/vote/${e.pollId}/ballot`, { headers: { authorization: `Bearer ${challenge}` } });
    expect(asSession.status).toBe(403);
    const session = await voterSession(e.pollId, e.voters[0]!.id);
    const asChallenge = await w.json("POST", `/api/vote/${e.pollId}/finish`, { token: session, response: {} });
    expect(asChallenge.status).toBe(403);
  });

  it("a session minted for one voter or poll cannot be used for another, and a token signed with another key is refused", async () => {
    const w = await makeWorld();
    const a = await runElection(w, { voters: 12, votes: 0 });
    const b = await runElection(w, { voters: 12, votes: 0 });
    const sessionA = await voterSession(a.pollId, a.voters[0]!.id);
    expect((await w.request(`/api/vote/${b.pollId}/ballot`, { headers: { authorization: `Bearer ${sessionA}` } })).status).toBe(403);
    const forged = await signToken("another-secret-another-secret-1234567", { k: "session", v: a.voters[0]!.id, p: a.pollId, exp: Date.now() + 60_000 });
    expect((await w.request(`/api/vote/${a.pollId}/ballot`, { headers: { authorization: `Bearer ${forged}` } })).status).toBe(403);
    // Voter id of poll B inside a token for poll A: the cast statement only accepts a voter that belongs to the poll.
    const crossVoter = await voterSession(a.pollId, b.voters[0]!.id);
    const res = await w.request(`/api/vote/${a.pollId}/cast`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${crossVoter}` },
      body: JSON.stringify({ idempotencyKey: newKey(), selections: [{ questionId: a.questionId, optionId: a.options[0]!.id }] }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_open");
  });
});

describe("idempotency keys and receipts", () => {
  const cast = (w: World, e: Awaited<ReturnType<typeof runElection>>, voter: number, key: string) =>
    voterSession(e.pollId, e.voters[voter]!.id).then((s) =>
      w.request(`/api/vote/${e.pollId}/cast`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s}` },
        body: JSON.stringify({ idempotencyKey: key, selections: [{ questionId: e.questionId, optionId: e.options[0]!.id }] }),
      }),
    );

  it("another voter replaying someone's key gets no receipt and no ballot, and can still vote with their own key", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    const key = newKey();
    const mine = await cast(w, e, 0, key);
    expect(mine.status).toBe(201);
    const receipt = ((await mine.json()) as { receipt: string }).receipt;
    const stolen = await cast(w, e, 1, key);
    expect(stolen.status).toBe(409);
    const body = await stolen.text();
    expect(body).not.toContain(receipt);
    // The refused attempt left no participation: voter 1 is still free to vote.
    const own = await cast(w, e, 1, newKey());
    expect(own.status).toBe(201);
    // The original voter's retry still returns the original receipt.
    const retry = await cast(w, e, 0, key);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { receipt: string }).receipt).toBe(receipt);
  });

  it("the same key in two polls gives two unrelated receipts, and receipts are 128-bit hex", async () => {
    const w = await makeWorld();
    const a = await runElection(w, { voters: 12, votes: 0 });
    const b = await runElection(w, { voters: 12, votes: 0 });
    const key = newKey();
    const ra = ((await (await cast(w, a, 0, key)).json()) as { receipt: string }).receipt;
    const rb = ((await (await cast(w, b, 0, key)).json()) as { receipt: string }).receipt;
    expect(ra).toMatch(/^[0-9a-f]{32}$/);
    expect(rb).toMatch(/^[0-9a-f]{32}$/);
    expect(ra).not.toBe(rb);
  });

  it("the receipt is an HMAC under a per-poll secret: not computable from the key alone, and unrelated to the voter", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 0 });
    const key = newKey();
    const receipt = ((await (await cast(w, e, 0, key)).json()) as { receipt: string }).receipt;
    const poll = await w.db.query.polls.findFirst({ where: (p, { eq }) => eq(p.id, e.pollId) });
    expect(await deriveReceipt(poll!.receiptKey, key)).toBe(receipt);
    const { sha256Hex } = await import("./domain/crypto");
    for (const guess of [await sha256Hex(key), await sha256Hex(`receipt:${key}`), await sha256Hex(e.voters[0]!.id), await sha256Hex(e.voters[0]!.number)]) {
      expect(guess.slice(0, 32)).not.toBe(receipt);
    }
    expect(poll!.receiptKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("what the public endpoints expose", () => {
  it("the public poll record is exactly id, title, description, status and published", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 2 });
    const body = (await (await w.request(`/api/polls/${e.pollId}`)).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["description", "id", "published", "status", "title"]);
  });

  it("the published bulletin has exactly the intended fields and no secret, hash, salt, key or voter data", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 4 });
    const { text, bulletin } = await closeAndPublish(w, e.pollId);
    expect(Object.keys(bulletin).sort()).toEqual(["ballotCount", "ballots", "closedAt", "eligibleCount", "merkleRoot", "participationCount", "poll", "publicKey", "signature", "tally", "version"]);
    expect(Object.keys(bulletin.poll).sort()).toEqual(["id", "questions", "title"]);
    const poll = await w.db.query.polls.findFirst({ where: (p, { eq }) => eq(p.id, e.pollId) });
    for (const secret of [poll!.receiptKey, poll!.rollSalt, poll!.inviteHash ?? "never", e.invite, AUTH_SECRET, w.key.privateKey]) expect(text).not.toContain(secret);
  });

  it("the organiser views and the public poll never include the invite hash, roll salt or receipt key", async () => {
    const w = await makeWorld();
    const e = await runElection(w, { voters: 12, votes: 2 });
    const poll = await w.db.query.polls.findFirst({ where: (p, { eq }) => eq(p.id, e.pollId) });
    for (const path of [`/api/organiser/polls/${e.pollId}`, "/api/organiser/polls", `/api/polls/${e.pollId}`, "/api/me"]) {
      const text = await (await w.request(path)).text();
      for (const secret of [poll!.receiptKey, poll!.rollSalt, poll!.inviteHash!]) expect(text, path).not.toContain(secret);
    }
  });
});
