const endpoint = "/.netlify/functions/admin";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = new URL(endpoint, window.location.origin);
  const [route, query = ""] = path.split("?", 2);
  url.searchParams.set("path", route);
  for (const [key, value] of new URLSearchParams(query)) {
    url.searchParams.append(key, value);
  }
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(data.error || "Request failed", response.status);
  }
  return data as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });

export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
