import type { AsanaTask, ShopifyEditorTarget, TaskContext } from "./types.ts";

const ASANA_API = "https://app.asana.com/api/1.0";
const TASK_FIELDS = [
  "name",
  "notes",
  "html_notes",
  "completed",
  "modified_at",
  "due_on",
  "due_at",
  "parent.gid",
  "parent.name",
  "created_by.gid",
  "created_by.name",
].join(",");

interface AsanaEnvelope<T> {
  data: T;
  next_page?: { offset: string } | null;
  errors?: Array<{ message: string }>;
}

export class AsanaApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "AsanaApiError";
    this.status = status;
    this.details = details;
  }
}

export class AsanaClient {
  private readonly accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<AsanaEnvelope<T>> {
    const response = await fetch(`${ASANA_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const payload = await response.json().catch(() => null) as
      | AsanaEnvelope<T>
      | null;

    if (!response.ok || !payload) {
      throw new AsanaApiError(
        payload?.errors?.[0]?.message ??
          `Asana request failed (${response.status})`,
        response.status,
        payload,
      );
    }

    return payload;
  }

  async listIncompleteTasks(
    assigneeGid: string,
    workspaceGid: string,
  ): Promise<AsanaTask[]> {
    const tasks: AsanaTask[] = [];
    let offset: string | undefined;

    do {
      const query = new URLSearchParams({
        assignee: assigneeGid,
        workspace: workspaceGid,
        completed_since: "now",
        limit: "100",
        opt_fields: TASK_FIELDS,
      });
      if (offset) query.set("offset", offset);

      const page = await this.request<AsanaTask[]>(`/tasks?${query}`);
      tasks.push(...page.data.filter((task) => !task.completed));
      offset = page.next_page?.offset;
    } while (offset);

    return tasks;
  }

  async getTask(taskGid: string): Promise<AsanaTask> {
    const query = new URLSearchParams({ opt_fields: TASK_FIELDS });
    return (await this.request<AsanaTask>(`/tasks/${taskGid}?${query}`)).data;
  }

  async getCreator(
    task: AsanaTask,
  ): Promise<{ gid: string; name: string } | null> {
    if (task.created_by?.gid) return task.created_by;

    const query = new URLSearchParams({
      opt_fields: "created_at,created_by.gid,created_by.name,type",
      limit: "100",
    });
    const stories = (await this.request<
      Array<{
        created_at: string;
        created_by?: { gid: string; name: string };
      }>
    >(`/tasks/${task.gid}/stories?${query}`)).data;

    return stories
      .filter((story) => story.created_by?.gid)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
      ?.created_by ?? null;
  }

  async addQaComment(
    taskGid: string,
    creator: { gid: string; name: string } | null,
    message: string,
  ): Promise<void> {
    const mention = creator
      ? `<a data-asana-gid="${
        escapeHtml(creator.gid)
      }" data-asana-type="user" data-asana-dynamic="true" data-asana-accessible="true">@${
        escapeHtml(creator.name)
      }</a> `
      : "";
    const htmlText = `<body>${mention}${
      escapeHtml(message).replaceAll("\n", "<br>")
    }</body>`;

    if (creator) {
      await this.request(`/tasks/${taskGid}/addFollowers`, {
        method: "POST",
        body: JSON.stringify({ data: { followers: [creator.gid] } }),
      });
      // Asana recommends a short delay so a newly added follower receives the mention.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    await this.request(`/tasks/${taskGid}/stories`, {
      method: "POST",
      body: JSON.stringify({ data: { html_text: htmlText } }),
    });
  }

  async completeTask(taskGid: string): Promise<void> {
    await this.request(`/tasks/${taskGid}`, {
      method: "PUT",
      body: JSON.stringify({ data: { completed: true } }),
    });
  }

  async getTaskContext(taskGid: string): Promise<TaskContext> {
    const task = await this.getTask(taskGid);
    const parent = task.parent?.gid
      ? await this.getTask(task.parent.gid)
      : null;
    const editorTarget = parseShopifyEditorUrl(
      [task.notes, task.html_notes, parent?.notes, parent?.html_notes]
        .filter(Boolean)
        .join("\n"),
    );

    return {
      task,
      parent,
      creator: await this.getCreator(task),
      editorTarget,
    };
  }
}

export function daysUntilDue(task: Pick<AsanaTask, "due_on" | "due_at">): number | null {
  const dueValue = task.due_on ?? task.due_at?.slice(0, 10);
  if (!dueValue) return null;

  const dueDate = new Date(`${dueValue}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((dueDate.getTime() - today.getTime()) / 86_400_000);
}

export function isDueWithinDays(
  task: Pick<AsanaTask, "due_on" | "due_at">,
  days: number,
): boolean {
  const untilDue = daysUntilDue(task);
  if (untilDue === null) return false;
  return untilDue <= days;
}

export function isPromoQaTask(task: Pick<AsanaTask, "name">): boolean {
  return (
    /\b(?:banner|promo).{0,40}\bqa\b/i.test(task.name) ||
    /\bqa\b.{0,40}\b(?:banner|promo)\b/i.test(task.name)
  );
}

export function parseShopifyEditorUrl(
  text: string,
): ShopifyEditorTarget | null {
  const normalized = text.replaceAll("&amp;", "&");
  const match = normalized.match(
    /https:\/\/admin\.shopify\.com\/store\/([a-z0-9-]+)\/themes\/(\d+)\/editor[^\s<"]*/i,
  );
  if (!match) return null;

  const url = new URL(match[0]);
  const storeSlug = match[1].toLowerCase();
  return {
    url: url.toString(),
    storeSlug,
    shopDomain: `${storeSlug}.myshopify.com`,
    themeId: match[2],
    sectionHint: url.searchParams.get("section") ?? undefined,
    blockHint: url.searchParams.get("block") ?? undefined,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
