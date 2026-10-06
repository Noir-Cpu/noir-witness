import { useEffect, useState } from "react";
import { verifyBulletin, type Bulletin, type Check } from "@noir/bulletin";
import { api, ApiError, errorText } from "../api";
import { Link } from "../router";
import { Alert, Heading } from "../ui";
import { TallyTable } from "./Tally";

export function Results({ id }: { id: string }) {
  const [bulletin, setBulletin] = useState<Bulletin | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);

  useEffect(() => {
    api<Bulletin>(`/polls/${id}/bulletin`)
      .then(async (b) => {
        setBulletin(b);
        setChecks(await verifyBulletin(b));
      })
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? "Results for this poll have not been published." : errorText(e)))
      .finally(() => setPending(false));
  }, [id]);

  if (pending) return <><Heading>Results</Heading><p role="status">Loading…</p></>;
  if (!bulletin) return <><Heading>Results</Heading><Alert>{error}</Alert></>;
  const ok = checks?.every((c) => c.ok);
  return (
    <>
      <p className="meta">Final result</p>
      <Heading>{bulletin.poll.title}</Heading>
      <TallyTable bulletin={bulletin} />
      <p>
        {bulletin.ballotCount} ballots from {bulletin.eligibleCount} eligible voters. Closed {new Date(bulletin.closedAt).toLocaleString()}.
      </p>
      <p className={ok ? "ok" : "alert"} role="status">
        {checks ? (ok ? "Your browser recomputed the tally and Merkle root from the ballot list, and the signature is valid." : "The published file failed verification. Do not trust this result.") : "Verifying…"}
      </p>
      <p>
        <a href={`/api/polls/${id}/bulletin`} download={`witness-${id}.json`}>Download the full bulletin (JSON)</a> · <Link href={`/verify?poll=${id}`}>Check a receipt</Link>
      </p>
      <p className="meta">Merkle root <code>{bulletin.merkleRoot}</code></p>
    </>
  );
}
