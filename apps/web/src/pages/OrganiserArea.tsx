import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Organiser } from "./Organiser";
import { PollAdmin } from "./PollAdmin";

// Everything an organiser needs (data fetching, sign-in client, poll screens) is one chunk that voters never download.
const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

export default function OrganiserArea({ id }: { id?: string }) {
  return <QueryClientProvider client={client}>{id ? <PollAdmin id={id} key={id} /> : <Organiser />}</QueryClientProvider>;
}
