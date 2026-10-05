import notice from "../../../../docs/PRIVACY-NOTICE.md?raw";
import { Markdown } from "../markdown";
import { Heading } from "../ui";

// The notice is the Markdown file in docs/, imported at build time so there is one source. The maintainer's checklist
// at the end of that file ("Decisions needed...") is not part of the public notice.
export const publicNotice = notice.split(/^## Decisions needed before a real poll/m)[0]!;

export function Privacy() {
  return (
    <div className="prose">
      <Heading>Privacy notice</Heading>
      <Markdown source={publicNotice} />
    </div>
  );
}
