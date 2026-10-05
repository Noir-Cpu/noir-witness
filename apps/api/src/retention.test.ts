import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, count, eq } from "drizzle-orm";
import { auditEvents, ballots, eligibleVoters, participations, polls, type Db } from "@noir/db";
import { publicKeyOf, verifyBulletin, type Bulletin } from "@noir/bulletin";
import { makeWorld, pollRow, type World } from "./test-helpers";
import { closeAndPublish, runElection, writeTemp } from "./lifecycle";
import { DEFAULT_PURGE_DAYS, purgeDaysFrom, purgeExpired } from "./domain/retention";

const DAY = 86_400_000;
const script = fileURLToPath(new URL("../../../scripts/verify.ts", import.meta.url));
const verifyScript = (file: string, pubkey: string) => spawnSync(process.execPath, [script, file, "--pubkey", pubkey], { encoding: "utf8" });

const n = async (db: Db, table: typeof ballots | typeof participations | typeof eligibleVoters, pollId: string) =>
  ((await db.select({ n: count() }).from(table).where(eq(table.pollId, pollId))) as [{ n: number }])[0].n;
const snapshot = async (db: Db, pollId: string) => {
  const p = await pollRow(db, pollId);
  return { ballots: await n(db, ballots, pollId), participations: await n(db, participations, pollId), voters: await n(db, eligibleVoters, pollId), bulletin: p.bulletin, status: p.status };
};
const erasures = async (db: Db) => db.select().from(auditEvents).where(eq(auditEvents.action, "voter_data.erased"));

describe("organiser: erase voter data", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
  });

  it("erases the identity side of a closed poll and leaves the result verifiable", async () => {
    const e = await runElection(w, { voters: 14, votes: 12 });
    const { text } = await closeAndPublish(w, e.pollId);
    const before = await snapshot(w.db, e.pollId);
    expect(before).toMatchObject({ ballots: 12, participations: 12, voters: 14 });
    const detailBefore = (await (await w.request(`/api/organiser/polls/${e.pollId}`)).json()) as { eligible: number; turnout: number; retention: { erased: boolean; erasesAt: string } };
    expect(detailBefore.retention.erased).toBe(false);
    expect(detailBefore.retention.erasesAt).toBe(new Date(w.clock.now.getTime() + 30 * DAY).toISOString());

    const res = await w.json("POST", `/api/organiser/polls/${e.pollId}/erase-voter-data`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ erasedVoters: 14 });

    const after = await snapshot(w.db, e.pollId);
    expect(after).toEqual({ ...before, participations: 0, voters: 0 }); // ballots and bulletin byte-identical
    expect((await pollRow(w.db, e.pollId)).publishedAt).not.toBeNull();

    // The public bulletin is the same bytes and still passes every check, in the package and in the standalone script.
    const pub = await (await w.request(`/api/polls/${e.pollId}/bulletin`)).text();
    expect(pub).toBe(text);
    const checks = await verifyBulletin(JSON.parse(pub) as Bulletin);
    expect(checks.every((c) => c.ok)).toBe(true);
    const r = verifyScript(writeTemp("bulletin.json", pub), await publicKeyOf(w.key.privateKey));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("VERIFIED");

    // The organiser page still reports the counts the poll closed with, and says the data is gone.
    const detail = (await (await w.request(`/api/organiser/polls/${e.pollId}`)).json()) as typeof detailBefore & { retention: { erasedAt: string | null } };
    expect(detail.eligible).toBe(14);
    expect(detail.turnout).toBe(12);
    expect(detail.retention).toMatchObject({ erased: true, erasesAt: null });
    expect(detail.retention.erasedAt).not.toBeNull();

    // Receipts are still provable from the bulletin alone.
    const { proveReceipt } = await import("@noir/bulletin");
    expect((await proveReceipt(JSON.parse(pub) as Bulletin, e.receipts[0]!.receipt))?.ok).toBe(true);
  });

  it("records the erasure without any voter data, and is idempotent", async () => {
    const e = await runElection(w, { voters: 14, votes: 5 });
    await closeAndPublish(w, e.pollId);
    await w.json("POST", `/api/organiser/polls/${e.pollId}/erase-voter-data`);
    const again = await w.json("POST", `/api/organiser/polls/${e.pollId}/erase-voter-data`);
    expect(await again.json()).toEqual({ erasedVoters: 0 });
    const rows = (await erasures(w.db)).filter((r) => r.pollId === e.pollId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe("organiser-1");
    expect(rows[0]!.detail).toEqual({ voters: 14, trigger: "organiser" });
    const text = JSON.stringify(rows[0]);
    for (const v of e.voters) {
      expect(text).not.toContain(v.id);
      expect(text.toLowerCase()).not.toContain(v.number.toLowerCase());
    }
  });

  it("refuses while the poll is open or a draft, and deletes nothing", async () => {
    const e = await runElection(w, { voters: 14, votes: 3 });
    const before = await snapshot(w.db, e.pollId);
    const res = await w.json("POST", `/api/organiser/polls/${e.pollId}/erase-voter-data`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_closed");
    expect(await snapshot(w.db, e.pollId)).toEqual(before);

    const created = (await (await w.json("POST", "/api/organiser/polls", { organisation: "Dev Society", title: "Draft", question: "Q?", options: ["a", "b"] })).json()) as { id: string };
    expect((await w.json("POST", `/api/organiser/polls/${created.id}/erase-voter-data`)).status).toBe(409);
  });

  it("refuses a closed poll that has no signed bulletin yet", async () => {
    const e = await runElection(w, { voters: 14, votes: 3 });
    await w.db.update(polls).set({ status: "closed", closedAt: w.clock.now }).where(eq(polls.id, e.pollId));
    const before = await snapshot(w.db, e.pollId);
    expect((await w.json("POST", `/api/organiser/polls/${e.pollId}/erase-voter-data`)).status).toBe(409);
    expect(await snapshot(w.db, e.pollId)).toEqual(before);
  });

  it("only the poll's owner can erase", async () => {
    const e = await runElection(w, { voters: 14, votes: 3 });
    await closeAndPublish(w, e.pollId);
    w.actAs("organiser-2");
    try {
      expect((await w.json("POST", `/api/organiser/polls/${e.pollId}/erase-voter-data`)).status).toBe(404);
      w.actAs(null);
      expect((await w.json("POST", `/api/organiser/polls/${e.pollId}/erase-voter-data`)).status).toBe(403);
    } finally {
      w.actAs("organiser-1");
    }
    expect((await snapshot(w.db, e.pollId)).voters).toBe(14);
  });

  it("an erased poll refuses sign-in without leaking anything", async () => {
    const e = await runElection(w, { voters: 14, votes: 3 });
    await closeAndPublish(w, e.pollId);
    await w.json("POST", `/api/organiser/polls/${e.pollId}/erase-voter-data`);
    const res = await w.json("POST", `/api/vote/${e.pollId}/start`, { code: e.invite, studentNumber: e.voters[0]!.number });
    expect(res.status).toBe(403);
  });
});

describe("daily purge", () => {
  const t0 = new Date("2026-01-01T10:00:00Z");
  let w: World;
  const ids: Record<"old" | "oldTwo" | "recent" | "boundary" | "justInside" | "openOld" | "noBulletinOld", string> = {} as never;
  const election = async (label: keyof typeof ids, closedAt: Date | null, opts: { close?: boolean } = {}) => {
    w.clock.now = closedAt ?? t0;
    const e = await runElection(w, { voters: 14, votes: 6 });
    ids[label] = e.pollId;
    if (opts.close !== false && closedAt) await closeAndPublish(w, e.pollId);
  };

  beforeAll(async () => {
    w = await makeWorld();
    await election("old", t0);
    await election("oldTwo", new Date(t0.getTime() + DAY));
    await election("recent", new Date(t0.getTime() + 25 * DAY));
    await election("boundary", new Date(t0.getTime() + 10 * DAY));
    await election("justInside", new Date(t0.getTime() + 10 * DAY + 1000));
    await election("openOld", null); // opened on 2026-01-01 and never closed
    await election("noBulletinOld", null);
    // Closed long ago but the bulletin was never written (a close that failed part-way).
    await w.db.update(polls).set({ status: "closed", closedAt: t0 }).where(eq(polls.id, ids.noBulletinOld));
  });

  const now = new Date(t0.getTime() + 40 * DAY); // boundary was closed exactly 30 days earlier, justInside one second later
  const all = () => Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await snapshot(w.db, id)] as const));

  it("dry run lists exactly the polls that would be erased and writes nothing", async () => {
    const before = await all();
    const r = await purgeExpired(w.db, { now, days: 30, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.polls.map((p) => p.pollId).sort()).toEqual([ids.old, ids.oldTwo, ids.boundary].sort());
    expect(r.polls.every((p) => p.voters === 14)).toBe(true);
    expect(r.erasedVoters).toBe(0);
    expect(await all()).toEqual(before);
    expect(await erasures(w.db)).toHaveLength(0);
  });

  it("erases only closed, signed polls past the cutoff; ballots, bulletins and everything else stay", async () => {
    const before = Object.fromEntries(await all());
    const r = await purgeExpired(w.db, { now, days: 30 });
    expect(r.erasedVoters).toBe(42);
    const after = Object.fromEntries(await all());
    for (const k of ["old", "oldTwo", "boundary"] as const) {
      expect(after[k], k).toEqual({ ...before[k]!, voters: 0, participations: 0 });
      expect(before[k]!.ballots).toBe(6);
    }
    for (const k of ["recent", "justInside", "openOld", "noBulletinOld"] as const) expect(after[k], k).toEqual(before[k]);
    expect(after.openOld!.status).toBe("open");
    expect(after.openOld!.voters).toBe(14);
    expect(after.noBulletinOld!.voters).toBe(14);
    const logged = await erasures(w.db);
    expect(logged).toHaveLength(3);
    expect(logged.every((l) => l.actorUserId === null && (l.detail as { trigger: string }).trigger === "retention")).toBe(true);
  });

  it("erased polls still verify", async () => {
    for (const k of ["old", "oldTwo", "boundary"] as const) {
      const row = await pollRow(w.db, ids[k]);
      const checks = await verifyBulletin(JSON.parse(row.bulletin!) as Bulletin);
      expect(checks.every((c) => c.ok), k).toBe(true);
    }
  });

  it("is idempotent: a second run changes and records nothing", async () => {
    const before = await all();
    const logged = (await erasures(w.db)).length;
    const r = await purgeExpired(w.db, { now, days: 30 });
    expect(r.polls).toEqual([]);
    expect(r.erasedVoters).toBe(0);
    expect(await all()).toEqual(before);
    expect(await erasures(w.db)).toHaveLength(logged);
  });

  it("picks up a poll once it ages past the cutoff, and nothing earlier", async () => {
    const r = await purgeExpired(w.db, { now: new Date(t0.getTime() + 25 * DAY + 30 * DAY), days: 30, dryRun: true });
    expect(r.polls.map((p) => p.pollId).sort()).toEqual([ids.recent, ids.justInside].sort());
  });

  it("never erases an open poll or a poll without a bulletin, even with a very short retention", async () => {
    const r = await purgeExpired(w.db, { now: new Date(t0.getTime() + 1000 * DAY), days: 1 });
    const touched = r.polls.map((p) => p.pollId);
    expect(touched).not.toContain(ids.openOld);
    expect(touched).not.toContain(ids.noBulletinOld);
    expect((await snapshot(w.db, ids.openOld)).voters).toBe(14);
    expect((await snapshot(w.db, ids.noBulletinOld)).voters).toBe(14);
    for (const k of Object.keys(ids) as (keyof typeof ids)[]) expect((await snapshot(w.db, ids[k])).ballots, k).toBe(6);
  });

  it("does not delete a ballot for any voter, and a purged poll's receipts are all still in its bulletin", async () => {
    const row = await pollRow(w.db, ids.old);
    const b = JSON.parse(row.bulletin!) as Bulletin;
    const stored = await w.db.select().from(ballots).where(and(eq(ballots.pollId, ids.old)));
    expect(stored.map((s) => s.receipt).sort()).toEqual(b.ballots.map((x) => x.receipt).sort());
  });
});

describe("PURGE_DAYS", () => {
  it("the wrangler.toml value equals the code default, so the privacy notice's period has one meaning", () => {
    const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
    expect(/PURGE_DAYS = "(\d+)"/.exec(toml)?.[1]).toBe(String(DEFAULT_PURGE_DAYS));
    expect(DEFAULT_PURGE_DAYS).toBe(30);
  });

  it("defaults to 30 and ignores anything that is not a whole number of days of at least 1", () => {
    expect(purgeDaysFrom(undefined)).toBe(DEFAULT_PURGE_DAYS);
    expect(purgeDaysFrom("30")).toBe(30);
    expect(purgeDaysFrom(" 45 ")).toBe(45);
    for (const bad of ["", "0", "00", "-5", "abc", "1.5", "1e3", "99999"]) expect(purgeDaysFrom(bad), bad).toBe(30);
  });
});
