import type { IncomingComment } from "./types.ts";

export const AUTOMATION_COMMENT_FINGERPRINTS = [
  "automated promo qa found configuration issues",
  "promo scheduler link in the task notes yet",
  "still need the shopify theme editor / promo scheduler link",
  "theme access is not configured yet for",
  "i ran qa on",
];

export function commentMentionsUser(
  comment: Pick<IncomingComment, "text" | "htmlText">,
  userGid: string,
): boolean {
  if (!userGid) return false;
  const html = comment.htmlText ?? "";
  const text = comment.text ?? "";
  if (html.includes(`data-asana-gid="${userGid}"`)) return true;
  if (text.includes(`/profile/${userGid}`)) return true;
  if (html.includes(`/profile/${userGid}`)) return true;
  return /(?:^|[\s>])@emil\b/i.test(text) || /@emil\b/i.test(html);
}

export function isAutomationComment(
  comment: Pick<IncomingComment, "text" | "authorGid">,
  automationAssigneeGid: string,
): boolean {
  if (comment.authorGid && comment.authorGid === automationAssigneeGid) {
    return true;
  }
  const text = comment.text.trim().toLowerCase();
  return AUTOMATION_COMMENT_FINGERPRINTS.some((needle) =>
    text.includes(needle)
  );
}

export function shouldListenToComment(
  comment: IncomingComment,
  automationAssigneeGid: string,
  options: { onQaTask: boolean },
): boolean {
  if (!comment.text.trim()) return false;
  if (isAutomationComment(comment, automationAssigneeGid)) return false;
  return options.onQaTask || commentMentionsUser(comment, automationAssigneeGid);
}

export function alreadyRepliedToComment(
  incoming: IncomingComment,
  laterComments: IncomingComment[],
  automationAssigneeGid: string,
): boolean {
  return laterComments.some((comment) =>
    comment.createdAt > incoming.createdAt &&
    comment.authorGid === automationAssigneeGid
  );
}

export function pickIncomingComment(
  comments: IncomingComment[],
  preferredStoryGid: string | undefined,
  automationAssigneeGid: string,
  qaTaskGid: string,
): IncomingComment | null {
  const ranked = comments
    .filter((comment) =>
      shouldListenToComment(comment, automationAssigneeGid, {
        onQaTask: comment.taskGid === qaTaskGid,
      })
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  if (preferredStoryGid) {
    const preferred = ranked.find((comment) => comment.gid === preferredStoryGid);
    if (preferred) return preferred;
  }

  return ranked[0] ?? null;
}
