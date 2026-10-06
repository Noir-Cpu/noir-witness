import { describe, expect, it } from "vitest";
import { account, user } from "@noir/db";
import { createApp, parseAllowedGithubIds, type Env } from "./app";
import { makeWorld, type World } from "./test-helpers";

// ORGANISERS_ALLOWED_GITHUB_IDS (ADR 0018): signed in is not the same as approved.

async function world() {
  const w = await makeWorld();
  // organiser-1 signed in with GitHub account 1001; organiser-2 is called "alice" and holds GitHub account 2002;
  // "mallory" is named like an approved person and has a different GitHub id; "gmail-user" signed in with another provider whose id happens to be 1001.
  await w.db.insert(user).values([
    { id: "mallory", name: "organiser-1", email: "m@example.test" },
    { id: "gmail-user", name: "gmail-user", email: "g@example.test" },
  ]);
  const acc = (id: string, userId: string, accountId: string, providerId = "github") =>
    ({ id, userId, accountId, providerId, updatedAt: new Date() });
  await w.db.insert(account).values([
    acc("a1", "organiser-1", "1001"),
    acc("a2", "organiser-2", "2002"),
    acc("a3", "mallory", "9999"),
    acc("a4", "gmail-user", "1001", "google"),
  ]);
  return w;
}
const withAllowList = (w: World, list: string | undefined) => ({ ...w.env, ORGANISERS_ALLOWED_GITHUB_IDS: list }) as Env;
const create = (w: World, env: Env) =>
  w.app.request("/api/organiser/polls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organisation: "X", title: "T", question: "Q?", options: ["a", "b"] }) }, env);
const list = (w: World, env: Env) => w.app.request("/api/organiser/polls", {}, env);
const me = (w: World, env: Env) => w.app.request("/api/me", {}, env);

describe("parsing", () => {
  it("unset or blank means no allow-list; otherwise only numeric ids count", () => {
    expect(parseAllowedGithubIds(undefined)).toBeNull();
    expect(parseAllowedGithubIds("")).toBeNull();
    expect(parseAllowedGithubIds("   ")).toBeNull();
    expect([...parseAllowedGithubIds(" 1001 , 2002,,x,12ab,-5, 3003 ")!]).toEqual(["1001", "2002", "3003"]);
    expect(parseAllowedGithubIds("alice,bob")!.size).toBe(0); // set but unusable: nobody
  });
});

describe("with no allow-list (today's behaviour)", () => {
  it("any signed-in user can organise", async () => {
    const w = await world();
    for (const env of [withAllowList(w, undefined), withAllowList(w, "")]) {
      for (const id of ["organiser-1", "mallory", "gmail-user"]) {
        w.actAs(id);
        expect((await list(w, env)).status, id).toBe(200);
      }
      w.actAs("organiser-1");
      expect((await create(w, env)).status).toBe(201);
    }
  });
});

describe("with an allow-list", () => {
  it("lets a listed GitHub id organise: create, read, and /me", async () => {
    const w = await world();
    const env = withAllowList(w, "1001, 2002");
    w.actAs("organiser-1");
    expect((await create(w, env)).status).toBe(201);
    expect((await list(w, env)).status).toBe(200);
    expect((await me(w, env)).status).toBe(200);
    w.actAs("organiser-2");
    expect((await create(w, env)).status).toBe(201);
  });

  it("refuses everyone else with a plain 403, on every organiser endpoint, and creates nothing", async () => {
    const w = await world();
    const env = withAllowList(w, "1001");
    w.actAs("organiser-1");
    const created = (await (await create(w, env)).json()) as { id: string };
    w.actAs("organiser-2"); // GitHub id 2002: not listed
    for (const [method, path, body] of [
      ["GET", "/api/organiser/polls"],
      ["POST", "/api/organiser/polls", { organisation: "X", title: "T", question: "Q?", options: ["a", "b"] }],
      ["GET", `/api/organiser/polls/${created.id}`],
      ["POST", `/api/organiser/polls/${created.id}/invite`],
      ["POST", `/api/organiser/polls/${created.id}/close`],
      ["POST", `/api/organiser/polls/${created.id}/voters/reset`, { studentNumber: "S1000000" }],
    ] as const) {
      const res = await w.app.request(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
      expect(res.status, `${method} ${path}`).toBe(403);
      const j = (await res.json()) as { error: string; message: string };
      expect(j.error).toBe("not_approved");
      expect(j.message).toMatch(/only allows approved organisers/);
    }
    const mine = await w.db.query.polls.findMany();
    expect(mine).toHaveLength(1);
    const meRes = await me(w, env);
    expect(meRes.status).toBe(403);
    expect(await meRes.json()).toMatchObject({ user: null, error: "not_approved" });
  });

  it("goes by the GitHub id, not the name: a user called like an approved one, with a different id, is refused", async () => {
    const w = await world();
    const env = withAllowList(w, "1001");
    w.actAs("mallory"); // name "organiser-1" (same as the approved user), GitHub id 9999
    expect((await create(w, env)).status).toBe(403);
    expect((await me(w, env)).status).toBe(403);
  });

  it("goes by GitHub accounts only: the same number under another provider does not count", async () => {
    const w = await world();
    w.actAs("gmail-user");
    expect((await create(w, withAllowList(w, "1001"))).status).toBe(403);
  });

  it("a user with no linked GitHub account at all is refused", async () => {
    const w = await world();
    await w.db.insert(user).values({ id: "ghost", name: "ghost", email: "x@example.test" });
    w.actAs("ghost");
    expect((await list(w, withAllowList(w, "1001"))).status).toBe(403);
  });

  it("fails closed when the variable is set to something with no usable id", async () => {
    const w = await world();
    w.actAs("organiser-1");
    for (const bad of ["alice", "1001x", ",,"]) expect((await list(w, withAllowList(w, bad))).status, bad).toBe(403);
  });

  it("takes effect per request, so removing an id locks that organiser out of an existing session", async () => {
    const w = await world();
    w.actAs("organiser-1");
    expect((await list(w, withAllowList(w, "1001"))).status).toBe(200);
    expect((await list(w, withAllowList(w, "2002"))).status).toBe(403);
  });

  it("does not touch the voter side or the public pages", async () => {
    const w = await world();
    w.actAs(null);
    const env = withAllowList(w, "1001");
    expect((await w.app.request("/api/health", {}, env)).status).toBe(200);
    const res = await w.app.request("/api/polls/11111111-1111-4111-8111-111111111111", {}, env);
    expect(res.status).toBe(404);
    expect(createApp).toBeTypeOf("function");
  });
});
