import { useEffect, useRef, useState, type FormEvent } from "react";
import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { api, ApiError, errorText } from "../api";
import { Link, useLocation } from "../router";
import { saveReceipt } from "../receipts";
import { Alert, CopyButton, Heading } from "../ui";

type Start = { mode: "register" | "authenticate"; options: Record<string, unknown>; token: string };
type Ballot = { title: string; description: string; questions: { id: string; prompt: string; options: { id: string; label: string }[] }[]; hasVoted: boolean };
type Step = "details" | "passkey" | "ballot" | "review" | "receipt";

const codeFromHash = (hash: string) => new URLSearchParams(hash.replace(/^#/, "")).get("code") ?? "";

export function Vote({ id }: { id: string }) {
  const { hash } = useLocation();
  const [step, setStep] = useState<Step>("details");
  const [title, setTitle] = useState("");
  const [code, setCode] = useState(codeFromHash(hash));
  const [studentNumber, setStudentNumber] = useState("");
  const [start, setStart] = useState<Start | null>(null);
  const [session, setSession] = useState("");
  const [ballot, setBallot] = useState<Ballot | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string>("");

  useEffect(() => {
    api<{ title: string; status: string }>(`/polls/${id}`).then((p) => setTitle(p.title)).catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`witness:key:${id}`) ?? "null") as { key: string; choice: Record<string, string> } | null;
      if (saved) {
        keyRef.current = saved.key;
        setChoice(saved.choice);
      }
    } catch { /* ignore */ }
  }, [id]);
  useEffect(() => {
    const c = codeFromHash(hash);
    if (c) setCode(c);
  }, [hash]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof WebAuthnError && e.name === "NotAllowedError"
          ? "The passkey prompt was cancelled or timed out. Try again."
          : errorText(e),
      );
    } finally {
      setBusy(false);
    }
  }

  const begin = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      setStart(await api<Start>(`/vote/${id}/start`, { method: "POST", json: { code: code.trim(), studentNumber: studentNumber.trim() } }));
      setStep("passkey");
    });
  };

  // Its own click, so the browser accepts the passkey prompt as a user action.
  const confirmPasskey = () =>
    run(async () => {
      const response =
        start!.mode === "register"
          ? await startRegistration({ optionsJSON: start!.options as never })
          : await startAuthentication({ optionsJSON: start!.options as never });
      const r = await api<{ session: string }>(`/vote/${id}/finish`, { method: "POST", json: { token: start!.token, response } });
      setSession(r.session);
      const b = await api<Ballot>(`/vote/${id}/ballot`, { token: r.session });
      setBallot(b);
      setStep(b.hasVoted ? "receipt" : "ballot");
    });

  const cast = () =>
    run(async () => {
      if (!keyRef.current) keyRef.current = crypto.randomUUID().replace(/-/g, "");
      // Kept until a receipt arrives, so a reload can retry safely with the same key and get the same receipt.
      try { sessionStorage.setItem(`witness:key:${id}`, JSON.stringify({ key: keyRef.current, choice })); } catch { /* private mode */ }
      try {
        const r = await api<{ receipt: string }>(`/vote/${id}/cast`, {
          method: "POST",
          token: session,
          json: { idempotencyKey: keyRef.current, selections: Object.entries(choice).map(([questionId, optionId]) => ({ questionId, optionId })) },
        });
        setReceipt(r.receipt);
        saveReceipt({ pollId: id, title: ballot?.title ?? title, receipt: r.receipt });
        try { sessionStorage.removeItem(`witness:key:${id}`); } catch { /* ignore */ }
        setSession("");
        setStep("receipt");
      } catch (e) {
        if (e instanceof ApiError && e.code === "session_expired") {
          // Ten-minute sessions: confirm the passkey again, then retry with the same key.
          setStep("passkey");
          setStart(null);
          throw new Error("Your sign-in expired. Enter your details and confirm your passkey again; your choice is kept.");
        }
        throw e;
      }
    });

  const allChosen = ballot ? ballot.questions.every((q) => choice[q.id]) : false;
  const label = (qid: string) => ballot?.questions.find((q) => q.id === qid)?.options.find((o) => o.id === choice[qid])?.label;

  if (step === "details" || (step === "passkey" && !start)) {
    return (
      <>
        <p className="meta">Step 1 of 3</p>
        <Heading step="details">{title || "Vote"}</Heading>
        <form onSubmit={begin}>
          <label>
            Invite code
            <span className="hint">It is already filled in if you used your invite link.</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </label>
          <label>
            Student number
            <span className="hint">As it appears on your student card.</span>
            <input value={studentNumber} onChange={(e) => setStudentNumber(e.target.value)} required autoComplete="off" autoCapitalize="characters" spellCheck={false} />
          </label>
          <Alert>{error}</Alert>
          <button type="submit" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
        </form>
        {/* A new tab, so what you have typed is not lost. */}
        <p className="hint">
          <a href="/privacy" target="_blank" rel="noopener">How your data is handled<span className="sr"> (opens in a new tab)</span></a>
        </p>
      </>
    );
  }

  if (step === "passkey") {
    return (
      <>
        <p className="meta">Step 2 of 3</p>
        <Heading step="passkey">{start!.mode === "register" ? "Set up your passkey" : "Confirm it is you"}</Heading>
        <p>
          {start!.mode === "register"
            ? "Your phone or computer will ask for your fingerprint, face or screen lock. This creates a passkey tied to your student number for this poll. We never receive your fingerprint or face."
            : "Use your fingerprint, face or screen lock to confirm it is you before you vote."}
        </p>
        <Alert>{error}</Alert>
        <button type="button" onClick={confirmPasskey} disabled={busy}>{busy ? "Waiting for your device…" : start!.mode === "register" ? "Create passkey" : "Confirm with passkey"}</button>
      </>
    );
  }

  if (step === "ballot" && ballot) {
    return (
      <>
        <p className="meta">Step 3 of 3</p>
        <Heading step="ballot">{ballot.title}</Heading>
        {ballot.description && <p>{ballot.description}</p>}
        <form onSubmit={(e) => { e.preventDefault(); setStep("review"); }}>
          {ballot.questions.map((q) => (
            <fieldset key={q.id}>
              <legend>{q.prompt}</legend>
              {q.options.map((o) => (
                <label key={o.id} className="choice">
                  <input type="radio" name={q.id} value={o.id} checked={choice[q.id] === o.id} onChange={() => setChoice({ ...choice, [q.id]: o.id })} />
                  <span>{o.label}</span>
                </label>
              ))}
            </fieldset>
          ))}
          <button type="submit" disabled={!allChosen}>Review my vote</button>
        </form>
      </>
    );
  }

  if (step === "review" && ballot) {
    return (
      <>
        <p className="meta">Step 3 of 3</p>
        <Heading step="review">Confirm your vote</Heading>
        <dl>
          {ballot.questions.map((q) => (
            <div key={q.id}>
              <dt>{q.prompt}</dt>
              <dd><strong>{label(q.id)}</strong></dd>
            </div>
          ))}
        </dl>
        <p>You cannot change your vote after this.</p>
        <Alert>{error}</Alert>
        <button type="button" onClick={cast} disabled={busy}>{busy ? "Casting…" : "Cast my vote"}</button>{" "}
        <button type="button" className="secondary" onClick={() => setStep("ballot")} disabled={busy}>Change my choice</button>
      </>
    );
  }

  return (
    <>
      <Heading step="receipt">{receipt ? "Your vote is in" : "You have already voted"}</Heading>
      {receipt ? (
        <>
          <p>This is your receipt. Keep it: once results are published you can use it to check that your ballot was counted.</p>
          <p className="receipt" data-testid="receipt">{receipt}</p>
          <CopyButton text={receipt} label="Copy receipt" />
          <p className="hint">
            The receipt is saved on this device. It does not say how you voted, but anyone who sees it together with the published results can find your ballot, so do not share it if your vote is private.
          </p>
          <Link className="button secondary" href={`/verify?poll=${id}&receipt=${receipt}`}>Check it after results are published</Link>
        </>
      ) : (
        <p>You have already voted in this poll. If you saved your receipt you can check it once results are published.</p>
      )}
    </>
  );
}
