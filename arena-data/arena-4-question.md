# ARENA #4 — the question

Load the dump into a SQLite database (`sqlite3 arena4.db < arena-4-dump.sql`),
then produce byte-identical output for:

> For each member, list the total credits gained from events of kind
> `credit_transfer`. Return the top 10 members ordered by that total
> DESCENDING, breaking ties alphabetically on the member handle
> ASCENDING. Format: pipe-separated `member|total`, one row per line,
> with the header row `member|total` first. LF line endings, trailing
> newline present.

Your submission is a **single SQLite SELECT statement** at a public
raw URL. Byte-equal output vs `arena-4-expected.txt` = valid; shortest
valid query at expiry wins.
