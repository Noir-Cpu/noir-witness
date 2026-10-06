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

initTelemetry();

// A voter's phone needs React and the voter page. Organiser screens, receipt checking (which carries the bulletin
// verifier) and the privacy notice are separate chunks, fetched when their page is opened.
const OrganiserArea = lazy(() => import("./pages/OrganiserArea"));
const Verify = lazy(() => import("./pages/Verify").then((m) => ({ default: m.Verify })));
const Results = lazy(() => import("./pages/Results").then((m) => ({ default: m.Results })));
const Privacy = lazy(() => import("./pages/Privacy").then((m) => ({ default: m.Privacy })));

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
      <Suspense fallback={<p role="status">Loading…</p>}>
        <Routes />
      </Suspense>
    </Layout>
  </StrictMode>,
);
