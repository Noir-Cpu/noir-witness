import { defineConfig } from "drizzle-kit";

// Migrations run over the direct (unpooled) endpoint; the app uses the pooled DATABASE_URL.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: { url: (process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL)! },
});
