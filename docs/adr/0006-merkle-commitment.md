# ADR 0006: Merkle commitment instead of a hash chain

Status: accepted

**Context.** A hash chain over ballots in insertion order is easy to explain but records the order ballots arrived, which is exactly the information ADR 0005 removes.

**Decision.** At close, compute a Merkle root over leaves `SHA-256(poll_id || receipt || canonical(selections))` sorted by receipt. Sign the root with an Ed25519 key (WebCrypto is available on Workers). Publish root, signature and the full ballot list to a public repository.

**Consequences.** Anyone can recompute the root and the tally, and each voter can check that their receipt is a leaf. Tampering after close changes the root. The signing key is a Cloudflare secret in the MVP, so the operator is trusted not to sign a false root; this is stated in the README. Open question: whether to publish interim roots while a poll is open (they would not be consistent with each other).
