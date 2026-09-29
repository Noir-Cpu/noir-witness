import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, errorText, ApiError } from "../api";
import { authClient } from "../auth-client";
import { Link, navigate } from "../router";
import { Alert, Heading } from "../ui";

type Me = { user: { id: string; name: string } };
type PollRow = { id: string; title: string; status: string; published: string | null; organisation: string };

export function Organiser() {
  const me = useQuery({
    queryKey: ["me"],
    retry: false,
    queryFn: () => api<Me>("/me").catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
  });

  if (me.isPending) return <><Heading>Organise</Heading><p role="status">Checking your session…</p></>;
  if (me.isError) return <><Heading>Organise</Heading><Alert>{errorText(me.error)}</Alert></>;
  if (!me.data) {
    return (
      <>
        <Heading>Organise a poll</Heading>
        <p className="lede">Sign in with GitHub to create polls. Voters do not need an account.</p>
        <button type="button" onClick={() => authClient.signIn.social({ provider: "github", callbackURL: "/organiser" })}>
          Sign in with GitHub
        </button>
      </>
    );
  }
  return <Signed name={me.data.user.name} />;
}

function Signed({ name }: { name: string }) {
  const polls = useQuery({ queryKey: ["polls"], queryFn: () => api<{ polls: PollRow[] }>("/organiser/polls") });
  return (
    <>
      <Heading>Your polls</Heading>
      <p className="meta">Signed in as {name}</p>
      {polls.isPending && <p role="status">Loading…</p>}
      {polls.data && polls.data.polls.length === 0 && <p>No polls yet. Create your first one below.</p>}
      {polls.data && polls.data.polls.length > 0 && (
        <ul className="list">
          {polls.data.polls.map((p) => (
            <li key={p.id}>
              <Link href={`/organiser/polls/${p.id}`}>{p.title}</Link>
              <span className="meta">{p.organisation} · {p.published ? "published" : p.status}</span>
            </li>
          ))}
        </ul>
      )}
      <NewPoll />
    </>
  );
}

function NewPoll() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const options = String(f.get("options")).split("\n").map((s) => s.trim()).filter(Boolean);
    setBusy(true);
    setError("");
    try {
      const r = await api<{ id: string }>("/organiser/polls", {
        method: "POST",
        json: {
          organisation: String(f.get("organisation")),
          title: String(f.get("title")),
          description: String(f.get("description")),
          question: String(f.get("question")),
          options,
        },
      });
      navigate(`/organiser/polls/${r.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-labelledby="new-poll">
      <h2 id="new-poll">New poll</h2>
      <label>Organisation<input name="organisation" required maxLength={80} defaultValue="" autoComplete="organization" /></label>
      <label>Poll title<input name="title" required maxLength={120} /></label>
      <label>Description <span className="hint">(optional)</span><textarea name="description" maxLength={1000} rows={2} /></label>
      <label>Question<input name="question" required maxLength={200} /></label>
      <label>
        Options
        <span className="hint">One per line. You can change them until the poll opens.</span>
        <textarea name="options" rows={4} required />
      </label>
      <Alert>{error}</Alert>
      <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create poll"}</button>
    </form>
  );
}
