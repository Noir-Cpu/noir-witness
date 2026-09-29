import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { eligibleVoters } from "@noir/db";
import type { Bulletin } from "@noir/bulletin";
import { hashStudentNumber } from "./domain/crypto";
import { newKey, studentNumbers, voterSession, type World } from "./test-helpers";

// Drives a whole poll through the public API the way the UI does. Shared by the lifecycle, secrecy and verifier tests.
export async function runElection(w: World, opts: { voters?: number; votes?: number } = {}) {
  const nVoters = opts.voters ?? 14;
  const nVotes = opts.votes ?? 12;
  const create = await w.json("POST", "/api/organiser/polls", {
    organisation: "Dev Society", title: "Chair 2026", description: "", question: "Who should chair?", options: ["Ada", "Bo"],
  });
  expectStatus(create, 201);
  const { id: pollId } = (await create.json()) as { id: string };
  expectStatus(await w.json("POST", `/api/organiser/polls/${pollId}/options`, { label: "Cy" }), 201);

  const nums = studentNumbers(nVoters);
  const csv = ["Student number", ...nums.map((n, i) => (i === 0 ? ` "${n.toLowerCase()}" ` : n)), nums[1]].join("\r\n");
  const roll = await w.request(`/api/organiser/polls/${pollId}/roll`, { method: "PUT", headers: { "content-type": "text/csv" }, body: csv });
  expectStatus(roll, 200);
  const invite = (await (await w.json("POST", `/api/organiser/polls/${pollId}/invite`)).json()) as { code: string };
  expectStatus(await w.json("POST", `/api/organiser/polls/${pollId}/open`), 200);

  const detail = (await (await w.request(`/api/organiser/polls/${pollId}`)).json()) as {
    questions: { id: string; options: { id: string; label: string }[] }[];
  };
  const q = detail.questions[0]!;
  const poll = await w.db.query.polls.findFirst({ where: (p, { eq }) => eq(p.id, pollId) });
  const voters = await Promise.all(
    nums.map(async (n) => {
      const hash = await hashStudentNumber(poll!.rollSalt, n);
      const [v] = await w.db.select().from(eligibleVoters).where(eq(eligibleVoters.studentHash, hash));
      return { number: n, id: v!.id };
    }),
  );

  const receipts: { voter: string; receipt: string; option: string }[] = [];
  for (let i = 0; i < nVotes; i++) {
    const option = q.options[i % q.options.length]!.id;
    const res = await w.request(`/api/vote/${pollId}/cast`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await voterSession(pollId, voters[i]!.id)}` },
      body: JSON.stringify({ idempotencyKey: newKey(), selections: [{ questionId: q.id, optionId: option }] }),
    });
    expectStatus(res, 201);
    receipts.push({ voter: voters[i]!.id, receipt: ((await res.json()) as { receipt: string }).receipt, option });
  }
  return { pollId, questionId: q.id, options: q.options, voters, receipts, invite: invite.code, roll: (await roll.json()) as { voters: number; duplicatesIgnored: number } };
}

export async function closeAndPublish(w: World, pollId: string) {
  expectStatus(await w.json("POST", `/api/organiser/polls/${pollId}/close`), 200);
  expectStatus(await w.json("POST", `/api/organiser/polls/${pollId}/publish`), 200);
  const res = await w.request(`/api/polls/${pollId}/bulletin`);
  expectStatus(res, 200);
  const text = await res.text();
  return { text, bulletin: JSON.parse(text) as Bulletin };
}

export function writeTemp(name: string, content: string) {
  const dir = mkdtempSync(join(tmpdir(), "witness-"));
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

function expectStatus(res: Response, status: number) {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} for ${res.url}`);
}
