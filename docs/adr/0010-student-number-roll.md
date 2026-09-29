# ADR 0010: Eligibility is a roll of salted student-number hashes

Status: accepted

**Context.** Public elections stay out of scope because there is no real ID verification. Inside a university, a student number on a list the organiser holds is a reasonable eligibility check for a society vote. The organiser uploads a CSV; voters enter their number with the invite code.

**Decision.**
- The CSV's first column is read (a header row is skipped, duplicates are ignored, anything unparseable rejects the upload with the line numbers). At most 5,000 numbers.
- Each number is normalised (trimmed, upper-cased, inner whitespace removed) and stored as `HMAC-SHA256(key = per-poll random salt, number)`. The plain number is never stored or logged.
- The roll can only change while the poll is a draft. Opening it fixes the roll.

**What this proves.** The person voting knew the invite code and a student number that is on the organiser's list, and holds the passkey created when that number was first used.

**What it does not prove.** That the person is the student. Student numbers are printed on cards and shared casually. It also does not hide the roll from someone who steals the database: a student number is a short, guessable string, so a per-poll salted hash stops precomputed tables and matching across polls but not a brute-force run over plausible numbers. A slow hash (PBKDF2, scrypt) would resist that better, but 5,000 rows on the Workers CPU budget rules it out for now.

**Consequences.** A per-voter secret (a unique code per member) would be much stronger and can replace the shared code later, at the cost of the organiser distributing individual codes.
