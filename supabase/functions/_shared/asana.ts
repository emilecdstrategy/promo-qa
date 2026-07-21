import type {
  AsanaTask,
  PromoDesignComment,
  PromoDesignContext,
  PromoDesignSubtask,
  ShopifyEditorTarget,
  TaskContext,
} from "./types.ts";

const ASANA_API = "https://app.asana.com/api/1.0";
const TASK_FIELDS = [
  "name",
  "notes",
  "html_notes",
  "completed",
  "modified_at",
  "due_on",
  "due_at",
  "assignee.gid",
  "assignee.name",
  "projects.gid",
  "projects.name",
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
    if (creator) {
      await this.request(`/tasks/${taskGid}/addFollowers`, {
        method: "POST",
        body: JSON.stringify({ data: { followers: [creator.gid] } }),
      });
      // Asana recommends a short delay so a newly added follower receives the mention.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const text = creator
      ? `https://app.asana.com/0/${creator.gid}/list\n\n${message.trim()}`
      : message.trim();

    await this.request(`/tasks/${taskGid}/stories`, {
      method: "POST",
      body: JSON.stringify({ data: { text } }),
    });
  }

  async hasCommentContaining(taskGid: string, needle: string): Promise<boolean> {
    const normalizedNeedle = needle.trim().toLowerCase();
    if (!normalizedNeedle) return false;

    const query = new URLSearchParams({
      opt_fields: "type,text,html_text",
      limit: "100",
    });
    const stories = (await this.request<
      Array<{ type?: string; text?: string; html_text?: string }>
    >(`/tasks/${taskGid}/stories?${query}`)).data;

    return stories.some((story) => {
      if (story.type !== "comment") return false;
      const text = stripHtml(story.text ?? story.html_text ?? "").toLowerCase();
      return text.includes(normalizedNeedle);
    });
  }

  async completeTask(taskGid: string): Promise<void> {
    await this.request(`/tasks/${taskGid}`, {
      method: "PUT",
      body: JSON.stringify({ data: { completed: true } }),
    });
  }

  async getPromoDesignContext(parent: AsanaTask | null): Promise<PromoDesignContext> {
    if (!parent?.gid) {
      return { parentTask: null, subtasks: [], comments: [] };
    }

    const subtaskQuery = new URLSearchParams({
      opt_fields: "name,completed,notes,assignee.name",
      limit: "100",
    });
    const subtasks = (await this.request<
      Array<{
        name: string;
        completed?: boolean;
        notes?: string;
        assignee?: { name?: string };
      }>
    >(`/tasks/${parent.gid}/subtasks?${subtaskQuery}`)).data.map(
      (subtask): PromoDesignSubtask => ({
        name: subtask.name,
        completed: Boolean(subtask.completed),
        notes: stripHtml(subtask.notes ?? ""),
        assignee: subtask.assignee?.name,
      }),
    );

    const storyQuery = new URLSearchParams({
      opt_fields: "type,text,html_text,created_by.name",
      limit: "100",
    });
    const comments = (await this.request<
      Array<{
        type?: string;
        text?: string;
        html_text?: string;
        created_by?: { name?: string };
      }>
    >(`/tasks/${parent.gid}/stories?${storyQuery}`)).data
      .filter((story) => story.type === "comment")
      .map((story): PromoDesignComment => ({
        author: story.created_by?.name,
        text: stripHtml(story.text ?? story.html_text ?? ""),
      }))
      .filter((comment) => comment.text.trim().length > 0);

    return { parentTask: parent, subtasks, comments };
  }

  async listPromoQaSubtasksForParent(
    parentGid: string,
    assigneeGid: string,
  ): Promise<AsanaTask[]> {
    const query = new URLSearchParams({
      opt_fields: TASK_FIELDS,
      limit: "100",
    });
    const subtasks = (await this.request<AsanaTask[]>(
      `/tasks/${parentGid}/subtasks?${query}`,
    )).data;

    return subtasks.filter((task) =>
      !task.completed &&
      isPromoQaTask(task) &&
      task.assignee?.gid === assigneeGid
    );
  }

  async createProjectWebhook(
    projectGid: string,
    targetUrl: string,
  ): Promise<{ gid: string; secret: string | null; active: boolean }> {
    const response = await fetch(`${ASANA_API}/webhooks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          resource: projectGid,
          target: targetUrl,
          filters: [
            { resource_type: "task", action: "changed" },
            { resource_type: "task", action: "added" },
            { resource_type: "story", action: "added" },
          ],
        },
      }),
    });
    const payload = await response.json().catch(() => null) as
      | AsanaEnvelope<{ gid: string; active: boolean }>
      | null;
    if (!response.ok || !payload) {
      throw new AsanaApiError(
        payload?.errors?.[0]?.message ??
          `Asana webhook create failed (${response.status})`,
        response.status,
        payload,
      );
    }

    const secret = response.headers.get("X-Hook-Secret") ??
      (payload as AsanaEnvelope<{ gid: string; active: boolean }> & {
        "X-Hook-Secret"?: string;
      })["X-Hook-Secret"] ??
      null;

    return {
      gid: payload.data.gid,
      secret,
      active: payload.data.active,
    };
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

export function extractStoreSlugFromText(text: string): string | null {
  const fromEditor = parseShopifyEditorUrl(text)?.storeSlug;
  if (fromEditor) return fromEditor;

  const normalized = text.replaceAll("&amp;", "&");
  const match = normalized.match(
    /admin\.shopify\.com\/store\/([a-z0-9-]+)/i,
  );
  return match ? match[1].toLowerCase() : null;
}

export function stripHtml(value: string): string {
  let text = value;
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, String.fromCharCode(34));
  text = text.replace(/&#39;/g, String.fromCharCode(39));
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export async function verifyAsanaWebhookSignature(
  secret: string,
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!secret || !signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expected = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqualHex(expected, signature.trim().toLowerCase());
}

export async function verifyAsanaWebhookSignatureAgainstSecrets(
  secrets: string[],
  body: string,
  signature: string | null,
): Promise<boolean> {
  for (const secret of secrets) {
    if (await verifyAsanaWebhookSignature(secret, body, signature)) {
      return true;
    }
  }
  return false;
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
