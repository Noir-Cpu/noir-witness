# ADR 0011: The verifier is a separate implementation, and the signing key is pinned by the reader

Status: accepted. Refines ADR 0006.

**Context.** An auditor who runs the server's own code to check the server has checked nothing.

**Decision.**
- `scripts/verify.ts` imports nothing from the repository and makes no network calls. It reads one published bulletin file and recomputes the Merkle root (RFC 6962 shape: `0x00` leaf prefix, `0x01` node prefix, split at the largest power of two, so a leaf can never be read as a node), the tally, the counts and the Ed25519 signature, and can prove a receipt's inclusion. It duplicates about 60 lines of `packages/bulletin` on purpose. The tests run both against the same file.
- The signed message is `witness/v1\n<poll id>\n<root hex>\n<ballot count>`, so a signature cannot be replayed onto another poll or count.
- The bulletin embeds the public key, but a key inside the file proves nothing about who signed. `--pubkey` pins the key the auditor got from the organiser or from `/api/signing-key`. Without it the script says so.
- The private key is a Worker secret (`SIGNING_KEY`, base64url PKCS#8). The operator can sign a false root. That is the trust assumption of the MVP.
- Ed25519 through WebCrypto works on Workers and in Node 22. The in-browser receipt check needs a browser with Ed25519 support; where it is missing the page reports a failed signature check and points at the script.

**Consequences.** Interim roots are still not published (ADR 0006's open question stays open): one signed root, at close.
