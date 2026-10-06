import { WebAuthnError } from "@simplewebauthn/browser";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { passkeyProblem } from "./pages/Vote";

const webauthn = (name: string) => new WebAuthnError({ message: "raw browser text", code: "ERROR_CEREMONY_ABORTED", cause: Object.assign(new Error("x"), { name }), name } as never);

describe("passkey failures are explained in plain language", () => {
  it("says what happened and what to do, never the browser's error name", () => {
    for (const name of ["NotAllowedError", "InvalidStateError", "NotSupportedError", "SecurityError", "AbortError"]) {
      const text = passkeyProblem(webauthn(name));
      expect(text, name).not.toMatch(/Error|exception|undefined|raw browser text/);
      expect(text, name).toMatch(/\b(try|ask|tap|use|open)\b/i);
    }
  });

  it("explains a server refusal of the passkey, and passes other messages through", () => {
    expect(passkeyProblem(new ApiError(403, "passkey_failed", "The passkey could not be verified"))).toMatch(/ask your organiser/);
    expect(passkeyProblem(new ApiError(0, "network", "Could not reach the server. Check your connection and try again."))).toMatch(/Could not reach the server/);
    expect(passkeyProblem(new Error("boom"))).toBe("boom");
  });
});
