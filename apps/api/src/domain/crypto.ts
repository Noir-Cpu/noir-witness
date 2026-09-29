import { fromB64u, fromHex, toB64u, toHex } from "@noir/bulletin";

const enc = new TextEncoder();

export const randomHex = (bytes: number) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));
export const randomB64u = (bytes: number) => toB64u(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256Hex(text: string) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

async function hmacKey(secret: Uint8Array | string) {
  const raw = new Uint8Array(typeof secret === "string" ? enc.encode(secret) : secret);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmacHex(secret: Uint8Array | string, message: string) {
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message))));
}

export function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Student numbers are compared as: trimmed, upper-cased, inner whitespace removed.
export const normaliseStudentNumber = (raw: string) => raw.replace(/\s+/g, "").toUpperCase();

// HMAC keyed by the per-poll salt (ADR 0010). Student numbers are low-entropy: this stops precomputed tables and
// cross-poll matching, not a brute-force run by someone who holds the database.
export const hashStudentNumber = (salt: string, studentNumber: string) => hmacHex(fromHex(salt), normaliseStudentNumber(studentNumber));

export const hashInviteCode = (code: string) => sha256Hex(`witness-invite:${code}`);

// ADR 0009: the receipt is derived from the client's idempotency key, so a retry recomputes it with no stored link.
export const deriveReceipt = async (receiptKey: string, idempotencyKey: string) =>
  (await hmacHex(fromHex(receiptKey), `receipt:${idempotencyKey}`)).slice(0, 32);

// Short-lived signed tokens (voter challenge and voter session). Stateless: nothing to store, nothing to join on.
export type TokenPayload = { k: "challenge" | "session"; exp: number } & Record<string, unknown>;

export async function signToken(secret: string, payload: TokenPayload) {
  const body = toB64u(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmacHex(secret, body)}`;
}

export async function verifyToken<T extends TokenPayload>(secret: string, token: string, kind: T["k"], now: number): Promise<T | null> {
  const [body, mac] = token.split(".");
  if (!body || !mac || !timingSafeEqualHex(await hmacHex(secret, body), mac)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64u(body))) as T;
    return payload.k === kind && payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}

// One secret to configure (BETTER_AUTH_SECRET); purpose-specific keys are derived from it.
export const deriveSecret = (base: string, purpose: string) => hmacHex(base, `witness-derive:${purpose}`);
