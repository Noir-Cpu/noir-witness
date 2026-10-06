import { and, eq, isNull } from "drizzle-orm";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { eligibleVoters, polls, type Db } from "@noir/db";
import { fromB64u, toB64u } from "@noir/bulletin";
import { hashInviteCode, hashStudentNumber, signToken, timingSafeEqualHex, verifyToken, type TokenPayload } from "./crypto";
import { DomainError } from "./polls";

const CHALLENGE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 10 * 60_000;

type ChallengeToken = TokenPayload & { k: "challenge"; v: string; p: string; c: string; m: "register" | "authenticate" };
export type SessionToken = TokenPayload & { k: "session"; v: string; p: string };

export type WebAuthnConfig = { rpID: string; origin: string; rpName: string };

const noMatch = () => new DomainError("no_match", "Those details do not match this poll. Check your student number, and that you opened the whole invite link.", 403);

// True only for the poll's current invite code. Used to decide whether a request counts against a student's rate limit.
export async function inviteCodeMatches(db: Db, pollId: string, code: string) {
  const poll = await db.query.polls.findFirst({ where: eq(polls.id, pollId), columns: { inviteHash: true } });
  const given = await hashInviteCode(code);
  return Boolean(poll?.inviteHash) && timingSafeEqualHex(given, poll!.inviteHash!);
}

// Step 1: invite code and student number. The same error covers a wrong code and a number not on the roll, so the
// endpoint cannot be used to test who is on the roll without the code.
export async function beginVoterAuth(
  db: Db, secret: string, cfg: WebAuthnConfig, pollId: string, input: { code: string; studentNumber: string }, now: number,
) {
  const poll = await db.query.polls.findFirst({ where: eq(polls.id, pollId) });
  if (!poll?.inviteHash || !timingSafeEqualHex(await hashInviteCode(input.code), poll.inviteHash)) throw noMatch();
  const voter = await db.query.eligibleVoters.findFirst({
    where: and(eq(eligibleVoters.pollId, pollId), eq(eligibleVoters.studentHash, await hashStudentNumber(poll.rollSalt, input.studentNumber))),
  });
  if (!voter) throw noMatch();
  if (poll.status !== "open") throw new DomainError("not_open", poll.status === "draft" ? "This poll has not opened yet" : "This poll is closed");

  const registered = voter.credentialId !== null;
  const options = registered
    ? await generateAuthenticationOptions({
        rpID: cfg.rpID,
        userVerification: "required",
        allowCredentials: [{ id: voter.credentialId!, transports: parseTransports(voter.credentialTransports) }],
      })
    : await generateRegistrationOptions({
        rpID: cfg.rpID,
        rpName: cfg.rpName,
        userName: `Voter in ${poll.title}`.slice(0, 60),
        userID: new TextEncoder().encode(voter.id),
        attestationType: "none",
        authenticatorSelection: { residentKey: "discouraged", userVerification: "required" },
      });
  const token = await signToken(secret, {
    k: "challenge", v: voter.id, p: pollId, c: options.challenge, m: registered ? "authenticate" : "register", exp: now + CHALLENGE_TTL_MS,
  });
  return { mode: registered ? ("authenticate" as const) : ("register" as const), options, token };
}

// Step 2: the passkey ceremony. First use binds the passkey to the voter (first claim wins); later uses re-authenticate.
export async function finishVoterAuth(
  db: Db, secret: string, cfg: WebAuthnConfig, pollId: string, input: { token: string; response: unknown }, now: number,
) {
  const t = await verifyToken<ChallengeToken>(secret, input.token, "challenge", now);
  if (!t || t.p !== pollId) throw new DomainError("bad_token", "That sign-in attempt expired. Start again.", 403);
  const voter = await db.query.eligibleVoters.findFirst({ where: and(eq(eligibleVoters.id, t.v), eq(eligibleVoters.pollId, pollId)) });
  if (!voter) throw noMatch();
  const expected = { expectedChallenge: t.c, expectedOrigin: cfg.origin, expectedRPID: cfg.rpID, requireUserVerification: true };

  try {
    if (t.m === "register") {
      const r = await verifyRegistrationResponse({ response: input.response as RegistrationResponseJSON, ...expected });
      if (!r.verified) throw new Error("not verified");
      const { credential } = r.registrationInfo;
      const claimed = await db
        .update(eligibleVoters)
        .set({
          credentialId: credential.id,
          credentialPublicKey: toB64u(credential.publicKey),
          credentialCounter: credential.counter,
          credentialTransports: JSON.stringify(credential.transports ?? []),
        })
        .where(and(eq(eligibleVoters.id, voter.id), isNull(eligibleVoters.credentialId)))
        .returning({ id: eligibleVoters.id });
      if (!claimed.length) throw new DomainError("already_claimed", "A passkey is already set for this student number. Ask the organiser to reset it.");
    } else {
      if (!voter.credentialId || !voter.credentialPublicKey) throw new Error("no credential");
      const r = await verifyAuthenticationResponse({
        response: input.response as AuthenticationResponseJSON,
        ...expected,
        credential: {
          id: voter.credentialId,
          publicKey: fromB64u(voter.credentialPublicKey),
          counter: voter.credentialCounter ?? 0,
          transports: parseTransports(voter.credentialTransports),
        },
      });
      if (!r.verified) throw new Error("not verified");
      await db.update(eligibleVoters).set({ credentialCounter: r.authenticationInfo.newCounter }).where(eq(eligibleVoters.id, voter.id));
    }
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError("passkey_failed", "The passkey could not be verified", 403);
  }

  const session = await signToken(secret, { k: "session", v: voter.id, p: pollId, exp: now + SESSION_TTL_MS });
  return { session, expiresAt: new Date(now + SESSION_TTL_MS).toISOString() };
}

export const readSession = (secret: string, token: string, pollId: string, now: number) =>
  verifyToken<SessionToken>(secret, token, "session", now).then((s) => (s && s.p === pollId ? s : null));

function parseTransports(raw: string | null): AuthenticatorTransportFuture[] | undefined {
  try {
    return raw ? (JSON.parse(raw) as AuthenticatorTransportFuture[]) : undefined;
  } catch {
    return undefined;
  }
}
