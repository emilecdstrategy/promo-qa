import {
  createHmac,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const loginAttempts = new Map();
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export default async (request) => {
  try {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") || "/";

    if (isMutation(request.method) && !sameOrigin(request)) {
      return json({ error: "Invalid request origin" }, 403);
    }

    if (path === "/login" && request.method === "POST") {
      return login(request);
    }
    if (path === "/logout" && request.method === "POST") {
      return json({ ok: true }, 200, {
        "Set-Cookie": clearSessionCookie(),
      });
    }

    const session = verifySession(readCookie(request, "promo_qa_session"));
    if (!session) return json({ error: "Authentication required" }, 401);
    if (path === "/session" && request.method === "GET") {
      return json({ authenticated: true, expiresAt: session.exp * 1000 });
    }

    return proxyToSupabase(request, path);
  } catch (error) {
    console.error(error);
    return json(
      { error: error instanceof Error ? error.message : "Unexpected error" },
      500,
    );
  }
};

async function login(request) {
  const ip = request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
  const attempt = loginAttempts.get(ip);
  const now = Date.now();
  if (attempt?.blockedUntil > now) {
    return json({ error: "Too many attempts. Try again shortly." }, 429);
  }

  const body = await request.json().catch(() => ({}));
  if (!verifyPassword(String(body.password || ""))) {
    const count = attempt?.windowStart > now - 15 * 60_000
      ? attempt.count + 1
      : 1;
    loginAttempts.set(ip, {
      count,
      windowStart: count === 1 ? now : attempt.windowStart,
      blockedUntil: count >= 5 ? now + 15 * 60_000 : 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    return json({ error: "Incorrect password" }, 401);
  }

  loginAttempts.delete(ip);
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  return json(
    { authenticated: true, expiresAt: expiresAt * 1000 },
    200,
    { "Set-Cookie": sessionCookie(signSession(expiresAt)) },
  );
}

async function proxyToSupabase(request, path) {
  const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const target = new URL(`${supabaseUrl}/functions/v1/admin-api${path}`);
  const incomingUrl = new URL(request.url);
  for (const [key, value] of incomingUrl.searchParams) {
    if (key !== "path") target.searchParams.append(key, value);
  }

  const headers = {
    "Content-Type": request.headers.get("content-type") || "application/json",
    "x-admin-api-secret": requiredEnv("ADMIN_API_SECRET"),
    "x-admin-user": "dashboard",
  };
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.text(),
  });
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ||
        "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function verifyPassword(password) {
  const [salt, expectedHex] = requiredEnv("ADMIN_PASSWORD_HASH").split(":");
  if (!salt || !expectedHex) throw new Error("Invalid ADMIN_PASSWORD_HASH");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signSession(expiresAt) {
  const payload = Buffer.from(JSON.stringify({ exp: expiresAt }))
    .toString("base64url");
  const signature = createHmac("sha256", requiredEnv("ADMIN_SESSION_SECRET"))
    .update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySession(value) {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", requiredEnv("ADMIN_SESSION_SECRET"))
    .update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    return Number(session.exp) > Date.now() / 1000 ? session : null;
  } catch {
    return null;
  }
}

function readCookie(request, name) {
  const cookies = request.headers.get("cookie") || "";
  for (const cookie of cookies.split(";")) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function sessionCookie(value) {
  return `promo_qa_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return "promo_qa_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

function isMutation(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}
