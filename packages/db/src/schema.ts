import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at"),
    aaguid: text("aaguid"),
  },
  (table) => [
    index("passkey_userId_idx").on(table.userId),
    index("passkey_credentialID_idx").on(table.credentialID),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  passkeys: many(passkey),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const passkeyRelations = relations(passkey, ({ one }) => ({
  user: one(user, {
    fields: [passkey.userId],
    references: [user.id],
  }),
}));


// ---------------------------------------------------------------------------
// WITNESS domain. Organiser identity lives in the Better Auth tables above; voters never appear there.
// ---------------------------------------------------------------------------

export const POLL_STATUSES = ["draft", "open", "closed"] as const;
export type PollStatus = (typeof POLL_STATUSES)[number];

export const organisations = pgTable("organisations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const polls = pgTable(
  "polls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: POLL_STATUSES }).notNull().default("draft"),
    liveResults: boolean("live_results").notNull().default(false),
    // SHA-256 of the invite code; the code itself is shown to the organiser once (ADR 0008).
    inviteHash: text("invite_hash"),
    // Per-poll salt for hashing student numbers (ADR 0010).
    rollSalt: text("roll_salt").notNull(),
    // Per-poll key from which receipts are derived out of idempotency keys (ADR 0009).
    receiptKey: text("receipt_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // The signed bulletin, JSON text, written once at close (ADR 0006).
    bulletin: text("bulletin"),
  },
  (t) => [index("polls_org_idx").on(t.organisationId)],
);

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [index("questions_poll_idx").on(t.pollId)],
);

export const options = pgTable(
  "options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [index("options_question_idx").on(t.questionId)],
);

// The roll. Student numbers are stored only as salted hashes. The passkey a voter binds on first use is stored here,
// on the identity side; nothing on this table is reachable from a ballot. No timestamps: registration time would
// be a second clock to correlate against.
export const eligibleVoters = pgTable(
  "eligible_voters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    studentHash: text("student_hash").notNull(),
    credentialId: text("credential_id"),
    credentialPublicKey: text("credential_public_key"),
    credentialCounter: integer("credential_counter"),
    credentialTransports: text("credential_transports"),
  },
  (t) => [uniqueIndex("eligible_voters_poll_student_uq").on(t.pollId, t.studentHash)],
);

// Who voted. Hour bucket only (ADR 0005). No id column: the pair is the key.
export const participations = pgTable(
  "participations",
  {
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    voterId: uuid("voter_id")
      .notNull()
      .references(() => eligibleVoters.id, { onDelete: "cascade" }),
    hourBucket: timestamp("hour_bucket", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.voterId] })],
);

// What was voted. No voter reference, no timestamp, no sequence (ADR 0003, 0005).
// selections is an array of [questionId, optionId] pairs sorted by questionId.
export const ballots = pgTable(
  "ballots",
  {
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    receipt: text("receipt").notNull(),
    selections: jsonb("selections").$type<[string, string][]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.receipt] })],
);

// Organiser actions only. Voter actions are never written here.
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pollId: uuid("poll_id").references(() => polls.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("audit_events_poll_idx").on(t.pollId)],
);
