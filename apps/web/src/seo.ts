// What each route says about itself to a browser tab, a search engine and a screen reader. The same list of private
// paths is sent as an X-Robots-Tag header by site.ts; this is the in-page second layer for crawlers that run scripts.
export type Head = { title: string; description?: string; index: boolean; canonical?: string };

const HOME: Head = {
  title: "WITNESS: verifiable polls for societies and clubs",
  description: "Invite-only polls for societies and clubs. One ballot per voter, a receipt for every vote, and a tally anyone can recompute from one public file.",
  index: true,
  canonical: "/",
};

export function headFor(path: string): Head {
  if (path === "/") return HOME;
  if (path === "/privacy") {
    return {
      title: "Privacy notice | WITNESS",
      description: "What WITNESS stores when you vote, what it never stores, who can see it, and how long voter data is kept before it is erased.",
      index: true,
      canonical: "/privacy",
    };
  }
  if (/^\/vote(\/|$)/.test(path)) return { title: "Vote | WITNESS", index: false };
  if (/^\/verify(\/|$)/.test(path)) return { title: "Check a receipt | WITNESS", index: false };
  if (/^\/results(\/|$)/.test(path)) return { title: "Results | WITNESS", index: false };
  if (/^\/organiser(\/|$)/.test(path)) return { title: "Organise | WITNESS", index: false };
  return { title: "Page not found | WITNESS", index: false };
}

function meta(name: string, attr: "name" | "property" = "name") {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  return el;
}

// The public address the page declares for itself (set at build time in index.html), read once before any route removes
// it. Falls back to the current origin for local development.
let site: string | undefined;
const siteOrigin = () =>
  (site ??= (() => {
    try {
      return new URL(document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? location.href).origin;
    } catch {
      return location.origin;
    }
  })());

/** Applies a route's head to the document. Called on every client-side navigation. */
export function applyHead(h: Head, origin = siteOrigin()) {
  document.title = h.title;
  if (h.description) meta("description").content = h.description;
  meta("robots").content = h.index ? "index, follow" : "noindex, nofollow, noarchive";
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (h.canonical) {
    if (!link) {
      link = document.createElement("link");
      link.rel = "canonical";
      document.head.appendChild(link);
    }
    link.href = origin + h.canonical;
  } else link?.remove(); // a private page must not claim to be a copy of the home page
}
