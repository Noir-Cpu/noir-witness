import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// The seam: production uses the Neon HTTP driver, tests and local dev use PGlite. Code that takes a Db must not
// use interactive transactions (the HTTP driver has none); multi-step atomicity is one SQL statement (ADR 0004).
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// Use Neon's pooled endpoint in DATABASE_URL; never open a raw connection per request.
export function createDb(databaseUrl: string): Db {
  return drizzle(neon(databaseUrl), { schema }) as unknown as Db;
}

// Both drivers return { rows } from db.execute().
export function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

export { schema };
export * from "./schema";
