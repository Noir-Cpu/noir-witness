// Local server for development and Playwright: the real app on in-process Postgres (PGlite), the built web app served
// alongside, and a fixed organiser standing in for GitHub sign-in. Never deployed: the Worker entry is index.ts.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { readFileSync } from "node:fs";
import { createPgliteDb } from "@noir/db/pglite";
import { user } from "@noir/db";
import { generateSigningKey } from "@noir/bulletin";
import { createApp, type Env } from "./app";
import { headersFor, parseHeadersFile } from "./static-headers";

const port = Number(process.env.PORT ?? 8787);
const db = await createPgliteDb();
await db.insert(user).values({ id: "dev-organiser", name: "Dev Organiser", email: "dev@example.test" });
const env = {
  DATABASE_URL: "unused",
  BETTER_AUTH_SECRET: "dev-only-secret-dev-only-secret-dev-only",
  SIGNING_KEY: (await generateSigningKey()).privateKey,
} as Env;

const api = createApp({ db, organiser: async () => ({ id: "dev-organiser", name: "Dev Organiser" }) });
const server = new Hono();
server.route("/", new Hono().all("/api/*", (c) => api.fetch(c.req.raw, env)));
// The built web app, with the headers from dist/_headers (what Workers static assets would add in production), and the
// .html extension handling Workers uses (/privacy serves privacy.html). Compressed, so Lighthouse sees realistic sizes.
const staticRules = parseHeadersFile(readFileSync("../web/dist/_headers", "utf8"));
server.use("*", compress());
server.use("*", async (c, next) => {
  await next();
  if (c.req.path.startsWith("/api/")) return;
  for (const [k, v] of headersFor(staticRules, c.req.path)) c.res.headers.set(k, v);
});
server.get("/privacy", serveStatic({ path: "../web/dist/privacy.html" }));
server.use("*", serveStatic({ root: "../web/dist" }));
server.get("*", serveStatic({ path: "../web/dist/index.html" }));

serve({ fetch: server.fetch, port }, (info) => console.log(`WITNESS dev server (PGlite, fixed organiser) on http://localhost:${info.port}`));
