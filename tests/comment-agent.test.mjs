import assert from "node:assert/strict";
import test from "node:test";
import {
  alreadyRepliedToComment,
  commentMentionsUser,
  isAutomationComment,
  pickIncomingComment,
  shouldListenToComment,
} from "../supabase/functions/_shared/comment-agent.ts";

const emil = "1206406200377321";

test("detects an Asana @mention of Emil", () => {
  assert.equal(
    commentMentionsUser({
      text: "https://app.asana.com/1/x/profile/1206406200377321 set for your QA",
      htmlText:
        `<body><a data-asana-gid="${emil}" data-asana-type="user"></a>set for your QA</body>`,
    }, emil),
    true,
  );
  assert.equal(
    commentMentionsUser({
      text: "Updated copy, no one tagged",
      htmlText: "<body>Updated copy, no one tagged</body>",
    }, emil),
    false,
  );
});

test("ignores automation comments from Emil", () => {
  assert.equal(
    isAutomationComment({
      text: "Automated promo QA found configuration issues: banner disabled",
      authorGid: emil,
    }, emil),
    true,
  );
  assert.equal(
    shouldListenToComment({
      gid: "1",
      taskGid: "qa",
      text: "Automated promo QA found configuration issues",
      createdAt: "2026-09-01T00:00:00.000Z",
      authorGid: emil,
      authorName: "Emil",
    }, emil, { onQaTask: true }),
    false,
  );
});

test("listens to teammate comments on the QA task or @Emil mentions", () => {
  const hugoOnQa = {
    gid: "2",
    taskGid: "qa",
    text: "set for your QA",
    createdAt: "2026-09-01T19:25:00.000Z",
    authorGid: "hugo",
    authorName: "Hugo",
  };
  assert.equal(shouldListenToComment(hugoOnQa, emil, { onQaTask: true }), true);
  assert.equal(
    shouldListenToComment({
      ...hugoOnQa,
      taskGid: "parent",
      htmlText: `<a data-asana-gid="${emil}" data-asana-type="user"></a>ready`,
    }, emil, { onQaTask: false }),
    true,
  );
  assert.equal(
    shouldListenToComment({
      ...hugoOnQa,
      taskGid: "parent",
      text: "Banner RFR",
    }, emil, { onQaTask: false }),
    false,
  );
});

test("does not re-reply after Emil already answered that comment", () => {
  const incoming = {
    gid: "3",
    taskGid: "qa",
    text: "@Emil can you check again?",
    createdAt: "2026-09-01T19:25:00.000Z",
    authorGid: "hugo",
    authorName: "Hugo",
  };
  assert.equal(
    alreadyRepliedToComment(incoming, [{
      ...incoming,
      gid: "4",
      text: "Checking now — the block is still disabled.",
      createdAt: "2026-09-01T19:26:00.000Z",
      authorGid: emil,
      authorName: "Emil",
    }], emil),
    true,
  );
});

test("prefers the webhook story when picking the incoming comment", () => {
  const picked = pickIncomingComment([
    {
      gid: "old",
      taskGid: "qa",
      text: "older ping",
      createdAt: "2026-09-01T10:00:00.000Z",
      authorGid: "hugo",
    },
    {
      gid: "new",
      taskGid: "qa",
      text: "set for your QA",
      createdAt: "2026-09-01T19:25:00.000Z",
      authorGid: "hugo",
    },
  ], "new", emil, "qa");
  assert.equal(picked?.gid, "new");
});
