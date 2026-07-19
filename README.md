# Promo QA Automation

Serverless QA for Shopify banner scheduling. Every 10 minutes, Supabase checks
Emil's incomplete Asana tasks whose names look like promo/banner QA, reads the
linked theme's `templates/index.json` through Shopify Theme Access, and asks
Claude to interpret varying task and theme schemas.

- Confident pass: completes the QA task.
- Failure or ambiguity: leaves the task open and comments with the exact
  differences, mentioning the task creator.
- Unknown store or processing error: emails Emil when SMTP is configured.

## Safety

- Theme Access tokens are encrypted in Postgres using a key held only in Edge
  Function secrets.
- The browser-facing Supabase roles cannot read `stores` or `qa_runs`.
- Dry runs never complete tasks, comment, email, or write run history.
- Claude identifies fields, but code independently re-reads and exactly compares
  the mapped dates and links before permitting completion.

## Configure and deploy

Requirements: Node 20+, Supabase CLI, a Supabase project, Asana PAT, Anthropic
API key, one Shopify Theme Access token per store, and optional SMTP details.

1. Copy `.env.example` to `.env.local` and fill the local values. Generate
   `STORE_TOKEN_ENCRYPTION_KEY` as a long random value and keep it stable.

2. Link the intended Supabase project and apply migrations:

   ```powershell
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```

3. Set Edge Function secrets:

   ```powershell
   supabase secrets set ASANA_ACCESS_TOKEN="..." ANTHROPIC_API_KEY="..." STORE_TOKEN_ENCRYPTION_KEY="..."
   supabase secrets set SMTP_HOST="..." SMTP_PORT="587" SMTP_SECURE="false" SMTP_USER="..." SMTP_PASS="..." SMTP_FROM="..." ALERT_EMAIL_TO="..."
   ```

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied to hosted Edge
   Functions automatically.

4. Register each store. The token stays in `.env.local` and is encrypted before
   storage:

   ```powershell
   npm run store:seed -- power-planter-augers power-planter-augers.myshopify.com
   ```

5. Deploy:

   ```powershell
   supabase functions deploy qa-runner
   ```

6. Add the project URL and anon key to Supabase Vault so `pg_cron` can invoke
   the JWT-protected function:

   ```sql
   select vault.create_secret(
     'https://YOUR_PROJECT_REF.supabase.co',
     'promo_qa_project_url'
   );
   select vault.create_secret(
     'YOUR_SUPABASE_ANON_KEY',
     'promo_qa_anon_key'
   );
   ```

   The migration schedules `public.invoke_promo_qa_runner()` every 10 minutes.
   Until both Vault values exist, it safely skips runs with a database warning.

## Verify before enabling writes

Run unit tests:

```powershell
npm test
```

Dry-run one Asana task against the deployed or locally served function:

```powershell
npm run qa:local -- 1215994997303258
```

Set `SUPABASE_FUNCTION_URL=http://127.0.0.1:54321/functions/v1/qa-runner` to
target `supabase functions serve`. The request always sends
`dryRun: true, force: true`.

## Add another store

Add its local token using the normalized variable name:

```dotenv
SHOPIFY_THEME_ACCESS__NEW_STORE=shptka_...
```

Then run:

```powershell
npm run store:seed -- new-store new-store.myshopify.com
```

No code or redeployment is required.
