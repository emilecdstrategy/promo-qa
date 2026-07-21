export interface StoreCredential {
  id: string;
  store_slug: string;
  shop_domain: string;
  theme_access_token: string;
  active: boolean;
}

export interface ShopifyEditorTarget {
  url: string;
  storeSlug: string;
  shopDomain: string;
  themeId: string;
  sectionHint?: string;
  blockHint?: string;
}

export interface AsanaTask {
  gid: string;
  name: string;
  notes?: string;
  html_notes?: string;
  completed?: boolean;
  modified_at?: string;
  due_on?: string | null;
  due_at?: string | null;
  assignee?: { gid: string; name?: string } | null;
  projects?: Array<{ gid: string; name?: string }>;
  parent?: { gid: string; name?: string } | null;
  created_by?: { gid: string; name: string } | null;
}

export interface TaskContext {
  task: AsanaTask;
  parent: AsanaTask | null;
  creator: { gid: string; name: string } | null;
  editorTarget: ShopifyEditorTarget | null;
}

export interface PromoDesignSubtask {
  name: string;
  completed: boolean;
  notes?: string;
  assignee?: string;
}

export interface PromoDesignComment {
  author?: string;
  text: string;
}

export interface PromoDesignContext {
  parentTask: AsanaTask | null;
  subtasks: PromoDesignSubtask[];
  comments: PromoDesignComment[];
}

export interface DesignReadinessAssessment {
  designed: boolean;
  confidence: number;
  summary: string;
  signals: string[];
}

export interface AsanaWebhookEvent {
  user?: { gid: string; name?: string };
  resource: { gid: string; resource_type: string; name?: string };
  action: string;
  parent?: { gid: string; resource_type: string; name?: string } | null;
  change?: { field?: string; action?: string; new_value?: unknown };
}

export interface AsanaWebhookPayload {
  events?: AsanaWebhookEvent[];
}

export interface ExpectedBanner {
  label: string;
  promo_link: string | null;
  start_date: string | null;
  end_date: string | null;
  copy: string | null;
}

export interface ParsedPromoSpec {
  banners: ExpectedBanner[];
  summary: string;
  timezone: string | null;
  confidence: number;
  ambiguities: string[];
}

export interface ThemeBlock {
  sectionId: string;
  sectionType: string;
  blockId: string;
  blockType: string;
  disabled: boolean;
  settings: Record<string, unknown>;
}

export interface CandidateMatch {
  expected: ExpectedBanner;
  block: ThemeBlock | null;
  matchScore: number;
  matchedBy: "block_hint" | "link" | "none";
}

export interface BannerVerdict {
  label: string;
  matched_block_id: string | null;
  start_field: string | null;
  end_field: string | null;
  link_field: string | null;
  found_start: string | null;
  found_end: string | null;
  found_link: string | null;
  ok: boolean;
  issues: string[];
}

export interface QaVerdict {
  passed: boolean;
  confidence: number;
  summary: string;
  banners: BannerVerdict[];
  warnings: string[];
}
