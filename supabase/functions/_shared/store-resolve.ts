import type { AnthropicClient } from "./ai.ts";
import {
  extractStoreSlugFromText,
  stripHtml,
} from "./asana.ts";
import type { AsanaTask, TaskContext } from "./types.ts";

export interface RegisteredStore {
  store_slug: string;
  shop_domain: string;
  display_name?: string | null;
}

export interface StoreResolution {
  store_slug: string | null;
  method: "editor_url" | "shopify_admin_url" | "text_match" | "ai" | null;
  confidence: number;
  reason?: string;
}

export function matchStoreFromText(
  text: string,
  stores: RegisteredStore[],
): string | null {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return null;

  for (const store of stores) {
    const slug = store.store_slug.toLowerCase();
    const displayName = store.display_name?.trim().toLowerCase();
    const domainPrefix = store.shop_domain.replace(/\.myshopify\.com$/, "").toLowerCase();

    if (normalized.includes(slug)) return store.store_slug;
    if (displayName && displayName.length > 2 && normalized.includes(displayName)) {
      return store.store_slug;
    }
    if (domainPrefix.length > 2 && normalized.includes(domainPrefix)) {
      return store.store_slug;
    }
  }

  return null;
}

export function resolveStoreFromContext(
  context: TaskContext,
  stores: RegisteredStore[],
): StoreResolution {
  if (context.editorTarget?.storeSlug) {
    return {
      store_slug: context.editorTarget.storeSlug,
      method: "editor_url",
      confidence: 1,
      reason: "Shopify theme editor URL",
    };
  }

  const textParts = [
    context.task.name,
    stripHtml(context.task.notes ?? context.task.html_notes ?? ""),
    context.parent?.name,
    stripHtml(context.parent?.notes ?? context.parent?.html_notes ?? ""),
    ...(context.task.projects?.map((project) => project.name) ?? []),
    ...(context.parent?.projects?.map((project) => project.name) ?? []),
  ].filter(Boolean);

  const combined = textParts.join("\n");
  const fromShopify = extractStoreSlugFromText(combined);
  if (fromShopify) {
    const registered = stores.find((store) => store.store_slug === fromShopify);
    return {
      store_slug: registered?.store_slug ?? fromShopify,
      method: fromShopify === registered?.store_slug ? "editor_url" : "shopify_admin_url",
      confidence: registered ? 0.95 : 0.75,
      reason: registered
        ? "Shopify admin URL matched a registered store"
        : "Shopify admin URL detected",
    };
  }

  for (const part of textParts) {
    const matched = matchStoreFromText(part, stores);
    if (matched) {
      return {
        store_slug: matched,
        method: "text_match",
        confidence: 0.8,
        reason: "Matched store name or slug in task context",
      };
    }
  }

  return { store_slug: null, method: null, confidence: 0 };
}

export async function resolveStoreSlug(
  context: TaskContext,
  stores: RegisteredStore[],
  anthropic: AnthropicClient,
): Promise<StoreResolution> {
  const heuristic = resolveStoreFromContext(context, stores);
  if (heuristic.store_slug) return heuristic;
  if (!stores.length) return heuristic;

  const inference = await anthropic.inferStoreSlug({
    taskName: context.task.name,
    parentName: context.parent?.name,
    taskNotes: stripHtml(context.task.notes ?? context.task.html_notes ?? ""),
    parentNotes: stripHtml(context.parent?.notes ?? context.parent?.html_notes ?? ""),
    projectNames: [
      ...(context.task.projects?.map((project) => project.name) ?? []),
      ...(context.parent?.projects?.map((project) => project.name) ?? []),
    ],
    stores: stores.map((store) => ({
      store_slug: store.store_slug,
      display_name: store.display_name ?? null,
      shop_domain: store.shop_domain,
    })),
  });

  if (!inference.store_slug || inference.confidence < 0.7) {
    return {
      store_slug: null,
      method: null,
      confidence: inference.confidence,
      reason: inference.reason,
    };
  }

  const registered = stores.find((store) => store.store_slug === inference.store_slug);
  if (!registered) {
    return {
      store_slug: null,
      method: null,
      confidence: inference.confidence,
      reason: `${inference.reason} (not a registered store)`,
    };
  }

  return {
    store_slug: registered.store_slug,
    method: "ai",
    confidence: inference.confidence,
    reason: inference.reason,
  };
}
