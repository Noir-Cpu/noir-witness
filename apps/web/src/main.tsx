import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@noir/ui/tokens.css";
import "./styles.css";
import { initTelemetry } from "./telemetry";
import { useLocation } from "./router";
import { Layout } from "./ui";
import { Home } from "./pages/Home";
import { Vote } from "./pages/Vote";
// Small pages that a voter reaches from the voter flow (notice, receipt check, results) load with the app: fetching them
// on demand made the page jump when they arrived (measured CLS 0.100 on the receipt page against 0.001).
import { Privacy } from "./pages/Privacy";
import { Verify } from "./pages/Verify";
import { Results } from "./pages/Results";

initTelemetry();

// A voter's phone needs React and the voter-facing pages. The organiser screens (data fetching, the sign-in client, poll
// management) are one chunk that voters never download.
const OrganiserArea = lazy(() => import("./pages/OrganiserArea"));

function Routes() {
  const { path } = useLocation();
  let m: RegExpMatchArray | null;
  if (path === "/") return <Home />;
  if (path === "/organiser") return <OrganiserArea />;
  if ((m = path.match(/^\/organiser\/polls\/([0-9a-f-]{36})$/))) return <OrganiserArea id={m[1]!} key={m[1]} />;
  if ((m = path.match(/^\/vote\/([0-9a-f-]{36})$/))) return <Vote id={m[1]!} key={m[1]} />;
  if ((m = path.match(/^\/results\/([0-9a-f-]{36})$/))) return <Results id={m[1]!} key={m[1]} />;
  if (path === "/verify") return <Verify />;
  if (path === "/privacy") return <Privacy />;
  return (
    <>
      <h1>Not found</h1>
      <p>There is nothing at this address.</p>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Layout>
      <Suspense fallback={<p role="status" className="route-pending">Loading…</p>}>
        <Routes />
      </Suspense>
    </Layout>
  </StrictMode>,
);
