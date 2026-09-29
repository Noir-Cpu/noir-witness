import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import type { Db } from "./index";
import * as schema from "./schema";

// In-process Postgres with the real migrations applied. Node only: tests, the load script and the e2e dev server.
export async function createPgliteDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  return db as unknown as Db;
}
