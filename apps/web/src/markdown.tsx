import { Fragment, type ReactNode } from "react";

// A small renderer for the subset of Markdown used in docs/PRIVACY-NOTICE.md: headings, paragraphs, bullet lists,
// block quotes, tables, **bold**, `code`, [links](url) and bare URLs. It builds React elements, never HTML strings,
// so nothing in the source can inject markup. Any other [bracketed] text is a placeholder and is shown highlighted.

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)|(https?:\/\/[^\s)]+[^\s).,;])|\[([^\]]+)\]/g;

export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1] !== undefined) out.push(<strong key={k}>{inline(m[1], k)}</strong>);
    else if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>);
    else if (m[3] !== undefined) out.push(<a key={k} href={m[4]} rel="noopener noreferrer">{m[3]}</a>);
    else if (m[5] !== undefined) out.push(<a key={k} href={m[5]} rel="noopener noreferrer">{m[5]}</a>);
    else out.push(<mark key={k} className="placeholder">[{m[6]}]</mark>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const isTableRule = (l: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(l.trim());

/** Every `[placeholder]` left in a Markdown source (links and checkbox markers are not placeholders). */
export function placeholders(source: string): string[] {
  const plain = source.replace(/`[^`]*`/g, "").replace(/\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)/g, "");
  return [...plain.matchAll(/\[([^\]]+)\]/g)].map((m) => m[0]);
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${k++}`;
    let m: RegExpMatchArray | null;
    if (!line.trim()) {
      i++;
    } else if ((m = line.match(/^(#{2,3}) (.+)$/))) {
      blocks.push(m[1] === "##" ? <h2 key={key}>{inline(m[2]!, key)}</h2> : <h3 key={key}>{inline(m[2]!, key)}</h3>);
      i++;
    } else if (line.startsWith("# ")) {
      i++; // the page supplies its own h1
    } else if (line.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) q.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(<p key={key} className="warning" role="note">{inline(q.join(" "), key)}</p>);
    } else if (line.trimStart().startsWith("|") && isTableRule(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith("|")) rows.push(cells(lines[i++]!));
      blocks.push(
        <table key={key} className="stack">
          <thead><tr>{head.map((h, c) => <th key={c} scope="col">{inline(h, `${key}h${c}`)}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => ci === 0
                  ? <th key={ci} scope="row" data-label={head[ci]}>{inline(c, `${key}r${ri}c${ci}`)}</th>
                  : <td key={ci} data-label={head[ci]}>{inline(c, `${key}r${ri}c${ci}`)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>,
      );
    } else if (/^- /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^- /.test(lines[i]!)) items.push(lines[i++]!.slice(2));
      blocks.push(<ul key={key}>{items.map((t, ii) => <li key={ii}>{inline(t, `${key}l${ii}`)}</li>)}</ul>);
    } else {
      const p: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^(#|>|- |\|)/.test(lines[i]!)) p.push(lines[i++]!);
      blocks.push(<p key={key}>{inline(p.join(" "), key)}</p>);
    }
  }
  return <>{blocks.map((b, n) => <Fragment key={n}>{b}</Fragment>)}</>;
}
