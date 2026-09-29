# ADR 0002: Passkeys instead of fingerprint hardware

Status: accepted

**Context.** The original idea was a fingerprint scanner module. Biometrics are special personal information under POPIA, and hardware costs money and time.

**Decision.** Voters authenticate with WebAuthn passkeys. The device unlocks the key with its own fingerprint or face; the server only ever receives a public key and signatures.

**Consequences.** No biometric data is stored or transmitted. Works on any modern phone and laptop. A voter without a passkey-capable device needs a fallback (a security key, or the organiser issues a one-time link). Not tested yet on the developer's own machine, so the flow must be proven in the pilot dry run.
