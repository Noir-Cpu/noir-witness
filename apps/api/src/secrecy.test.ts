import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { rowsOf, auditEvents } from "@noir/db";
import { sql } from "drizzle-orm";
import { makeWorld, type World } from "./test-helpers";
import { closeAndPublish, runElection } from "./lifecycle";

// ADR 0003 and 0005: nothing stored or published links a participation to a ballot.
let w: World;
let e: Awaited<ReturnType<typeof runElection>>;
let published: Awaited<ReturnType<typeof closeAndPublish>>;

beforeAll(async () => {
  w = await makeWorld();
  e = await runElection(w, { voters: 30, votes: 25 });
  published = await closeAndPublish(w, e.pollId);
});

const columns = async (table: string) =>
  rowsOf<{ column_name: string; data_type: string }>(
    await w.db.execute(sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ${table} ORDER BY ordinal_position`),
  );

describe("schema", () => {
  it("ballots hold only poll, receipt and selections: no voter, no time, no sequence", async () => {
    const cols = await columns("ballots");
    expect(cols.map((c) => c.column_name)).toEqual(["poll_id", "receipt", "selections"]);
    expect(cols.some((c) => /timestamp|date|time|serial|integer|bigint/.test(c.data_type))).toBe(false);
  });

  it("participations hold only poll, voter and an hour bucket", async () => {
    expect((await columns("participations")).map((c) => c.column_name)).toEqual(["poll_id", "voter_id", "hour_bucket"]);
  });

  it("the only column the two tables share is poll_id", async () => {
    const a = (await columns("ballots")).map((c) => c.column_name);
    const b = (await columns("participations")).map((c) => c.column_name);
    expect(a.filter((x) => b.includes(x))).toEqual(["poll_id"]);
  });

  it("ballots reference only polls; nothing references ballots", async () => {
    const fks = rowsOf<{ from_table: string; to_table: string }>(
      await w.db.execute(sql`
        SELECT c.conrelid::regclass::text AS from_table, c.confrelid::regclass::text AS to_table
        FROM pg_constraint c WHERE c.contype = 'f'`),
    );
    expect(fks.filter((f) => f.from_table === "ballots").map((f) => f.to_table)).toEqual(["polls"]);
    expect(fks.filter((f) => f.to_table === "ballots")).toEqual([]);
    expect(fks.filter((f) => f.from_table === "participations").map((f) => f.to_table).sort()).toEqual(["eligible_voters", "polls"]);
  });

  it("eligible voters carry no timestamps", async () => {
    expect((await columns("eligible_voters")).some((c) => /timestamp|date/.test(c.data_type))).toBe(false);
  });
});

describe("stored data", () => {
  it("participation times are bucketed to the hour", async () => {
    const rows = rowsOf<{ off: number }>(
      await w.db.execute(sql`SELECT (extract(minute from hour_bucket) + extract(second from hour_bucket) + extract(milliseconds from hour_bucket))::float AS off FROM participations`),
    );
    expect(rows.length).toBe(25);
    expect(rows.every((r) => r.off === 0)).toBe(true);
  });

  it("no receipt is derivable from a voter id or student number by a plain hash", async () => {
    const { createHash } = await import("node:crypto");
    const receipts = new Set(e.receipts.map((r) => r.receipt));
    for (const v of e.voters) {
      for (const cand of [v.id, v.number, v.id.replace(/-/g, "")]) {
        for (const alg of ["md5", "sha1", "sha256"]) expect(receipts.has(createHash(alg).update(cand).digest("hex").slice(0, 32))).toBe(false);
      }
    }
  });

  it("the audit log holds organiser actions only", async () => {
    const rows = await w.db.select().from(auditEvents).where(eq(auditEvents.pollId, e.pollId));
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(["poll.created", "roll.uploaded", "invite.rotated", "poll.opened", "poll.closed", "poll.published"]));
    const text = JSON.stringify(rows);
    for (const v of e.voters) expect(text).not.toContain(v.id);
  });
});

describe("published bulletin", () => {
  it("lists ballots sorted by receipt, not in the order they were cast", () => {
    const listed = published.bulletin.ballots.map((b) => b.receipt);
    expect(listed).toEqual([...listed].sort());
    const castOrder = e.receipts.map((r) => r.receipt);
    expect(listed).not.toEqual(castOrder); // 25 ballots: a coincidence has probability 1/25!
  });

  it("each ballot carries only a receipt and selections", () => {
    for (const b of published.bulletin.ballots) expect(Object.keys(b).sort()).toEqual(["receipt", "selections"]);
  });

  it("contains no voter id, student number, student hash or hour bucket", async () => {
    const rows = rowsOf<{ student_hash: string }>(await w.db.execute(sql`SELECT student_hash FROM eligible_voters`));
    for (const v of e.voters) {
      expect(published.text).not.toContain(v.id);
      expect(published.text).not.toContain(v.number);
    }
    for (const r of rows) expect(published.text).not.toContain(r.student_hash);
    expect(published.text).not.toMatch(/hour_?bucket/i);
    // The only time in the file is the organiser's close time.
    expect(Object.keys(published.bulletin).filter((k) => /time|at$/i.test(k))).toEqual(["closedAt"]);
  });

  it("the cast response and the organiser view reveal no per-voter link", async () => {
    const detail = JSON.stringify(await (await w.request(`/api/organiser/polls/${e.pollId}`)).json());
    for (const r of e.receipts) expect(detail).not.toContain(r.receipt);
    for (const v of e.voters) expect(detail).not.toContain(v.id);
  });

  it("nothing is public before the organiser publishes", async () => {
    const e2 = await runElection(w, { voters: 12, votes: 2 });
    expect((await w.request(`/api/polls/${e2.pollId}/bulletin`)).status).toBe(404);
    await w.json("POST", `/api/organiser/polls/${e2.pollId}/close`);
    expect((await w.request(`/api/polls/${e2.pollId}/bulletin`)).status).toBe(404);
    const pub = JSON.stringify(await (await w.request(`/api/polls/${e2.pollId}`)).json());
    expect(pub).not.toMatch(/tally|ballot|merkle/i);
  });
});
