import { Link } from "../router";
import { Heading } from "../ui";

export function Home() {
  return (
    <>
      <p className="meta">Case 001</p>
      <Heading>Votes you can check</Heading>
      <p className="lede">
        Invite-only polls for societies and clubs. One ballot per voter, a receipt for every vote, and a tally that anyone can
        recompute from the published file.
      </p>
      <div className="cards">
        <section>
          <h2>I am running a vote</h2>
          <p>Sign in, upload your member list, share the invite link, close the poll and publish the result.</p>
          <Link className="button" href="/organiser">Organise a poll</Link>
        </section>
        <section>
          <h2>I am voting</h2>
          <p>Open the invite link your organiser sent you. You will need your student number and a device with a fingerprint, face or PIN unlock.</p>
        </section>
        <section>
          <h2>I voted and want to check</h2>
          <p>Once results are published, paste your receipt to see that your ballot is in the count.</p>
          <Link className="button secondary" href="/verify">Check a receipt</Link>
        </section>
      </div>
    </>
  );
}
