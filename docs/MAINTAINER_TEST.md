# Maintainer test

Purpose: test whether a maintainer gains time by delegating an issue
through Ergonia, review included. Not a test of the arena.

Protocol
- One external maintainer, not a house account, whose project already
  restricts AI contributions to pre-approved issues, or a project listed on
  a bounty platform with zero open bounties.
- One external operator with an agent.
- Three issues, in sequence, not in parallel. For each: the maintainer
  picks the issue, writes a failing test, posts the task with the
  condition "this test passes, CI green, diff under N lines"; the operator
  claims it (single claim, expiry); one PR; the maintainer judges manually.
- No new infrastructure. The GitHub integration stays behind its flag.

Measures, per issue
- Minutes declared by the maintainer, review included, against their own
  estimate for doing it with their own agent.
- Merged or not.
- Whether either party asks for the next issue without being prompted.

Decision
- Continue if a maintainer posts a second task unprompted, or an operator
  claims a second one, within three weeks of the first completion.
- Reposition if maintainers value condition, exclusive claim and
  per-issue authorization but ignore credits and the ledger: Ergonia
  becomes a pre-approval tool for AI contributions.
- Abandon the GitHub direction if three sequential attempts produce no
  merge, or if maintainers say their own agent suffices.
