// The five comments Ergonia posts on a GitHub issue, verbatim from
// docs/roadmap/github-integration-spec.md. Placeholders are substituted;
// nothing else moves. Every comment ends with the constant footer.
// No em-dash anywhere (public text rule).

const FOOTER =
  "-- Posted by the Ergonia bounties GitHub App because this issue carries the maintainer's `ergonia-bounty` label. " +
  "What Ergonia is, and which accounts and apps it operates, is listed at https://ergonia.works/api/official. " +
  "This app never opens, reviews, or merges pull requests.";

export type CommentKind = "opened" | "submission" | "accepted" | "rejected" | "expired" | "label_removed";

export function openedComment(p: { task_url: string; reward: number; expiry_utc: string }): string {
  return [
    `This issue is now an Ergonia task at ${p.task_url}.`,
    "",
    "Anyone can submit a pull request that fixes it. The acceptance condition is: your pull request references this issue and has every required Check run green on its head commit. When that is true, Ergonia's steward accepts your submission automatically (see the verifier at https://ergonia.works/api/verifiers/github-checks).",
    "",
    `Reward: ${p.reward} Ergonia credits. Expires ${p.expiry_utc}.`,
    "",
    "Ergonia never opens, comments on, or merges pull requests here; it only reads Check conclusions. Your maintainer keeps every review decision.",
    "",
    FOOTER,
  ].join("\n");
}

export function submissionComment(p: {
  pr_url: string;
  github_login: string;
  handle: string;
  member_url: string;
  head_sha: string;
}): string {
  return [
    `A submission has been recorded on this issue: ${p.pr_url} by @${p.github_login} (Ergonia member ${p.handle}, ${p.member_url}). The verifier will re-check on every green Check run reported on ${p.head_sha} until the pull request closes.`,
    "",
    FOOTER,
  ].join("\n");
}

export function acceptedComment(p: {
  reward: number;
  github_login: string;
  pr_url: string;
  head_sha: string;
  verdict_event_url: string;
  attest_url: string;
}): string {
  return [
    `Verdict: accepted. Ergonia credited ${p.reward} credits to @${p.github_login} for ${p.pr_url} passing every required Check on ${p.head_sha}. The public receipt is at ${p.verdict_event_url} and the chain head that includes it is at ${p.attest_url}.`,
    "",
    "Ergonia takes no position on whether you merge this pull request.",
    "",
    FOOTER,
  ].join("\n");
}

export function rejectedComment(p: { pr_url: string; reason: string; verdict_event_url: string }): string {
  return [
    `Verdict: rejected. The pull request ${p.pr_url} was closed without being merged; per the verifier, the task remains open for other submissions until it expires or is unlabelled. Reason on record: ${p.reason}. Public receipt: ${p.verdict_event_url}.`,
    "",
    FOOTER,
  ].join("\n");
}

export function expiredComment(p: { expiry_utc: string }): string {
  return [
    `This task expired at ${p.expiry_utc}. No submission passed the verifier before then. The label may be removed by the maintainer; re-adding it opens a fresh task.`,
    "",
    FOOTER,
  ].join("\n");
}

export function labelRemovedComment(): string {
  return [
    "The `ergonia-bounty` label was removed. This task is closed (state: `closed_by_label_removal`). Any in-flight submission is marked `superseded`. No credits move.",
    "",
    FOOTER,
  ].join("\n");
}

export { FOOTER as COMMENT_FOOTER };
