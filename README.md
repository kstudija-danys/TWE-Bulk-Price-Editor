# Bulk Price Editor (TWE)

Embedded Shopify admin app for bulk price changes: rule-based edits (percent,
fixed amount, set value) by collection/tag/vendor/product type or manual
selection, CSV upload for explicit per-variant pricing, scheduling, and
one-click revert.

## Stack

- [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix) (Polaris + App Bridge, OAuth handled by `@shopify/shopify-app-remix`)
- MySQL via Prisma (`prisma/schema.prisma`)
- Scheduling/auto-revert runs in-process inside the web service
  (`app/lib/scheduler.server.ts`, started once from `app/entry.server.tsx`) —
  no separate worker service. It polls the database every minute for due
  scheduled jobs and due auto-reverts.

## Local development

1. Copy `.env.example` to `.env` and fill in `SHOPIFY_API_KEY`,
   `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, and `DATABASE_URL` (your MySQL
   connection string).
2. `npm install`
3. `npx prisma db push` (first run: creates the schema in your DB — the
   shared-hosting MySQL user typically can't create a shadow database, so
   this project uses `db push` instead of `migrate dev`/`migrate deploy`)
4. `npm run dev` — runs the Shopify CLI dev tunnel + Remix app (the in-process
   scheduler starts automatically alongside it)

## Deploying to Render

`render.yaml` defines a single Web Service (`bulk-price-editor-web`,
Dockerfile-based) for this repo — deploy it as a regular Web Service (New >
Web Service, pick this repo) or via Blueprint, either works since there's
only one service. Set `DATABASE_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
and `SHOPIFY_APP_URL` in the Render dashboard. Update the app URL and
redirect URLs in the Shopify Partner Dashboard to match the deployed URL.

## Key files

- `app/lib/pricing.ts` — pure price-rule math (percent/fixed/setvalue)
- `app/lib/shopifyAdmin.server.ts` — batched/retried Admin GraphQL variant
  price mutations, plus variant-resolution queries (by filter, by id, by sku)
- `app/lib/jobs.server.ts` — job lifecycle: preview, create, execute (with a
  concurrency guard against overlapping running jobs), revert
- `app/routes/app.jobs.new.tsx` — new price change wizard
- `app/routes/app.jobs.$id.tsx` — job detail + revert
- `app/routes/app.csv.tsx` — CSV upload flow
- `app/lib/scheduler.server.ts` — in-process cron poll for scheduled jobs/reverts
