import { hmacHex, normaliseStudentNumber } from "./domain/crypto";

// Rate limiting for the voter endpoints (ADR 0014). Two limiters, both behind this interface so tests and local
// development can use an in-memory one when the Cloudflare binding is absent.

export interface RateLimiter {
  allow(key: string): Promise<boolean>;
}

/**
 * Fixed-window counter, per isolate. Best effort on Workers (isolates are not shared); the Cloudflare binding is the
 * real limit. Used when the binding is absent: tests and `dev:local`.
 */
export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  async allow(key: string) {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.resetAt <= t) {
      if (this.hits.size > 10_000) this.hits.clear(); // bound memory under a key-spraying attack
      this.hits.set(key, { n: 1, resetAt: t + this.windowMs });
      return true;
    }
    return ++h.n <= this.limit;
  }
}

/** Adapter for the Cloudflare Workers Rate Limiting binding. */
export const cloudflareLimiter = (b: { limit(o: { key: string }): Promise<{ success: boolean }> }): RateLimiter => ({
  allow: async (key) => (await b.limit({ key })).success,
});

// These must match the [[ratelimits]] blocks in wrangler.toml. The arithmetic is in ADR 0014.
export const IP_LIMIT = { limit: 600, periodSeconds: 60 };
export const STUDENT_LIMIT = { limit: 10, periodSeconds: 60 };

export type VoterLimiters = { ip: RateLimiter; student: RateLimiter };

type Binding = Parameters<typeof cloudflareLimiter>[0];

export function voterLimiters(env: { RATE_LIMIT_IP?: unknown; RATE_LIMIT_STUDENT?: unknown }, memory: VoterLimiters): VoterLimiters {
  return {
    ip: env.RATE_LIMIT_IP ? cloudflareLimiter(env.RATE_LIMIT_IP as Binding) : memory.ip,
    student: env.RATE_LIMIT_STUDENT ? cloudflareLimiter(env.RATE_LIMIT_STUDENT as Binding) : memory.student,
  };
}

export const memoryVoterLimiters = (now?: () => number): VoterLimiters => ({
  ip: new MemoryRateLimiter(IP_LIMIT.limit, IP_LIMIT.periodSeconds * 1000, now),
  student: new MemoryRateLimiter(STUDENT_LIMIT.limit, STUDENT_LIMIT.periodSeconds * 1000, now),
});

/** The address Cloudflare saw. Absent only outside Workers (tests, local dev), where everything shares one bucket. */
export const clientAddress = (headers: { get(name: string): string | null }) => headers.get("cf-connecting-ip")?.trim() || "local";

/**
 * Limiter key for one student in one poll. HMAC-SHA-256 of the normalised number under a secret derived from the
 * server's auth secret, so the plain number is never in the key and the key cannot be reversed by trying every
 * plausible number without that secret. The poll id is in the clear (it is public).
 */
export const studentKey = async (secret: string, pollId: string, studentNumber: string) =>
  `s:${pollId}:${await hmacHex(secret, `${pollId}\n${normaliseStudentNumber(studentNumber)}`)}`;

export const ipKey = (group: "auth" | "vote", address: string) => `ip:${group}:${address}`;
