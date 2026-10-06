import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Link, useLocation } from "./router";
import { applyHead, headFor } from "./seo";

// Moves focus to the page heading when a page or step changes, so screen-reader and keyboard users land on the new content.
export function Heading({ children, step }: { children: ReactNode; step?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), [step]);
  return (
    <h1 ref={ref} tabIndex={-1}>
      {children}
    </h1>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { path } = useLocation();
  useEffect(() => applyHead(headFor(path)), [path]);
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="bar">
        <Link href="/" className="brand">WITNESS</Link>
        <nav aria-label="Main">
          <Link href="/organiser">Organise</Link>
          <Link href="/verify">Check a receipt</Link>
        </nav>
      </header>
      <main id="main">{children}</main>
      <footer>
        <p>
          For societies, clubs and meetings. Not for public or government elections. Keeping a receipt lets you prove how you voted.
        </p>
        <nav aria-label="Footer">
          <Link href="/privacy">Privacy notice</Link>
        </nav>
      </footer>
    </>
  );
}

export const Alert = ({ children }: { children: ReactNode }) => (children ? <p role="alert" className="alert">{children}</p> : null);

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [note, setNote] = useState("");
  return (
    <>
      <button
        type="button"
        className="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setNote("Copied");
          } catch {
            setNote("Copy failed. Select the text and copy it by hand.");
          }
        }}
      >
        {label}
      </button>{" "}
      <span role="status" className="meta">{note}</span>
    </>
  );
}

/** A labelled input. The hint is a description, not part of the name, so a screen reader says "Student number, edit text" and then the hint. */
export function Field({ label, hint, ...input }: { label: string; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && <span className="hint" id={`${id}-hint`}>{hint}</span>}
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
    </div>
  );
}
