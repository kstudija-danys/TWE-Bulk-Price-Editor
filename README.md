# Bulk Price Editor (TWE)

Embedded Shopify admin app for bulk price changes: rule-based edits (percent,
fixed amount, set value) by collection/tag/vendor/product type or manual
selection, CSV upload for explicit per-variant pricing, scheduling, and
one-click revert.

## Stack

- [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix) (Polaris + App Bridge, OAuth handled by `@shopify/shopify-app-remix`)
- MySQL via Prisma (`prisma/schema.prisma`)
- A separate background worker (`worker/index.ts`) polls the database every
  minute for due scheduled jobs and due auto-reverts, and applies them via
  the Admin GraphQL API.

## Local development

1. Copy `.env.example` to `.env` and fill in `SHOPIFY_API_KEY`,
   `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, and `DATABASE_URL` (your MySQL
   connection string).
2. `npm install`
3. `npx prisma migrate dev` (first run: creates the schema in your DB)
4. `npm run dev` — runs the Shopify CLI dev tunnel + Remix app
5. In a second terminal: `npm run worker` — runs the scheduler/reverter loop
   against the same database

## Deploying to Render

`render.yaml` defines two services from this one repo:

- `bulk-price-editor-web` — the Remix app (Dockerfile-based)
- `bulk-price-editor-worker` — same image, runs `npm run docker-start-worker`
  instead, which just runs the worker loop

Push this repo to Render via the Blueprint flow (New > Blueprint, pick this
repo), then set the env-group secrets (`DATABASE_URL`, `SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`) in the Render dashboard for both
services. Update the app URL and redirect URLs in the Shopify Partner
Dashboard to match the deployed `bulk-price-editor-web` URL.

## Key files

- `app/lib/pricing.ts` — pure price-rule math (percent/fixed/setvalue)
- `app/lib/shopifyAdmin.server.ts` — batched/retried Admin GraphQL variant
  price mutations, plus variant-resolution queries (by filter, by id, by sku)
- `app/lib/jobs.server.ts` — job lifecycle: preview, create, execute (with a
  concurrency guard against overlapping running jobs), revert
- `app/routes/app.jobs.new.tsx` — new price change wizard
- `app/routes/app.jobs.$id.tsx` — job detail + revert
- `app/routes/app.csv.tsx` — CSV upload flow
- `worker/index.ts` — standalone cron-poll process for scheduled jobs/reverts
