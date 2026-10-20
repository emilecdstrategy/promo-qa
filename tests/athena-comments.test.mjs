// The promo calendar (Athena) and Promo QA on the same Asana tasks.
//
// 2026-10-17: Athena's overdue nudge ("Just following up here...") on a PC
// Banner Upload QA task was answered by Promo QA as if a person had asked,
// tagging the ECD Digital Strategy account instead of Diana, the web person,
// and every reply went up twice. These pin the three fixes (Emil, 2026-10-20).
import assert from "node:assert/strict";
import test from "node:test";
import { isAutomationComment, isAthenaUser, pickIncomingComment } from "../supabase/functions/_shared/comment-agent.ts";
import { AsanaClient } from "../supabase/functions/_shared/asana.ts";

const emil = "1206406200377321";
const athena = "1217538698120026";
const diana = { gid: "1213222251682450", name: "Diana Vásquez" };
const nudge = {
  gid: "n1",
  taskGid: "qa",
  text: "Just following up here - this was due 2026-10-16 (1 day ago) and is still open. If it is already done, tick it off so the promo calendar picks it up.",
  createdAt: "2026-10-17T00:02:22.611Z",
  authorGid: athena,
  authorName: "ECD Digital Strategy",
};

test("Athena's account is recognised", () => {
  assert.equal(isAthenaUser(athena), true);
  assert.equal(isAthenaUser(diana.gid), false);
  assert.equal(isAthenaUser(null), false);
});

test("Athena's comments are never conversation, by author or by wording", () => {
  assert.equal(isAutomationComment(nudge, emil), true);
  assert.equal(isAutomationComment({ ...nudge, authorGid: "someone-else" }, emil), true, "the nudge's own words");
  assert.equal(isAutomationComment({ text: "anything at all", authorGid: athena }, emil), true, "anything from that account");
  assert.equal(isAutomationComment({ text: "Link is in the notes now", authorGid: diana.gid }, emil), false);
});

test("a nudge alone gets no reply; a person's comment after it still does", () => {
  assert.equal(pickIncomingComment([nudge], undefined, emil, "qa"), null);
  const person = { gid: "p1", taskGid: "qa", text: "Link added to the notes", createdAt: "2026-10-17T09:00:00.000Z", authorGid: diana.gid, authorName: diana.name };
  assert.equal(pickIncomingComment([nudge, person], undefined, emil, "qa")?.gid, "p1");
});

test("the person tagged is the web person: whoever has the parent (the Promo Banner)", async () => {
  const asana = new AsanaClient("test-token");
  const task = { gid: "qa", name: "PC - Banner Upload QA", created_by: { gid: athena, name: "ECD Digital Strategy" } };
  const parent = { gid: "banner", name: "PC - Promo Banner", assignee: diana, created_by: { gid: athena, name: "ECD Digital Strategy" } };
  assert.deepEqual(await asana.getCommentRecipient(task, parent, emil), diana);
});

test("never Athena's account, and never the account Promo QA runs as", async () => {
  const asana = new AsanaClient("test-token");
  asana.getCreator = async () => ({ gid: athena, name: "ECD Digital Strategy" });
  const task = { gid: "qa", name: "Banner Upload QA", created_by: { gid: athena, name: "ECD Digital Strategy" } };
  const parent = { gid: "banner", name: "Promo Banner", assignee: { gid: emil, name: "Emil" }, created_by: { gid: emil, name: "Emil" } };
  assert.equal(await asana.getCommentRecipient(task, parent, emil), null);
});

test("a task a person created, with no parent, still tags its creator", async () => {
  const asana = new AsanaClient("test-token");
  const hugo = { gid: "hugo", name: "Hugo" };
  assert.deepEqual(await asana.getCommentRecipient({ gid: "qa", name: "Promo QA", created_by: hugo }, null, emil), hugo);
});
