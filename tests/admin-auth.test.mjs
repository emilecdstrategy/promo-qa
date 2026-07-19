import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import test from "node:test";
import handler from "../netlify/functions/admin.mjs";

const password = "correct horse battery staple";
const salt = "test-salt";
process.env.ADMIN_PASSWORD_HASH =
  `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
process.env.ADMIN_SESSION_SECRET = "a".repeat(64);

test("rejects an incorrect dashboard password", async () => {
  const response = await handler(new Request(
    "https://promo-qa.netlify.app/.netlify/functions/admin?path=/login",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://promo-qa.netlify.app",
        "x-forwarded-for": "test-wrong-password",
      },
      body: JSON.stringify({ password: "wrong" }),
    },
  ));

  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /incorrect/i);
});

test("issues an HttpOnly session and validates it", async () => {
  const loginResponse = await handler(new Request(
    "https://promo-qa.netlify.app/.netlify/functions/admin?path=/login",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://promo-qa.netlify.app",
        "x-forwarded-for": "test-correct-password",
      },
      body: JSON.stringify({ password }),
    },
  ));

  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);

  const sessionResponse = await handler(new Request(
    "https://promo-qa.netlify.app/.netlify/functions/admin?path=/session",
    { headers: { Cookie: cookie.split(";")[0] } },
  ));
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).authenticated, true);
});

test("rejects cross-origin state-changing requests", async () => {
  const response = await handler(new Request(
    "https://promo-qa.netlify.app/.netlify/functions/admin?path=/login",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ password }),
    },
  ));
  assert.equal(response.status, 403);
});
