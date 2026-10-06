// Applies a Cloudflare `_headers` file the way Workers static assets do, so the local server used by Playwright serves
// the same headers as production. Rules: a path pattern on its own line, indented "Name: value" lines below it, `*` is a
// splat. Every matching rule applies, and a header named in several rules is joined with ", " (Cloudflare does the same,
// which is why site.ts never repeats a header across rules).
export type HeaderRule = { pattern: RegExp; headers: [string, string][] };

export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const source = raw.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      current = { pattern: new RegExp(`^${source}$`), headers: [] };
      rules.push(current);
    } else if (current) {
      const i = raw.indexOf(":");
      current.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
    }
  }
  return rules;
}

export function headersFor(rules: HeaderRule[], path: string): Headers {
  const out = new Headers();
  for (const r of rules) if (r.pattern.test(path)) for (const [k, v] of r.headers) out.append(k, v); // append joins with ", "
  return out;
}
