# Privacy notice: WITNESS polls

> **DRAFT.** Written from what the code actually stores. It is not legal advice. Before a real poll, fill in every `[bracket]`, have the society's information officer read it, and remove this box. Open decisions are listed at the end of this file.

**Version:** 0.1 draft · **Last updated:** [date]

## 1. Who is responsible

- **Responsible party (the one who decides to run the poll and who may vote):** [Name of society], the poll organiser.
- **Operator (runs the WITNESS service on the society's behalf):** John Balogun.
- **Contact for privacy questions:** [email address]. **Information officer:** [name and email].

## 2. What we process, and why

### If you vote

| What | Why | How it is kept |
| --- | --- | --- |
| Your **student number**, which you type in | To check you are on the list of people allowed to vote | The organiser uploaded the list. WITNESS stores each number only as a salted hash, never as plain text, and does not log it. A student number is short, so a determined attacker with a copy of the database could still guess matches; see "Limits". |
| A **passkey** created on your device | To make sure the person voting is the person who first used that student number in this poll | We store the passkey's public key and an identifier. Your fingerprint, face or PIN never leaves your device and we never receive it. |
| A record that **you voted**, with the **hour** (not the minute) | To stop anyone voting twice | Kept on the "who voted" side. It holds no choices. |
| Your **choices**, with a random **receipt code** | To count the vote and let you check it was counted | Kept on the "what was voted" side with no name, student number, timestamp or reference to you. The two sides are deliberately not linked. |
| Your **IP address and browser details** | These are seen by the hosting network (Cloudflare) when your device connects | WITNESS does not store them. Voter pages do not run analytics or error-reporting scripts. |

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
- Operational monitoring (Grafana Cloud for performance traces, Sentry for error reports) is used on organiser and public pages only, never on voting pages. They receive no ballot choices, student numbers or invite codes. [Confirm after the code change: voter and receipt-check pages load no analytics or error-reporting scripts.]

Transferring data outside South Africa is covered by section 72 of POPIA: these providers are bound by contract and their regions have data-protection rules that are similar in purpose. [Society to confirm.]

## 5. How long we keep it

- **Voter list, passkeys and "who voted" records:** erased [90] days after the poll closes, or earlier if the organiser clicks "Erase voter data". [Confirm the period.]
- **Published ballots, totals and signature:** kept, anonymously, for as long as the result needs to be checkable.
- **Organiser account data and audit log:** until the organiser asks for deletion, or [2] years after their last poll, whichever comes first.
- **Hosting logs:** short-lived and held by Cloudflare under its own terms.

## 6. Your rights

You can ask us to tell you what we hold about you, to correct it, or to delete it, and you can object to its use. Because the database holds your student number only as a hash, we can answer a request only if you give us your number; we cannot look you up by name. Your ballot cannot be identified at all, by design, so we cannot tell you what you voted or remove one ballot.

Write to [email address]. If you are not satisfied, you may complain to the Information Regulator (South Africa): https://inforegulator.org.za (see the website for current contact details).

## 7. Limits you should know about

- A student number is not a strong secret; printed cards and group chats expose it. If someone else knows your number and the poll's invite code, they could try to vote as you before you do. The first person to register a passkey for a number holds it.
- If you show someone your receipt code, you can prove how you voted. Do not share it if you want your vote to stay private.
- Someone with full access to the server, the database and its logs could try to match "who voted" to "what was voted". WITNESS makes this hard (no timestamps on ballots, random receipts, results sorted by receipt) but does not make it impossible. See the project's design notes on GitHub.
- WITNESS is for society and club votes. It must not be used for public or government elections.
- With fewer than 10 eligible voters, results reveal a lot about how individuals voted.

## 8. Security

Connections use HTTPS. Student numbers are stored hashed. Choices and identities are stored apart. Secrets are held outside the code. No system is perfectly secure.

## Decisions needed before a real poll

- [ ] Who is the responsible party: the society (recommended) or John personally? Put the name in section 1.
- [ ] Name and contact for the information officer.
- [ ] Retention period for the voter list and "who voted" records (draft says 90 days).
- [ ] Does the society have written permission to hold a student-number list and share it with the operator? (Needed from the organiser.)
- [ ] Confirm that voter pages run no analytics or error scripts (needs the code change).
- [ ] Have someone with POPIA experience read this once.
