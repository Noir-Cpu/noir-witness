import { useEffect, useRef, useState, type FormEvent } from "react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { api, ApiError, errorText } from "../api";
import { Link, useLocation } from "../router";
import { saveReceipt } from "../receipts";
import { Alert, CopyButton, Field, Heading } from "../ui";

type Start = { mode: "register" | "authenticate"; options: Record<string, unknown>; token: string };
type Ballot = { title: string; description: string; questions: { id: string; prompt: string; options: { id: string; label: string }[] }[]; hasVoted: boolean };
type Step = "details" | "passkey" | "ballot" | "review" | "receipt";

// What went wrong with the passkey step, in words a first-time voter can act on. The raw browser error names ("NotAllowedError")
// mean nothing to them. The student number is never part of any message.
export function passkeyProblem(e: unknown): string {
  if (e instanceof WebAuthnError) {
    switch (e.name) {
      case "NotAllowedError":
        return "The passkey prompt was cancelled or timed out. Nothing has been lost. Tap the button to try again, and when your phone asks, use your fingerprint, face, PIN or pattern.";
      case "InvalidStateError":
        return "This device already has a passkey for this poll. Tap the button again and choose to use it. If that does not work, ask your organiser to reset your passkey.";
      case "NotSupportedError":
      case "SecurityError":
        return "This browser or device could not create a passkey. Try the latest Chrome or Safari on a phone that has a screen lock (PIN, pattern, fingerprint or face) turned on.";
      case "AbortError":
        return "The passkey step was interrupted. Tap the button to try again.";
    }
  }
  if (e instanceof ApiError && e.code === "passkey_failed") {
    return "That passkey was not accepted. If you first set up your passkey on another phone or computer, use that one. Otherwise ask your organiser to reset it.";
  }
  return errorText(e);
}

const codeFromHash = (hash: string) => new URLSearchParams(hash.replace(/^#/, "")).get("code") ?? "";

export function Vote({ id }: { id: string }) {
  const { hash } = useLocation();
  const [step, setStep] = useState<Step>("details");
  const [title, setTitle] = useState("");
  const [pollStatus, setPollStatus] = useState<"unknown" | "draft" | "open" | "closed" | "missing">("unknown");
  const [code, setCode] = useState(codeFromHash(hash));
  const [studentNumber, setStudentNumber] = useState("");
  const [start, setStart] = useState<Start | null>(null);
  const [session, setSession] = useState("");
  const [ballot, setBallot] = useState<Ballot | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState("");
  const [published, setPublished] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string>("");

  useEffect(() => {
    api<{ title: string; status: "draft" | "open" | "closed"; published: boolean }>(`/polls/${id}`)
      .then((p) => {
        setTitle(p.title);
        setPollStatus(p.status);
        setPublished(p.published);
      })
      .catch((e) => (e instanceof ApiError && e.status === 404 ? setPollStatus("missing") : setError(errorText(e))));
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
      setError(passkeyProblem(e));
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

  if (pollStatus === "missing") {
    return (
      <>
        <Heading>We could not find this poll</Heading>
        <p>This link does not match any poll. Check that you copied the whole link from your organiser, or ask them to send it again.</p>
      </>
    );
  }

  if (step === "details" || (step === "passkey" && !start)) {
    return (
      <>
        <p className="meta">Step 1 of 3</p>
        <Heading step="details">{title || "Vote"}</Heading>
        {pollStatus === "draft" && <p className="warning" role="note">This poll has not opened yet. Come back to this link when your organiser says voting is open.</p>}
        {pollStatus === "closed" && (
          <p className="warning" role="note">
            Voting in this poll has closed. {published ? <Link href={`/results/${id}`}>See the results</Link> : "The organiser has not published the results yet."}
          </p>
        )}
        <form onSubmit={begin}>
          <Field
            label="Invite code"
            name="invite-code"
            hint="It is already filled in if you used your invite link."
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="next"
          />
          <Field
            label="Student number"
            name="student-number"
            hint="As it appears on your student card."
            value={studentNumber}
            onChange={(e) => setStudentNumber(e.target.value)}
            required
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="go"
          />
          <Alert>{error}</Alert>
          <button type="submit" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
        </form>
        {/* A new tab, so what you have typed is not lost. */}
        <p className="hint">
          <a className="tap" href="/privacy" target="_blank" rel="noopener">How your data is handled<span className="sr"> (opens in a new tab)</span></a>
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
        {!browserSupportsWebAuthn() && (
          <p className="warning" role="note">
            This browser cannot use passkeys. Open the invite link in the latest Chrome or Safari on a phone that has a screen lock turned on.
          </p>
        )}
        <Alert>{error}</Alert>
        <p role="status" className="sr">{busy ? "Waiting for your device to confirm the passkey." : ""}</p>
        <button type="button" onClick={confirmPasskey} disabled={busy}>{busy ? "Waiting for your device…" : start!.mode === "register" ? "Create passkey" : "Confirm with passkey"}</button>{" "}
        <button type="button" className="secondary" onClick={() => { setStart(null); setError(""); setStep("details"); }} disabled={busy}>Change my details</button>
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
          <p>Your ballot is recorded. This is your receipt. Copy it or take a screenshot now: once results are published you can use it to check that your ballot was counted.</p>
          <p className="receipt" data-testid="receipt" translate="no">{receipt}</p>
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
