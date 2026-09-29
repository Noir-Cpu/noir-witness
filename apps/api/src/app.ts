import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { createDb, participations, polls, type Db } from "@noir/db";
import { publicKeyOf, type Selection } from "@noir/bulletin";
import { and, eq } from "drizzle-orm";
import { tracing, type OtelEnv } from "./otel";
import { createAuth, type AuthEnv } from "./auth";
import { castBallot, loadBulletinPoll } from "./domain/cast";
import { deriveSecret } from "./domain/crypto";
import {
  DomainError, addOption, closePoll, createPoll, listPolls, openPoll, pollDetail, publishPoll, removeOption,
  resetVoterPasskey, rotateInvite, updatePoll, uploadRoll,
} from "./domain/polls";
import { beginVoterAuth, finishVoterAuth, readSession, type WebAuthnConfig } from "./domain/voter-auth";

export type Env = AuthEnv & OtelEnv & { SENTRY_DSN_API?: string; SIGNING_KEY?: string };
export type Organiser = { id: string; name: string };

export type Deps = {
  db?: Db | ((env: Env) => Db);
  organiser?: (c: Context<{ Bindings: Env }>, db: Db) => Promise<Organiser | null>;
  now?: () => Date;
};

const uuid = z.string().uuid();

export function createApp(deps: Deps = {}) {
  const app = new Hono<{ Bindings: Env }>().basePath("/api");
  const now = deps.now ?? (() => new Date());
  const getDb = (env: Env): Db => (typeof deps.db === "function" ? deps.db(env) : (deps.db ?? createDb(env.DATABASE_URL)));

  const getOrganiser = async (c: Context<{ Bindings: Env }>): Promise<Organiser | null> => {
    const db = getDb(c.env);
    if (deps.organiser) return deps.organiser(c, db);
    const session = await createAuth(c.env, c.req.url, db).api.getSession({ headers: c.req.raw.headers });
    return session ? { id: session.user.id, name: session.user.name } : null;
  };

  const requireOrganiser = async (c: Context<{ Bindings: Env }>) => {
    const o = await getOrganiser(c);
    if (!o) throw new DomainError("unauthenticated", "Sign in as an organiser", 403);
    // Cookie-authenticated writes must be JSON or CSV, which a cross-site form cannot send without a preflight.
    if (c.req.method !== "GET") {
      const ct = c.req.header("content-type") ?? "";
      if (!/^(application\/json|text\/csv)/.test(ct) && c.req.header("content-length") !== "0" && c.req.header("content-length") !== undefined) {
        throw new DomainError("bad_content_type", "Unsupported content type", 400);
      }
    }
    return { organiser: o, db: getDb(c.env) };
  };

  const signingKey = (c: Context<{ Bindings: Env }>) => {
    if (!c.env.SIGNING_KEY) throw new Error("SIGNING_KEY is not configured");
    return c.env.SIGNING_KEY;
  };
  const voterSecret = (c: Context<{ Bindings: Env }>) => deriveSecret(c.env.BETTER_AUTH_SECRET, "voter-token-v1");
  const webauthn = (c: Context<{ Bindings: Env }>): WebAuthnConfig => {
    const origin = new URL(c.env.BETTER_AUTH_URL ?? c.req.url).origin;
    return { origin, rpID: new URL(origin).hostname, rpName: "WITNESS" };
  };

  app.use("*", tracing());

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.code, message: err.message }, err.status);
    if ("getResponse" in err && typeof err.getResponse === "function") return (err as { getResponse(): Response }).getResponse();
    console.error(JSON.stringify({ level: "error", msg: "unhandled", err: String(err) }));
    return c.json({ error: "internal", message: "Something went wrong" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/health/db", async (c) => {
    const started = Date.now();
    try {
      await getDb(c.env).execute(sql`select 1`);
      return c.json({ ok: true, ms: Date.now() - started });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.on(["GET", "POST"], "/auth/*", (c) => createAuth(c.env, c.req.url, getDb(c.env)).handler(c.req.raw));

  app.get("/me", async (c) => {
    const o = await getOrganiser(c);
    return o ? c.json({ user: o }) : c.json({ user: null }, 401);
  });

  // ---- Organiser ----------------------------------------------------------------------------------------------

  const org = new Hono<{ Bindings: Env }>();

  org.get("/polls", async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    return c.json({ polls: await listPolls(db, organiser.id) });
  });

  org.post(
    "/polls",
    zValidator("json", z.object({
      organisation: z.string().trim().min(1).max(80),
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().max(1000).default(""),
      question: z.string().trim().min(1).max(200),
      options: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
    })),
    async (c) => {
      const { organiser, db } = await requireOrganiser(c);
      const poll = await createPoll(db, organiser.id, c.req.valid("json"));
      return c.json({ id: poll.id }, 201);
    },
  );

  org.get("/polls/:id", async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    return c.json(await pollDetail(db, organiser.id, uuid.parse(c.req.param("id"))));
  });

  org.patch(
    "/polls/:id",
    zValidator("json", z.object({ title: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(1000).optional() })),
    async (c) => {
      const { organiser, db } = await requireOrganiser(c);
      await updatePoll(db, organiser.id, uuid.parse(c.req.param("id")), c.req.valid("json"));
      return c.json({ ok: true });
    },
  );

  org.post("/polls/:id/options", zValidator("json", z.object({ label: z.string().trim().min(1).max(120) })), async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    const o = await addOption(db, organiser.id, uuid.parse(c.req.param("id")), c.req.valid("json").label);
    return c.json({ id: o.id }, 201);
  });

  org.delete("/polls/:id/options/:optionId", async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    await removeOption(db, organiser.id, uuid.parse(c.req.param("id")), uuid.parse(c.req.param("optionId")));
    return c.json({ ok: true });
  });

  org.put("/polls/:id/roll", async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    const ct = c.req.header("content-type") ?? "";
    if (!ct.startsWith("text/csv")) throw new DomainError("bad_content_type", "Send the roll as text/csv", 400);
    const csv = await c.req.text();
    if (csv.length > 200_000) throw new DomainError("roll_too_large", "The file is too large", 400);
    return c.json(await uploadRoll(db, organiser.id, uuid.parse(c.req.param("id")), csv));
  });

  org.post("/polls/:id/voters/reset", zValidator("json", z.object({ studentNumber: z.string().min(1).max(40) })), async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    await resetVoterPasskey(db, organiser.id, uuid.parse(c.req.param("id")), c.req.valid("json").studentNumber);
    return c.json({ ok: true });
  });

  org.post("/polls/:id/invite", async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    const code = await rotateInvite(db, organiser.id, uuid.parse(c.req.param("id")));
    return c.json({ code });
  });

  org.post("/polls/:id/open", async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    await openPoll(db, organiser.id, uuid.parse(c.req.param("id")), now());
    return c.json({ ok: true });
  });

  org.post("/polls/:id/close", async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    const b = await closePoll(db, organiser.id, uuid.parse(c.req.param("id")), now(), signingKey(c));
    return c.json({ merkleRoot: b.merkleRoot, ballotCount: b.ballotCount, tally: b.tally });
  });

  org.post("/polls/:id/publish", async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    await publishPoll(db, organiser.id, uuid.parse(c.req.param("id")), now());
    return c.json({ ok: true });
  });

  app.route("/organiser", org);

  // ---- Public -------------------------------------------------------------------------------------------------

  app.get("/polls/:id", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    const row = id.success ? await getDb(c.env).query.polls.findFirst({ where: eq(polls.id, id.data) }) : null;
    if (!row) throw new DomainError("not_found", "Poll not found", 404);
    return c.json({ id: row.id, title: row.title, description: row.description, status: row.status, published: row.publishedAt !== null });
  });

  // The whole signed bulletin, published only after the organiser publishes (ADR 0005, 0006).
  app.get("/polls/:id/bulletin", async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    const row = id.success ? await getDb(c.env).query.polls.findFirst({ where: eq(polls.id, id.data) }) : null;
    if (!row?.bulletin || !row.publishedAt) throw new DomainError("not_found", "No published results for this poll", 404);
    return c.body(row.bulletin, 200, { "content-type": "application/json", "cache-control": "public, max-age=60" });
  });

  app.get("/signing-key", async (c) => c.json({ algorithm: "Ed25519", publicKey: await publicKeyOf(signingKey(c)) }));

  // ---- Voter --------------------------------------------------------------------------------------------------

  const vote = new Hono<{ Bindings: Env }>();
  const pollId = (c: Context) => {
    const id = uuid.safeParse(c.req.param("pollId"));
    if (!id.success) throw new DomainError("not_found", "Poll not found", 404);
    return id.data;
  };

  vote.post("/:pollId/start", zValidator("json", z.object({ code: z.string().min(8).max(64), studentNumber: z.string().min(1).max(40) })), async (c) => {
    const r = await beginVoterAuth(getDb(c.env), await voterSecret(c), webauthn(c), pollId(c), c.req.valid("json"), now().getTime());
    return c.json(r);
  });

  vote.post("/:pollId/finish", zValidator("json", z.object({ token: z.string().max(2000), response: z.record(z.string(), z.unknown()) })), async (c) => {
    const r = await finishVoterAuth(getDb(c.env), await voterSecret(c), webauthn(c), pollId(c), c.req.valid("json"), now().getTime());
    return c.json(r);
  });

  async function voterFromBearer(c: Context<{ Bindings: Env }>) {
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    const s = m ? await readSession(await voterSecret(c), m[1]!, pollId(c), now().getTime()) : null;
    if (!s) throw new DomainError("session_expired", "Confirm your passkey again", 403);
    return s.v;
  }

  vote.get("/:pollId/ballot", async (c) => {
    const voterId = await voterFromBearer(c);
    const db = getDb(c.env);
    const shape = await loadBulletinPoll(db, pollId(c));
    const row = await db.query.polls.findFirst({ where: eq(polls.id, pollId(c)) });
    if (!shape || !row) throw new DomainError("not_found", "Poll not found", 404);
    if (row.status !== "open") throw new DomainError("not_open", "This poll is not open");
    const voted = await db.query.participations.findFirst({
      where: and(eq(participations.pollId, row.id), eq(participations.voterId, voterId)),
      columns: { voterId: true },
    });
    return c.json({ title: shape.title, description: row.description, questions: shape.questions, hasVoted: Boolean(voted) });
  });

  vote.post(
    "/:pollId/cast",
    zValidator("json", z.object({
      idempotencyKey: z.string().min(16).max(64),
      selections: z.array(z.object({ questionId: z.string().uuid(), optionId: z.string().uuid() })).min(1).max(30),
    })),
    async (c) => {
      const voterId = await voterFromBearer(c);
      const body = c.req.valid("json");
      const r = await castBallot(getDb(c.env), {
        pollId: pollId(c),
        voterId,
        idempotencyKey: body.idempotencyKey,
        selections: body.selections.map((s): Selection => [s.questionId, s.optionId]),
        now: now(),
      });
      switch (r.status) {
        case "cast": return c.json({ receipt: r.receipt, replayed: false }, 201);
        case "replayed": return c.json({ receipt: r.receipt, replayed: true }, 200);
        case "already_voted": return c.json({ error: "already_voted", message: "You have already voted in this poll" }, 409);
        case "not_open": return c.json({ error: "not_open", message: "This poll is not open" }, 409);
        case "invalid_selection": return c.json({ error: "invalid_selection", message: "Choose one option for every question" }, 400);
        case "receipt_collision": return c.json({ error: "retry", message: "Please try again" }, 409);
      }
    },
  );

  app.route("/vote", vote);

  return app;
}

export const app = createApp();
