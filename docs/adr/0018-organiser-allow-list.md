# ADR 0018: Optional allow-list of organisers

Status: accepted

**Context.** Organiser sign-in is GitHub through Better Auth. Anyone with a GitHub account can sign in, and every signed-in user could create polls and upload rolls. They could not see anyone else's poll, but they could fill the database, and on a deployment used for a real vote there is no reason to let strangers in.

**Decision.** The Worker variable or secret `ORGANISERS_ALLOWED_GITHUB_IDS` holds comma-separated numeric GitHub user ids.
- Unset or blank: unchanged behaviour, any signed-in user may organise.
- Set: only users with a linked `github` account whose `account_id` is listed may use `/api/organiser/*`; everyone else gets 403 `not_approved` with a plain message, and `/api/me` answers 403 so the organiser page can show "Not an approved organiser". The check runs on every request, so removing an id takes effect at once for an open session.
- Set but with no usable id (a typo, a login name instead of a number): nobody is approved. It fails closed.
- The id is the number GitHub assigns to the account, not the login name, which can be changed or re-registered. Only the `github` provider counts. Voters and public pages are not affected.

**Consequences.** One extra query per organiser request when the list is set. The list lives in Cloudflare, not in the repository (SETUP.md has the commands). It limits who may organise; it does not make the organiser trustworthy: whoever controls the roll still controls who can vote (README, "What the eligibility check proves").
