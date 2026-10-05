# Privacy notice: WITNESS polls

> **DRAFT.** Written from what the code actually stores. It is not legal advice. Before a real poll, fill in every highlighted placeholder, have the society's information officer read it, and remove this box. Open decisions are listed at the end of the source file, docs/PRIVACY-NOTICE.md.

**Version:** 0.1 draft · **Last updated:** [date]

## 1. Who is responsible

- **Responsible party (the one who decides to run the poll and who may vote):** {{society}}, the poll organiser.
- **Operator (runs the WITNESS service on the society's behalf):** John Balogun.
- **Information officer and contact for privacy questions:** {{officer}}, {{email}}.

## 2. What we process, and why

### If you vote

| What | Why | How it is kept |
| --- | --- | --- |
| Your **student number**, which you type in | To check you are on the list of people allowed to vote | The organiser uploaded the list. WITNESS stores each number only as a salted hash, never as plain text, and does not log it. A student number is short, so a determined attacker with a copy of the database could still guess matches; see "Limits". |
| A **passkey** created on your device | To make sure the person voting is the person who first used that student number in this poll | We store the passkey's public key and an identifier. Your fingerprint, face or PIN never leaves your device and we never receive it. |
| A record that **you voted**, with the **hour** (not the minute) | To stop anyone voting twice | Kept on the "who voted" side. It holds no choices. |
| Your **choices**, with a random **receipt code** | To count the vote and let you check it was counted | Kept on the "what was voted" side with no name, student number, timestamp or reference to you. The two sides are deliberately not linked. |
| Your **IP address and browser details** | These are seen by the hosting network (Cloudflare) when your device connects. WITNESS also counts sign-in attempts per IP address, and per student number in a keyed hash that cannot be turned back into the number, for about a minute, to stop guessing attacks | WITNESS does not store them or write them to its database or logs. The counters are held by Cloudflare's rate limiter and expire. Voter pages (the invite link and the receipt check) load no analytics or error-reporting scripts at all. |

### If you are an organiser

| What | Why |
| --- | --- |
| Your GitHub name, email address, avatar and account id, and the sign-in tokens GitHub gives us | To sign you in and to know who created and ran each poll |
| The IP address and browser details of your sign-in sessions | Security and fraud prevention (stored by the sign-in system) |
| A log of what you did (created a poll, uploaded a list, opened, closed, published) | Accountability. It never records what anyone voted or who voted. |

## 3. What becomes public

When the organiser publishes a poll, anyone can see: the poll and its questions, **every ballot's choices with its receipt code**, the totals, how many people were eligible, how many voted, and a digital signature over all of it.

This is how anyone can check the count. It does not include names, student numbers or voting times. Because it is a permanent public record whose integrity depends on being complete, **individual ballots cannot be removed after publishing.**

## 4. Who else handles the data

- **Cloudflare** (hosting and network). Data passes through and is processed on servers that may be outside South Africa.
- **Neon** (database), in Frankfurt, Germany.
- **GitHub** (organiser sign-in only).
- **Sentry** (error reports) and **PostHog** (counts of page views, without cookies) run in your browser on the organiser and public pages (home, results, this notice). They do **not** run on the voting page or the receipt-check page, so your invite code, student number and receipt never reach them. On the pages where they run, the part of the address after `?` or `#` is removed before anything is sent.
- **Grafana Cloud** receives performance traces from the server. Each trace holds only the request type, the route pattern (for example `/api/vote/:pollId/start`), the status code and the time taken. Never an invite code, student number, receipt or choice.
- Server-side error reports (Sentry) leave out request bodies, cookies and sign-in headers.

Transferring data outside South Africa is covered by section 72 of POPIA: these providers are bound by contract and their regions have data-protection rules that are similar in purpose. The society's information officer confirms this reading.

## 5. How long we keep it

- **Voter list, passkeys and "who voted" records:** erased automatically {{retentionDays}} days after the poll closes (a daily job does this), or earlier if the organiser clicks "Erase voter data" on a closed poll. Erasing removes the hashed student numbers, the stored passkeys and the record of who voted. The organiser's poll page states the date.
- **Published ballots, totals and signature:** kept, anonymously, for as long as the result needs to be checkable. They are never erased by the above. The total number of eligible voters and the number who voted are part of the signed result and also stay.
- **Records of the erasure:** the organiser's log notes that voter data was erased, when, and how many entries, with no names or numbers.
- **Organiser account data and audit log:** until the organiser asks for deletion, or [2] years after their last poll, whichever comes first.
- **Hosting logs:** short-lived and held by Cloudflare under its own terms.

## 6. Your rights

You can ask us to tell you what we hold about you, to correct it, or to delete it, and you can object to its use. Because the database holds your student number only as a hash, we can answer a request only if you give us your number; we cannot look you up by name. Once a poll's voter data has been erased there is nothing left to look up or correct. Your ballot cannot be identified at all, by design, so we cannot tell you what you voted or remove one ballot.

Write to {{email}}. If you are not satisfied, you may complain to the Information Regulator (South Africa): https://inforegulator.org.za (see the website for current contact details).

## 7. Limits you should know about

- A student number is not a strong secret; printed cards and group chats expose it. If someone else knows your number and the poll's invite code, they could try to vote as you before you do. The first person to register a passkey for a number holds it.
- If you show someone your receipt code, you can prove how you voted. Do not share it if you want your vote to stay private.
- Someone with full access to the server, the database and its logs could try to match "who voted" to "what was voted". WITNESS makes this hard (no timestamps on ballots, random receipts, results sorted by receipt) but does not make it impossible. See the project's design notes on GitHub.
- WITNESS is for society and club votes. It must not be used for public or government elections.
- With fewer than 10 eligible voters, results reveal a lot about how individuals voted.

## 8. Security

Connections use HTTPS. Student numbers are stored hashed. Choices and identities are stored apart. Repeated sign-in attempts from one address or for one student number are slowed down. Secrets are held outside the code. No system is perfectly secure.

## Decisions needed before a real poll

These are for the person publishing the notice and are not shown on the website.

Settled: the responsible party is the Stellenbosch Developer Society, with John Balogun as operator; the information officer and privacy contact is Willie Loftie-Eaton; voter data is kept 30 days after close. The name, email and retention days appear on the page from one file, `apps/web/src/notice-config.ts` (the text here uses `{{society}}`, `{{officer}}`, `{{email}}` and `{{retentionDays}}`). The 30 days must equal `PURGE_DAYS` in `apps/api/wrangler.toml`; a test checks the code default against that file.

- [ ] Written permission from the society to hold a student-number list and share it with the operator (John is getting this by WhatsApp).
- [ ] Fill the `[date]` in "Last updated" and the `[2]` years for organiser account data in section 5.
- [ ] Information officer to confirm the cross-border wording in section 4.
- [ ] Remove the draft box, then run `PRIVACY_STRICT=1 npm test -w @noir/web` to check no placeholder is left; set the repository variable `PRIVACY_STRICT=1` to enforce it in CI.
- [ ] Have someone with POPIA experience read this once.
