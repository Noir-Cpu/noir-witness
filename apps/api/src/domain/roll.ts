export type ParsedRoll = { numbers: string[]; duplicates: number; invalid: string[] };

export const MAX_ROLL = 5000;
const VALID = /^[A-Z0-9][A-Z0-9-]{2,19}$/;
const HEADER = /^(student|number|no\b|id\b|stud)/i;

// First column of a CSV of student numbers. A header row is skipped. Quoted fields are unwrapped; anything more
// elaborate is rejected as invalid rather than guessed at.
export function parseRollCsv(csv: string): ParsedRoll {
  const seen = new Set<string>();
  const invalid: string[] = [];
  let duplicates = 0;
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const first = (line.split(/[,;\t]/)[0] ?? "").trim().replace(/^"|"$/g, "");
    if (i === 0 && HEADER.test(first)) return;
    const n = first.replace(/\s+/g, "").toUpperCase();
    if (!VALID.test(n)) {
      invalid.push(`line ${i + 1}`);
      return;
    }
    if (seen.has(n)) duplicates++;
    else seen.add(n);
  });
  return { numbers: [...seen], duplicates, invalid };
}
