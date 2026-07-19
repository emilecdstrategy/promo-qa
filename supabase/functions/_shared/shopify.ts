import type { StoreCredential } from "./types.ts";

const THEME_ACCESS_ORIGIN = "https://theme-kit-access.shopifyapps.com";
const API_VERSION = "2024-10";

interface ThemeAssetResponse {
  asset?: {
    key: string;
    value?: string;
    theme_id: number;
  };
  errors?: unknown;
}

interface ThemeListResponse {
  themes?: Array<{
    id: number;
    name: string;
    role: "main" | "unpublished" | "demo" | "development";
  }>;
  errors?: unknown;
}

export class ShopifyThemeAccessError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "ShopifyThemeAccessError";
    this.status = status;
    this.details = details;
  }
}

function headers(store: StoreCredential): HeadersInit {
  return {
    Accept: "application/json",
    "X-Shopify-Access-Token": store.theme_access_token,
    "X-Shopify-Shop": store.shop_domain,
  };
}

async function themeAccessFetch<T>(
  store: StoreCredential,
  path: string,
): Promise<T> {
  const response = await fetch(
    `${THEME_ACCESS_ORIGIN}/cli/admin/api/${API_VERSION}${path}`,
    { headers: headers(store) },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ShopifyThemeAccessError(
      `Theme Access request failed (${response.status}) for ${store.shop_domain}`,
      response.status,
      payload,
    );
  }

  return payload as T;
}

function parseJsonTemplate(source: string): Record<string, unknown> {
  const withoutBannerComment = source.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
  return JSON.parse(withoutBannerComment) as Record<string, unknown>;
}

export async function getIndexJson(
  store: StoreCredential,
  themeId: string,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ "asset[key]": "templates/index.json" });
  const payload = await themeAccessFetch<ThemeAssetResponse>(
    store,
    `/themes/${encodeURIComponent(themeId)}/assets.json?${query}`,
  );

  if (!payload.asset?.value) {
    throw new ShopifyThemeAccessError(
      `templates/index.json was not returned for theme ${themeId}`,
      404,
      payload.errors,
    );
  }

  try {
    return parseJsonTemplate(payload.asset.value);
  } catch (error) {
    throw new ShopifyThemeAccessError(
      `templates/index.json is not valid JSON for theme ${themeId}`,
      422,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function listThemes(
  store: StoreCredential,
): Promise<NonNullable<ThemeListResponse["themes"]>> {
  const payload = await themeAccessFetch<ThemeListResponse>(
    store,
    "/themes.json?fields=id,name,role",
  );

  if (!payload.themes) {
    throw new ShopifyThemeAccessError(
      `Theme list was not returned for ${store.shop_domain}`,
      502,
      payload.errors,
    );
  }

  return payload.themes;
}

export async function getPublishedThemeId(
  store: StoreCredential,
): Promise<string> {
  const published = (await listThemes(store)).find((theme) =>
    theme.role === "main"
  );
  if (!published) {
    throw new ShopifyThemeAccessError(
      `No published theme found for ${store.shop_domain}`,
      404,
    );
  }

  return String(published.id);
}
