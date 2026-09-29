// Local, in-process measurement of the cast path: the Hono app talking to PGlite (in-process Postgres) in this Node
// process. It is NOT a production number: there is no network, no Neon, no Workers runtime, and PGlite serialises
// queries on one connection. It shows how the cast path behaves under a paced arrival rate on this machine.
//
//   npx tsx scripts/load.ts [--rate 35] [--seconds 20] [--voters 700]
import { makeWorld, seedOpenPoll, voterSession, newKey } from "../apps/api/src/test-helpers";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const rate = arg("rate", 35);
const seconds = arg("seconds", 20);
const total = Math.round(rate * seconds);
const voters = arg("voters", total);

const w = await makeWorld();
const s = await seedOpenPoll(w.db, voters);
const tokens = await Promise.all(s.voterIds.map((v) => voterSession(s.pollId, v)));

const latencies: number[] = [];
const statuses: Record<number, number> = {};
const started = performance.now();

// Open-loop schedule: request i is due at i / rate. Latency is measured from the due time, so a slow server
// cannot hide by delaying the next request.
await Promise.all(
  Array.from({ length: total }, async (_, i) => {
    const due = started + (i / rate) * 1000;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const v = i % voters;
    const res = await w.request(`/api/vote/${s.pollId}/cast`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens[v]}` },
      body: JSON.stringify({ idempotencyKey: newKey(), selections: [{ questionId: s.questionId, optionId: s.optionIds[v % 2] }] }),
    });
    await res.arrayBuffer();
    latencies.push(performance.now() - due);
    statuses[res.status] = (statuses[res.status] ?? 0) + 1;
  }),
);

const elapsed = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)]!.toFixed(1);
console.log(
  JSON.stringify(
    {
      note: "local in-process measurement (Hono + PGlite, no network); not a production figure",
      requests: total,
      voters,
      targetRatePerSecond: rate,
      achievedRatePerSecond: Number((total / elapsed).toFixed(1)),
      statuses,
      latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99), max: latencies.at(-1)!.toFixed(1) },
      node: process.version,
    },
    null,
    2,
  ),
);
process.exit(0);
