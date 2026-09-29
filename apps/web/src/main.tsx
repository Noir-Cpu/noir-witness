import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { Organiser } from "./pages/Organiser";
import { PollAdmin } from "./pages/PollAdmin";
import { Vote } from "./pages/Vote";
import { Verify } from "./pages/Verify";
import { Results } from "./pages/Results";

initTelemetry();

const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

function Routes() {
  const { path } = useLocation();
  let m: RegExpMatchArray | null;
  if (path === "/") return <Home />;
  if (path === "/organiser") return <Organiser />;
  if ((m = path.match(/^\/organiser\/polls\/([0-9a-f-]{36})$/))) return <PollAdmin id={m[1]!} key={m[1]} />;
  if ((m = path.match(/^\/vote\/([0-9a-f-]{36})$/))) return <Vote id={m[1]!} key={m[1]} />;
  if ((m = path.match(/^\/results\/([0-9a-f-]{36})$/))) return <Results id={m[1]!} key={m[1]} />;
  if (path === "/verify") return <Verify />;
  return (
    <>
      <h1>Not found</h1>
      <p>There is nothing at this address.</p>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <Layout>
        <Routes />
      </Layout>
    </QueryClientProvider>
  </StrictMode>,
);
