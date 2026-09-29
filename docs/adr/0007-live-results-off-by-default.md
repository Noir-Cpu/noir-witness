# ADR 0007: Live results are off by default

Status: accepted

**Context.** The original spec asked for real-time results. Visible running tallies influence late voters, and they leak ordering information (ADR 0005).

**Decision.** Results are published when the poll closes. Live results are a per-poll setting, off by default, with a warning when enabled.

**Consequences.** Durable Objects for live tallies are deferred until the setting ships.
