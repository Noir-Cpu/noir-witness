import type { Bulletin } from "@noir/bulletin";

export function TallyTable({ bulletin }: { bulletin: Bulletin }) {
  return (
    <>
      {bulletin.poll.questions.map((q) => {
        const total = Object.values(bulletin.tally[q.id] ?? {}).reduce((a, n) => a + n, 0);
        return (
          <table key={q.id} className="tally">
            <caption>{q.prompt}</caption>
            <thead><tr><th scope="col">Option</th><th scope="col">Votes</th><th scope="col"><span className="sr">Share</span></th></tr></thead>
            <tbody>
              {q.options.map((o) => {
                const n = bulletin.tally[q.id]?.[o.id] ?? 0;
                return (
                  <tr key={o.id}>
                    <th scope="row">{o.label}</th>
                    <td>{n}</td>
                    <td aria-hidden="true"><span className="bar-fill" style={{ width: `${total ? (n / total) * 100 : 0}%` }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        );
      })}
    </>
  );
}
