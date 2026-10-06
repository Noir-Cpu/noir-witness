import { useState, type FormEvent } from "react";
import { verifyBulletin, proveReceipt, type Bulletin, type Check } from "@noir/bulletin";
import { api, ApiError, errorText } from "../api";
import { useLocation } from "../router";
import { forgetReceipts, savedReceipts } from "../receipts";
import { Alert, Field, Heading } from "../ui";

type Outcome = { checks: Check[]; found: null | { ok: boolean; position: number; size: number; labels: string[] } };

export async function checkPublished(pollId: string, receipt: string): Promise<{ bulletin: Bulletin; outcome: Outcome }> {
  const bulletin = await api<Bulletin>(`/polls/${pollId}/bulletin`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) throw new Error("Results have not been published for this poll yet.");
    throw e;
  });
  const checks = await verifyBulletin(bulletin);
  const proof = receipt ? await proveReceipt(bulletin, receipt) : null;
  const labels = proof
    ? proof.selections.map(([q, o]) => {
        const question = bulletin.poll.questions.find((x) => x.id === q);
        return `${question?.prompt}: ${question?.options.find((x) => x.id === o)?.label}`;
      })
    : [];
  return {
    bulletin,
    outcome: { checks, found: receipt ? (proof ? { ok: proof.ok, position: proof.index + 1, size: proof.size, labels } : { ok: false, position: 0, size: 0, labels: [] }) : null },
  };
}

export function Verify() {
  const { search } = useLocation();
  const [pollId, setPollId] = useState(search.get("poll") ?? "");
  const [receipt, setReceipt] = useState(search.get("receipt") ?? "");
  const [result, setResult] = useState<{ bulletin: Bulletin; outcome: Outcome } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(savedReceipts());

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await checkPublished(pollId.trim(), receipt.trim().toLowerCase()));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const allOk = result?.outcome.checks.every((c) => c.ok);
  return (
    <>
      <Heading>Check a receipt</Heading>
      <p className="lede">
        After results are published, this page downloads the public ballot list and checks, in your browser, that it adds up and that your receipt is in it. It does not send your receipt anywhere.
      </p>
      {saved.length > 0 && (
        <section aria-labelledby="saved">
          <h2 id="saved">Receipts saved on this device</h2>
          <ul className="list">
            {saved.map((r) => (
              <li key={r.receipt}>
                <span>{r.title}</span>
                <button type="button" className="secondary small" onClick={() => { setPollId(r.pollId); setReceipt(r.receipt); }}>Use this</button>
              </li>
            ))}
          </ul>
          <button type="button" className="secondary small" onClick={() => { forgetReceipts(); setSaved([]); }}>Forget saved receipts</button>
        </section>
      )}
      <form onSubmit={submit}>
        <Field label="Poll ID" hint="In the results link your organiser shared." value={pollId} onChange={(e) => setPollId(e.target.value)} required spellCheck={false} autoComplete="off" />
        <Field label="Receipt" hint="Leave blank to check the whole count without a receipt." value={receipt} onChange={(e) => setReceipt(e.target.value)} spellCheck={false} autoComplete="off" />
        <Alert>{error}</Alert>
        <button type="submit" disabled={busy}>{busy ? "Checking…" : "Check"}</button>
      </form>
      {result && (
        <section aria-labelledby="out" aria-live="polite">
          <h2 id="out">{allOk && (result.outcome.found?.ok ?? true) ? "Everything checks out" : "Something does not check out"}</h2>
          {result.outcome.found && (
            <p className={result.outcome.found.ok ? "ok" : "alert"} data-testid="receipt-result">
              {result.outcome.found.ok
                ? `Your receipt is in the count (ballot ${result.outcome.found.position} of ${result.outcome.found.size} in receipt order). It was counted as: ${result.outcome.found.labels.join("; ")}.`
                : "This receipt is not in the published ballot list."}
            </p>
          )}
          <ul className="checks">
            {result.outcome.checks.map((c) => (
              <li key={c.name}><span aria-hidden="true">{c.ok ? "✓" : "✗"}</span> <span className="sr">{c.ok ? "Passed: " : "Failed: "}</span>{c.name}</li>
            ))}
          </ul>
          <p className="hint">
            The signature check proves the file matches what the server signed, not who the signer is. Compare the key with the one published by your organiser: <code>{result.bulletin.publicKey}</code>. To check without trusting this page, run <code>node scripts/verify.ts bulletin.json --receipt …</code> from the source repository.
          </p>
        </section>
      )}
    </>
  );
}
