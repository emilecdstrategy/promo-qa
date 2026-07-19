const storeSlug = process.argv[2] ?? "power-planter-augers";
const shopDomain = process.argv[3] ?? `${storeSlug}.myshopify.com`;
const envSuffix = storeSlug.toUpperCase().replaceAll("-", "_");
const token = process.env[`SHOPIFY_THEME_ACCESS__${envSuffix}`];

if (!token) {
  throw new Error(
    `Missing SHOPIFY_THEME_ACCESS__${envSuffix} in .env.local`,
  );
}

const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const encryptionKey = required("STORE_TOKEN_ENCRYPTION_KEY");

const response = await fetch(`${supabaseUrl}/rest/v1/rpc/register_promo_qa_store`, {
  method: "POST",
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    p_store_slug: storeSlug,
    p_shop_domain: shopDomain,
    p_theme_access_token: token,
    p_encryption_key: encryptionKey,
  }),
});

if (!response.ok) {
  throw new Error(`Store seed failed (${response.status}): ${await response.text()}`);
}

console.log(`Registered ${shopDomain} with encrypted Theme Access credentials.`);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env.local`);
  return value;
}
