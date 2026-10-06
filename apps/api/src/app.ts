import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { account, createDb, participations, polls, type Db } from "@noir/db";
import { publicKeyOf, type Selection } from "@noir/bulletin";
import { and, eq } from "drizzle-orm";
import { tracing, type OtelEnv } from "./otel";
import { createAuth, type AuthEnv } from "./auth";
import { castBallot, loadBulletinPoll } from "./domain/cast";
import { deriveSecret } from "./domain/crypto";
import {
  DomainError, addOption, ownedPoll, closePoll, createPoll, listPolls, openPoll, pollDetail, publishPoll, removeOption,
  resetVoterPasskey, rotateInvite, updatePoll, uploadRoll,
} from "./domain/polls";
import { beginVoterAuth, finishVoterAuth, inviteCodeMatches, readSession, type WebAuthnConfig } from "./domain/voter-auth";
import { assertSameOriginWrite, securityHeaders } from "./security";
import { clientAddress, ipKey, memoryVoterLimiters, studentKey, voterLimiters, type VoterLimiters } from "./guards";
import { eraseVoterData, purgeDaysFrom, retentionStatus } from "./domain/retention";

export type Env = AuthEnv &
  OtelEnv & {
    SENTRY_DSN_API?: string;
    SIGNING_KEY?: string;
    // Cloudflare Workers Rate Limiting bindings (wrangler.toml [[ratelimits]]). Absent in tests and dev:local.
    RATE_LIMIT_IP?: unknown;
    RATE_LIMIT_STUDENT?: unknown;
    // Days after close before voter data is erased by the daily cron (wrangler.toml [vars]). Plain text, not a secret.
    PURGE_DAYS?: string;
    // Optional allow-list of numeric GitHub user ids, comma-separated. Unset: any signed-in user may organise (ADR 0018).
    ORGANISERS_ALLOWED_GITHUB_IDS?: string;
  };
export type Organiser = { id: string; name: string };

export type Deps = {
  db?: Db | ((env: Env) => Db);
  organiser?: (c: Context<{ Bindings: Env }>, db: Db) => Promise<Organiser | null>;
  now?: () => Date;
  // Overrides the rate limiters regardless of bindings (tests). Default: Cloudflare bindings, else in-memory.
  limiters?: VoterLimiters;
};

const uuid = z.string().uuid();

/** null: no allow-list. Otherwise the set of listed ids (empty when the variable holds nothing usable, which denies everyone). */
export function parseAllowedGithubIds(raw: string | undefined): Set<string> | null {
  if (raw === undefined || raw.trim() === "") return null;
  return new Set(raw.split(",").map((x) => x.trim()).filter((x) => /^\d{1,20}$/.test(x)));
}

// A driver error can quote the connection string. Keep the host and drop the credentials, in case it reaches a log.
const redact = (text: string) => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]*@/gi, "$1***@");

export function createApp(deps: Deps = {}) {
  const app = new Hono<{ Bindings: Env }>().basePath("/api");
  const now = deps.now ?? (() => new Date());
  // One in-memory pair per app instance, so tests are isolated from each other.
  const memory = memoryVoterLimiters();
  const limiters = (env: Env): VoterLimiters => deps.limiters ?? voterLimiters(env ?? {}, memory);
  const getDb = (env: Env): Db => (typeof deps.db === "function" ? deps.db(env) : (deps.db ?? createDb(env.DATABASE_URL)));

  const getOrganiser = async (c: Context<{ Bindings: Env }>): Promise<Organiser | null> => {
    const db = getDb(c.env);
    if (deps.organiser) return deps.organiser(c, db);
    const session = await createAuth(c.env, c.req.url, db).api.getSession({ headers: c.req.raw.headers });
    return session ? { id: session.user.id, name: session.user.name } : null;
  };

  // Signed in is not the same as approved. When ORGANISERS_ALLOWED_GITHUB_IDS is set, only users whose GitHub account id
  // (the immutable number, not the login name, which can be renamed or re-registered) is listed may organise.
  const NOT_APPROVED = "This deployment only allows approved organisers. Ask the person who runs WITNESS to add your GitHub account.";
  const approved = async (c: Context<{ Bindings: Env }>, o: Organiser): Promise<boolean> => {
    const allowed = parseAllowedGithubIds(c.env?.ORGANISERS_ALLOWED_GITHUB_IDS);
    if (allowed === null) return true;
    if (allowed.size === 0) return false; // set but unreadable: fail closed
    const rows = await getDb(c.env).select({ id: account.accountId }).from(account).where(and(eq(account.userId, o.id), eq(account.providerId, "github")));
    return rows.some((r) => allowed.has(r.id));
  };

  const requireOrganiser = async (c: Context<{ Bindings: Env }>) => {
    const o = await getOrganiser(c);
    if (!o) throw new DomainError("unauthenticated", "Sign in as an organiser", 403);
    if (!(await approved(c, o))) throw new DomainError("not_approved", NOT_APPROVED, 403);
    return { organiser: o, db: getDb(c.env) };
  };

  // Cheap checks that run before any validator or handler (so before a body is parsed or a session is looked up):
  // a write the browser says came from another site is refused outright, and a cookie-authenticated write must be JSON
  // or CSV, which a cross-site form cannot send without a preflight. A write with no body needs no content type.
  const writeGuard = async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (!assertSameOriginWrite(c)) throw new DomainError("cross_site", "This request did not come from this site", 403);
      if (c.req.raw.body !== null && c.req.header("content-length") !== "0") {
        if (!/^(application\/json|text\/csv)/.test(c.req.header("content-type") ?? "")) {
          throw new DomainError("bad_content_type", "Unsupported content type", 400);
        }
      }
    }
    await next();
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

  app.use("*", securityHeaders());
  app.use("*", tracing());
  // Nothing legitimate sends a large body except the roll upload (below). Checked on the declared length and again while
  // reading, so a missing or false Content-Length cannot get past it.
  const smallBody = bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: "too_large", message: "The request is too large" }, 413) });
  app.use("*", (c, next) => (/^\/api\/organiser\/polls\/[^/]+\/roll$/.test(c.req.path) ? next() : smallBody(c, next)));

  app.notFound((c) => c.json({ error: "not_found", message: "Not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: "not_found", message: "Not found" }, 404); // a malformed id in the path
    if (err instanceof DomainError) {
      if (err.status === 429) c.header("retry-after", "60");
      return c.json({ error: err.code, message: err.message }, err.status);
    }
    if ("getResponse" in err && typeof err.getResponse === "function") return (err as { getResponse(): Response }).getResponse();
    // Voter routes carry invite codes and student numbers in request bodies; an error message could echo them, so only
    // the error class is logged there (ADR 0015). Elsewhere a truncated message helps debugging.
    const voter = c.req.path.startsWith("/api/vote/");
    console.error(JSON.stringify({ level: "error", msg: "unhandled", err: err.name, ...(voter ? {} : { detail: redact(String(err.message)).slice(0, 200) }) }));
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

  // Better Auth checks Origin only when a cookie is present. Sign-in and sign-out are only ever posted by this site's own
  // pages, so any POST that a browser says came from elsewhere is refused (login CSRF, forced redirects).
  app.use("/auth/*", async (c, next) => {
    if (c.req.method === "POST" && !assertSameOriginWrite(c)) throw new DomainError("cross_site", "This request did not come from this site", 403);
    await next();
  });
  app.on(["GET", "POST"], "/auth/*", (c) => createAuth(c.env, c.req.url, getDb(c.env)).handler(c.req.raw));

  app.get("/me", async (c) => {
    const o = await getOrganiser(c);
    if (!o) return c.json({ user: null }, 401);
    if (!(await approved(c, o))) return c.json({ user: null, error: "not_approved", message: NOT_APPROVED }, 403);
    return c.json({ user: o });
  });

  // ---- Organiser ----------------------------------------------------------------------------------------------

  const org = new Hono<{ Bindings: Env }>();
  org.use("*", writeGuard);

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

  // The organiser can read the signed bulletin as soon as the poll is closed, before deciding to publish it.
  org.get("/polls/:id/bulletin", async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    const poll = await ownedPoll(db, uuid.parse(c.req.param("id")), organiser.id);
    if (!poll.bulletin) throw new DomainError("not_closed", "The poll has not been closed", 404);
    return c.body(poll.bulletin, 200, { "content-type": "application/json" });
  });

  org.get("/polls/:id", async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    const detail = await pollDetail(db, organiser.id, uuid.parse(c.req.param("id")));
    return c.json({ ...detail, retention: await retentionStatus(db, detail.id, purgeDaysFrom(c.env?.PURGE_DAYS)) });
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

  org.put(
    "/polls/:id/roll",
    bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "roll_too_large", message: "The file is too large" }, 413) }),
    async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    const ct = c.req.header("content-type") ?? "";
    if (!ct.startsWith("text/csv")) throw new DomainError("bad_content_type", "Send the roll as text/csv", 400);
    const csv = await c.req.text();
    if (csv.length > 200_000) throw new DomainError("roll_too_large", "The file is too large", 400);
    return c.json(await uploadRoll(db, organiser.id, uuid.parse(c.req.param("id")), csv));
    },
  );

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

  // Erases the identity side of a closed poll: roll, passkeys and who-voted. Ballots and the bulletin are kept (ADR 0016).
  org.post("/polls/:id/erase-voter-data", async (c) => {
    const { organiser, db } = await requireOrganiser(c);
    return c.json(await eraseVoterData(db, organiser.id, uuid.parse(c.req.param("id")), now()));
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

  // Per client address, before anything else is read or parsed (ADR 0014). Sign-in steps and ballot steps have their own
  // buckets so a busy sign-in minute cannot block people who are already signed in.
  vote.use("*", async (c, next) => {
    const group = /\/(start|finish)$/.test(c.req.path) ? "auth" : "vote";
    if (!(await limiters(c.env).ip.allow(ipKey(group, clientAddress(c.req.raw.headers))))) {
      throw new DomainError(
        "rate_limited",
        "Many people are using this network right now, or there were too many attempts in a row. Wait a minute and try again. Your invite link still works.",
        429,
      );
    }
    await next();
  });

  vote.post("/:pollId/start", zValidator("json", z.object({ code: z.string().min(8).max(64), studentNumber: z.string().min(1).max(40) })), async (c) => {
    const body = c.req.valid("json");
    // Only a caller who already holds the invite code is counted against a student's bucket. Counting before the code
    // check would let anyone who knows a poll id and a student number (not secrets) lock that student out of voting.
    // Per poll and student, whether or not the number is on the roll, so the limit itself reveals nothing about the roll.
    if (await inviteCodeMatches(getDb(c.env), pollId(c), body.code)) {
      const key = await studentKey(await deriveSecret(c.env.BETTER_AUTH_SECRET, "ratelimit-v1"), pollId(c), body.studentNumber);
      if (!(await limiters(c.env).student.allow(key))) {
        throw new DomainError("rate_limited_student", "Too many attempts for this student number. Wait a minute and try again.", 429);
      }
    }
    const r = await beginVoterAuth(getDb(c.env), await voterSecret(c), webauthn(c), pollId(c), body, now().getTime());
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
