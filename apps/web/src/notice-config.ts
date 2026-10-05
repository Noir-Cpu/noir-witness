// The only place the privacy notice's names, contact and retention period are set. The text in
// docs/PRIVACY-NOTICE.md uses {{society}}, {{officer}}, {{email}} and {{retentionDays}}. This email is public on /privacy.
// retentionDays must equal PURGE_DAYS in apps/api/wrangler.toml (apps/api/src/retention.test.ts guards the API side;
// privacy.test.tsx guards this side).
export const NOTICE = {
  society: "Stellenbosch Developer Society",
  officer: "Willie Loftie-Eaton",
  email: "24717274@sun.ac.za",
  retentionDays: 30,
} as const;

/** Fills the {{tokens}} in the notice source. An unknown token is left in place so the strict check fails on it. */
export function fillNotice(source: string): string {
  const values: Record<string, string> = {
    society: NOTICE.society,
    officer: NOTICE.officer,
    email: `[${NOTICE.email}](mailto:${NOTICE.email})`,
    retentionDays: String(NOTICE.retentionDays),
  };
  return source.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
}
