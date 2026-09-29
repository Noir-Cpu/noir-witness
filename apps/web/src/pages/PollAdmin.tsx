import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Bulletin } from "@noir/bulletin";
import { api, errorText } from "../api";
import { Link } from "../router";
import { Alert, CopyButton, Heading } from "../ui";

type Detail = {
  id: string;
  title: string;
  description: string;
  status: "draft" | "open" | "closed";
  published: boolean;
  hasInvite: boolean;
  questions: { id: string; prompt: string; options: { id: string; label: string }[] }[];
  eligible: number;
  passkeysRegistered: number;
  turnout: number | null;
  smallElectorate: boolean;
  signedRoot: string | null;
};

export function PollAdmin({ id }: { id: string }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["poll", id], queryFn: () => api<Detail>(`/organiser/polls/${id}`) });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);

  if (detail.isPending) return <><Heading>Poll</Heading><p role="status">Loading…</p></>;
  if (detail.isError) return <><Heading>Poll</Heading><Alert>{errorText(detail.error)}</Alert><Link href="/organiser">Back to your polls</Link></>;
  const p = detail.data;
  const q = p.questions[0];

  async function act(fn: () => Promise<unknown>, done = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      if (done) setNotice(done);
      await qc.invalidateQueries({ queryKey: ["poll", id] });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const post = (path: string, json?: unknown) => api(`/organiser/polls/${id}${path}`, { method: "POST", json });

  async function uploadRoll(file: File | undefined) {
    if (!file) return;
    await act(async () => {
      const r = await api<{ voters: number; duplicatesIgnored: number }>(`/organiser/polls/${id}/roll`, { method: "PUT", csv: await file.text() });
      setNotice(`${r.voters} voters on the roll${r.duplicatesIgnored ? `, ${r.duplicatesIgnored} duplicate${r.duplicatesIgnored > 1 ? "s" : ""} ignored` : ""}.`);
    });
  }

  async function makeInvite() {
    await act(async () => {
      const r = await api<{ code: string }>(`/organiser/polls/${id}/invite`, { method: "POST", json: {} });
      // The code goes in the fragment so it is not sent to any server or written to a log.
      setInviteLink(`${location.origin}/vote/${id}#code=${r.code}`);
    });
  }

  const ready = p.status === "draft" && q && q.options.length >= 2 && p.eligible > 0 && p.hasInvite;

  return (
    <>
      <p className="meta"><Link href="/organiser">All polls</Link> · {p.status}{p.published ? " · published" : ""}</p>
      <Heading>{p.title}</Heading>
      {p.description && <p>{p.description}</p>}
      <Alert>{error}</Alert>
      {notice && <p role="status" className="ok">{notice}</p>}

      <section aria-labelledby="s-q">
        <h2 id="s-q">1. Question and options</h2>
        {q && <p><strong>{q.prompt}</strong></p>}
        <ul className="list">
          {q?.options.map((o) => (
            <li key={o.id}>
              <span>{o.label}</span>
              {p.status === "draft" && (
                <button type="button" className="secondary small" disabled={busy} aria-label={`Remove ${o.label}`} onClick={() => act(() => api(`/organiser/polls/${id}/options/${o.id}`, { method: "DELETE" }))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        {p.status === "draft" && <AddOption disabled={busy} onAdd={(label) => act(() => post("/options", { label }))} />}
      </section>

      <section aria-labelledby="s-roll">
        <h2 id="s-roll">2. Voter roll</h2>
        <p>
          {p.eligible} eligible voter{p.eligible === 1 ? "" : "s"}. {p.status === "open" || p.status === "closed" ? `${p.passkeysRegistered} have set up a passkey.` : ""}
        </p>
        {p.smallElectorate && (
          <p className="warning" role="note">
            <strong>Small electorate.</strong> With fewer than 10 eligible voters, results reveal a lot about how individuals voted. Consider whether a secret ballot means much here.
          </p>
        )}
        {p.status === "draft" && (
          <>
            <label>
              Upload a CSV of student numbers
              <span className="hint">One per line, or the first column of a file. A header row is skipped. Replaces any earlier upload. Stored only as salted hashes.</span>
              <input type="file" accept=".csv,text/csv,text/plain" disabled={busy} onChange={(e) => uploadRoll(e.target.files?.[0])} />
            </label>
          </>
        )}
      </section>

      <section aria-labelledby="s-inv">
        <h2 id="s-inv">3. Invite link</h2>
        {p.status !== "closed" && (
          <>
            <p>Share this link with your members yourself (WhatsApp, email, a notice). Voters also need their student number. Creating a new link stops the old one working.</p>
            <button type="button" className="secondary" disabled={busy} onClick={makeInvite}>{p.hasInvite ? "Create a new invite link" : "Create invite link"}</button>
            {inviteLink && (
              <div className="invite">
                <p className="meta">Shown once. Copy it now.</p>
                <p><code data-testid="invite-link">{inviteLink}</code></p>
                <CopyButton text={inviteLink} label="Copy link" />
              </div>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="s-run">
        <h2 id="s-run">4. Open and close</h2>
        {p.status === "draft" && (
          <>
            <p>Opening locks the options and the roll.</p>
            <button type="button" disabled={busy || !ready} onClick={() => act(() => post("/open"), "The poll is open.")}>Open poll</button>
            {!ready && <p className="hint">Needs at least two options, a roll and an invite link.</p>}
          </>
        )}
        {p.status === "open" && (
          <>
            <p>The poll is open. Results stay hidden until you close it, and no turnout is shown while voting is under way.</p>
            <ResetPasskey id={id} disabled={busy} />
            {!confirmClose ? (
              <button type="button" disabled={busy} onClick={() => setConfirmClose(true)}>Close poll…</button>
            ) : (
              <div role="group" aria-label="Confirm closing">
                <p><strong>Close the poll now?</strong> Nobody can vote afterwards. This cannot be undone.</p>
                <button type="button" disabled={busy} onClick={() => act(() => post("/close"), "Poll closed and signed.").then(() => setConfirmClose(false))}>Yes, close it</button>{" "}
                <button type="button" className="secondary" onClick={() => setConfirmClose(false)}>Keep it open</button>
              </div>
            )}
          </>
        )}
        {p.status === "closed" && <p>Closed. {p.turnout} of {p.eligible} eligible voters cast a ballot.</p>}
      </section>

      {p.status === "closed" && (
        <section aria-labelledby="s-res">
          <h2 id="s-res">5. Result and publication</h2>
          <Results id={id} />
          {p.signedRoot && <p className="meta">Signed Merkle root: <code>{p.signedRoot}</code></p>}
          {!p.published ? (
            <>
              <p>Publishing makes the full ballot list, tally and signature public so anyone can check the count.</p>
              <button type="button" disabled={busy} onClick={() => act(() => post("/publish"), "Published.")}>Publish results</button>
            </>
          ) : (
            <p>
              Published. Share <Link href={`/results/${id}`}>{location.origin}/results/{id}</Link>. Members can check receipts at <Link href={`/verify?poll=${id}`}>the verify page</Link>.
            </p>
          )}
        </section>
      )}
    </>
  );
}

function AddOption({ onAdd, disabled }: { onAdd: (label: string) => void; disabled: boolean }) {
  const [label, setLabel] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (label.trim()) onAdd(label.trim());
    setLabel("");
  }
  return (
    <form onSubmit={submit} className="inline" aria-label="Add option">
      <label>New option<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} /></label>
      <button type="submit" className="secondary" disabled={disabled || !label.trim()}>Add option</button>
    </form>
  );
}

function ResetPasskey({ id, disabled }: { id: string; disabled: boolean }) {
  const [number, setNumber] = useState("");
  const [msg, setMsg] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/organiser/polls/${id}/voters/reset`, { method: "POST", json: { studentNumber: number } });
      setMsg("Passkey cleared. That student can register again.");
      setNumber("");
    } catch (err) {
      setMsg(errorText(err));
    }
  }
  return (
    <details>
      <summary>A member cannot sign in (their number was claimed by someone else)</summary>
      <form onSubmit={submit} className="inline">
        <label>Student number<input value={number} onChange={(e) => setNumber(e.target.value)} autoComplete="off" /></label>
        <button type="submit" className="secondary" disabled={disabled || !number.trim()}>Reset passkey</button>
      </form>
      <p role="status">{msg}</p>
    </details>
  );
}

function Results({ id }: { id: string }) {
  const b = useQuery({ queryKey: ["org-bulletin", id], queryFn: () => api<Bulletin>(`/organiser/polls/${id}/bulletin`) });
  if (!b.data) return <p role="status">Loading result…</p>;
  return <TallyTable bulletin={b.data} />;
}

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
