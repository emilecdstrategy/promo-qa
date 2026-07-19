# Deploy Promo QA to your Supabase project

Project dashboard:
https://supabase.com/dashboard/project/bcmwdpvsmxuzsqrcooos

Project URL:
https://bcmwdpvsmxuzsqrcooos.supabase.co

Netlify site (landing page only):
https://promo-qa.netlify.app

## 1. Log into the Supabase account that owns this project

The local Supabase CLI must use the same account that created
`bcmwdpvsmxuzsqrcooos`. If `supabase link` says you lack privileges, run:

```powershell
supabase login
```

Then link:

```powershell
cd "C:\Users\Emil\Desktop\Web Dev stuff\kodence\github\QA-promos"
supabase link --project-ref bcmwdpvsmxuzsqrcooos
supabase db push
```

## 2. Fill `.env.local`

Copy values from Supabase → Project Settings → API:

```dotenv
SUPABASE_URL=https://bcmwdpvsmxuzsqrcooos.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
STORE_TOKEN_ENCRYPTION_KEY=generate-a-long-random-string-and-keep-it
ANTHROPIC_API_KEY=...
```

Keep your existing `ASANA_ACCESS_TOKEN` and Theme Access values.

## 3. Set Edge Function secrets

Use the same values as `.env.local`:

```powershell
supabase secrets set `
  ASANA_ACCESS_TOKEN="..." `
  ANTHROPIC_API_KEY="..." `
  STORE_TOKEN_ENCRYPTION_KEY="..."
```

Optional email alerts:

```powershell
supabase secrets set `
  SMTP_HOST="..." `
  SMTP_PORT="587" `
  SMTP_SECURE="false" `
  SMTP_USER="..." `
  SMTP_PASS="..." `
  SMTP_FROM="..." `
  ALERT_EMAIL_TO="your@email.com"
```

## 4. Deploy the function

```powershell
supabase functions deploy qa-runner
```

## 5. Register Power Planter store credentials

```powershell
npm run store:seed -- power-planter-augers power-planter-augers.myshopify.com
```

## 6. Enable cron

In Supabase SQL Editor, run:

```sql
select vault.create_secret(
  'https://bcmwdpvsmxuzsqrcooos.supabase.co',
  'promo_qa_project_url'
);

select vault.create_secret(
  'YOUR_SUPABASE_ANON_KEY',
  'promo_qa_anon_key'
);
```

## 7. Dry-run before live writes

```powershell
npm run qa:local -- 1215994997303258
```

This calls the deployed function with `dryRun: true` and does not complete
tasks or comment on Asana.

## Architecture note

Netlify is connected to GitHub for the landing page and repo hosting.
The QA worker itself runs on Supabase, not Netlify.
