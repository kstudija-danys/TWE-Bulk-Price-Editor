import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Badge,
  DataTable,
  Banner,
  ProgressBar,
  Checkbox,
  Button,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  applyMissingMarketPricesInBackground,
  applyToNewProductsInBackground,
  canApplyMissingMarketPrices,
  canApplyToNewProducts,
  findNewMatches,
  isJobActiveInThisProcess,
  pricingOptionsOf,
  resumeJobInBackground,
  revertJob,
} from "../lib/jobs.server";
import { describeAdvancedFilter, SYNC_INTERVAL_MINUTES } from "../lib/filters";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const job = await prisma.priceJob.findFirst({
    where: { id: params.id, shopName: session.shop },
    include: { items: { include: { marketPrices: true } } },
  });

  if (!job) throw new Response("Not found", { status: 404 });

  return {
    job: {
      id: job.id,
      name: job.name,
      status: job.status,
      mode: job.mode,
      targetField: job.targetField,
      filterType: job.filterType,
      filterValue: job.filterValue,
      value: job.value?.toString() ?? null,
      options: pricingOptionsOf(job),
      filterSummary:
        job.filterType === "advanced" && job.filterValue
          ? describeAdvancedFilter(job.filterValue)
          : null,
      runAt: job.runAt?.toISOString() ?? null,
      revertAt: job.revertAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
      errorMessage: job.errorMessage,
      // "running" in the DB but not being worked on by the server: it was cut off.
      isStuck: job.status === "running" && !isJobActiveInThisProcess(job.id),
      // Ran before market fixed prices (e.g. UK GBP) were supported.
      needsMarketPrices: canApplyMissingMarketPrices(
        job,
        job.items.filter((i) => i.status === "applied").length,
      ),
      skipExistingCompareAt: job.skipExistingCompareAt,
      canApplyToNewProducts: canApplyToNewProducts(job),
      autoApplyNewProducts: job.autoApplyNewProducts,
      lastSyncedAt: job.lastSyncedAt?.toISOString() ?? null,
      items: job.items.map((i) => ({
        id: i.id,
        sku: i.sku,
        oldPrice: i.oldPrice.toString(),
        newPrice: i.newPrice.toString(),
        oldCompareAtPrice: i.oldCompareAtPrice?.toString() ?? null,
        newCompareAtPrice: i.newCompareAtPrice?.toString() ?? null,
        status: i.status,
        errorMessage: i.errorMessage,
        marketPrices: i.marketPrices.map((m) => ({
          marketName: m.marketName,
          currency: m.currency,
          oldPrice: m.oldPrice.toString(),
          newPrice: m.newPrice.toString(),
          status: m.status,
          errorMessage: m.errorMessage,
        })),
      })),
    },
  };
};

type NewMatchRow = {
  product: string;
  sku: string | null;
  oldPrice: number;
  newPrice: number;
  newCompareAtPrice: number | null;
};

type RevertActionResponse = {
  ok: boolean;
  intent?: "revert" | "resume" | "markets" | "findNew" | "applyNew" | "autoApply";
  result?: { succeeded: string[]; failed: { variantId: string; error: string }[] };
  newMatches?: { count: number; rows: NewMatchRow[] };
  error?: string;
};

const NEW_MATCH_ROWS = 50;

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<RevertActionResponse> => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "resume") {
    const job = await prisma.priceJob.findFirst({
      where: { id: params.id, shopName: session.shop },
    });
    if (!job || job.status !== "running" || isJobActiveInThisProcess(job.id)) {
      return { ok: false, intent: "resume", error: "This job isn't stuck, so there's nothing to resume." };
    }
    console.log(`[resume] resuming job ${job.id}`);
    resumeJobInBackground(session.shop, job.id);
    return { ok: true, intent: "resume" };
  }

  const intent = formData.get("intent");
  if (intent === "findNew" || intent === "applyNew" || intent === "autoApply") {
    const job = await prisma.priceJob.findFirst({
      where: { id: params.id, shopName: session.shop },
    });
    if (!job) return { ok: false, intent, error: "Job not found." };

    if (intent === "autoApply") {
      const enabled = formData.get("enabled") === "true";
      await prisma.priceJob.update({
        where: { id: job.id },
        // Clearing lastSyncedAt makes the scheduler check within a minute.
        data: { autoApplyNewProducts: enabled, ...(enabled ? { lastSyncedAt: null } : {}) },
      });
      return { ok: true, intent };
    }

    if (!canApplyToNewProducts(job) || isJobActiveInThisProcess(job.id)) {
      return {
        ok: false,
        intent,
        error: "This job can't be applied to new products right now (it must be completed and not reverted).",
      };
    }

    if (intent === "findNew") {
      try {
        const matches = await findNewMatches(admin, job.id);
        return {
          ok: true,
          intent,
          newMatches: {
            count: matches.length,
            rows: matches.slice(0, NEW_MATCH_ROWS).map((m) => ({
              product:
                m.variantTitle && m.variantTitle !== "Default Title"
                  ? `${m.productTitle} — ${m.variantTitle}`
                  : m.productTitle ?? "—",
              sku: m.sku,
              oldPrice: m.oldPrice,
              newPrice: m.newPrice,
              newCompareAtPrice: m.newCompareAtPrice,
            })),
          },
        };
      } catch (error) {
        return { ok: false, intent, error: error instanceof Error ? error.message : String(error) };
      }
    }

    applyToNewProductsInBackground(session.shop, job.id);
    return { ok: true, intent };
  }

  if (formData.get("intent") === "markets") {
    const job = await prisma.priceJob.findFirst({
      where: { id: params.id, shopName: session.shop },
      include: { items: { where: { status: "applied" }, select: { id: true } } },
    });
    if (!job || !canApplyMissingMarketPrices(job, job.items.length)) {
      return { ok: false, intent: "markets", error: "Market prices for this job are already handled." };
    }
    console.log(`[markets] applying missing market prices for job ${job.id}`);
    applyMissingMarketPricesInBackground(
      session.shop,
      job.id,
      formData.get("skipExistingCompareAt") === "true",
    );
    return { ok: true, intent: "markets" };
  }

  console.log(`[revert] POST received for job ${params.id}`);
  try {
    const result = await revertJob(admin, params.id as string);
    console.log(`[revert] success: ${result?.succeeded?.length} succeeded, ${result?.failed?.length} failed`);
    return { ok: true, intent: "revert", result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[revert] error for job ${params.id}:`, message);
    return { ok: false, intent: "revert", error: message };
  }
};

const STATUS_TONE: Record<string, "info" | "success" | "critical" | "warning" | "attention"> = {
  draft: "info",
  scheduled: "attention",
  running: "warning",
  completed: "success",
  reverted: "info",
  failed: "critical",
};

export default function JobDetail() {
  const { job } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const revalidator = useRevalidator();

  const canRevert = job.status === "completed";
  const isReverting = fetcher.state !== "idle";

  // A job started with "Apply" runs in the background; it is "draft" for a
  // moment and then "running" until every variant has been processed.
  const isActive = job.status === "running" || (job.status === "draft" && !job.runAt);
  const isInProgress = isActive && !job.isStuck;
  const marketRows = job.items.flatMap((i) => i.marketPrices);
  const totalCount = job.items.length + marketRows.length;
  const processedCount =
    job.items.filter((i) => i.status !== "pending").length +
    marketRows.filter((m) => m.status !== "pending").length;
  const errorCount =
    job.items.filter((i) => i.status === "error").length +
    marketRows.filter((m) => m.status === "error").length;
  const progressPercent = totalCount ? Math.round((processedCount / totalCount) * 100) : 0;
  const [skipMarketCompareAt, setSkipMarketCompareAt] = useState(true);

  // Keep refreshing while running; also while stuck, so the warning clears
  // as soon as a resume has picked the job up.
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [isActive, revalidator]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok) return;
    const { intent } = fetcher.data;
    if (intent === "findNew") return;
    if (intent === "applyNew" || intent === "autoApply") {
      shopify.toast.show(
        intent === "applyNew" ? "Applying to new products" : "Auto-apply setting saved",
      );
      revalidator.revalidate();
    } else if (intent === "resume" || intent === "markets") {
      shopify.toast.show(intent === "resume" ? "Resuming job" : "Updating market prices");
      revalidator.revalidate();
    } else {
      shopify.toast.show("Job reverted");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  return (
    <Page>
      <TitleBar title={job.name || `Price change — ${job.filterType}`}>
        {canRevert && (
          <button
            variant="primary"
            tone="critical"
            onClick={() => fetcher.submit({ intent: "revert" }, { method: "POST" })}
            disabled={isReverting}
          >
            Revert
          </button>
        )}
      </TitleBar>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <InlineSummary job={job} />
            {isInProgress && (
              <BlockStack gap="100">
                <ProgressBar progress={progressPercent} tone="primary" />
                <Text as="p" tone="subdued">
                  Updating prices… {processedCount} of {totalCount} prices done
                  {marketRows.length ? ` (incl. ${marketRows.length} market prices)` : ""}
                  {errorCount > 0 ? ` (${errorCount} failed)` : ""}. You can leave this
                  page — the job keeps running.
                </Text>
              </BlockStack>
            )}
            {job.isStuck && (
              <Banner
                tone="critical"
                title="This job was interrupted"
                action={{
                  content: "Resume job",
                  loading: isReverting,
                  onAction: () => fetcher.submit({ intent: "resume" }, { method: "POST" }),
                }}
              >
                The server stopped while this job was running, so only some prices were
                changed. Resume checks each variant's current price in Shopify: ones already
                changed are marked done, ones still at the old price are updated, and any
                changed by someone else are skipped.
              </Banner>
            )}
            {job.needsMarketPrices && (
              <Banner
                tone="warning"
                title="Market prices weren't changed"
                action={{
                  content: "Update market prices",
                  loading: isReverting,
                  onAction: () =>
                    fetcher.submit(
                      { intent: "markets", skipExistingCompareAt: String(skipMarketCompareAt) },
                      { method: "POST" },
                    ),
                }}
              >
                <BlockStack gap="200">
                  <Text as="p">
                    This job ran before the app handled markets with their own fixed prices
                    (e.g. UK prices in GBP), so those markets still show the old prices. This
                    applies the same change to them for every variant this job updated, and
                    Revert will restore them too.
                  </Text>
                  <Checkbox
                    label="Skip market prices that already have a compare-at price"
                    checked={skipMarketCompareAt}
                    onChange={setSkipMarketCompareAt}
                  />
                </BlockStack>
              </Banner>
            )}
            {job.errorMessage && <Banner tone="warning">{job.errorMessage}</Banner>}
            {fetcher.data && !fetcher.data.ok && (
              <Banner tone="critical">{fetcher.data.error}</Banner>
            )}
          </BlockStack>
        </Card>

        {(job.canApplyToNewProducts || job.autoApplyNewProducts) && job.status !== "reverted" && (
          <NewProductsCard job={job} fetcher={fetcher} busy={isReverting || isActive} />
        )}

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Variants ({job.items.length})
            </Text>
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "text", "text"]}
              headings={[
                "SKU",
                "Old price",
                "New price",
                "Old compare-at",
                "New compare-at",
                "Market fixed prices",
                "Status",
              ]}
              rows={job.items.map((item) => [
                item.sku ?? "—",
                Number(item.oldPrice).toFixed(2),
                Number(item.newPrice).toFixed(2),
                item.oldCompareAtPrice ? Number(item.oldCompareAtPrice).toFixed(2) : "—",
                item.newCompareAtPrice ? Number(item.newCompareAtPrice).toFixed(2) : "—",
                item.marketPrices.length
                  ? item.marketPrices
                      .map(
                        (m) =>
                          `${m.marketName}: ${Number(m.oldPrice).toFixed(2)} → ${Number(m.newPrice).toFixed(2)} ${m.currency} (${m.status})`,
                      )
                      .join("; ")
                  : "—",
                item.status,
              ])}
            />
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

function InlineSummary({ job }: { job: ReturnType<typeof useLoaderData<typeof loader>>["job"] }) {
  return (
    <BlockStack gap="100">
      <Text as="p">
        <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
      </Text>
      <Text as="p">{describeRule(job)}</Text>
      {job.filterSummary && (
        <Text as="p" tone="subdued">
          Products: {job.filterSummary}
        </Text>
      )}
      <Text as="p" tone="subdued">
        Created {new Date(job.createdAt).toLocaleString()}
      </Text>
      {job.runAt && (
        <Text as="p" tone="subdued">
          Scheduled for {new Date(job.runAt).toLocaleString()}
        </Text>
      )}
      {job.revertAt && (
        <Text as="p" tone="subdued">
          Auto-revert at {new Date(job.revertAt).toLocaleString()}
        </Text>
      )}
    </BlockStack>
  );
}

const TARGET_LABEL: Record<string, string> = {
  price: "price",
  compareAtPrice: "compare-at price",
  both: "price and compare-at price",
};

const ROUNDING_LABEL: Record<string, string> = {
  "99": "rounded to .99",
  "95": "rounded to .95",
  "00": "rounded to whole numbers",
  "5": "rounded to the nearest 5",
};

function describeRule(job: ReturnType<typeof useLoaderData<typeof loader>>["job"]): string {
  const v = Number(job.value);
  const target = TARGET_LABEL[job.targetField] ?? job.targetField;
  let rule: string;
  switch (job.mode) {
    case "percent":
      rule = `${v > 0 ? "+" : ""}${v}% on ${target}`;
      break;
    case "fixed":
      rule = `${v > 0 ? "+" : ""}${v.toFixed(2)} on ${target}`;
      break;
    case "setvalue":
      rule = `Set ${target} to ${v.toFixed(2)}`;
      break;
    case "compareAtMarkup":
      rule = `Compare-at = price + ${v}%`;
      break;
    default:
      rule = "Prices from CSV upload";
  }
  const extras = [
    ROUNDING_LABEL[job.options.rounding],
    job.options.minPrice !== null ? `never below ${job.options.minPrice.toFixed(2)}` : null,
    job.options.maxDiscountPercent !== null
      ? `max ${job.options.maxDiscountPercent}% off`
      : null,
    job.skipExistingCompareAt ? "skipping variants already on sale" : null,
  ].filter(Boolean);
  return extras.length ? `${rule} (${extras.join(", ")})` : rule;
}

function NewProductsCard({
  job,
  fetcher,
  busy,
}: {
  job: ReturnType<typeof useLoaderData<typeof loader>>["job"];
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  busy: boolean;
}) {
  const data = fetcher.data;
  const found = data?.intent === "findNew" && data.ok ? data.newMatches : undefined;
  const submitting = fetcher.state !== "idle" ? fetcher.formData?.get("intent") : null;

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          New products
        </Text>
        <Text as="p" tone="subdued">
          Products added or tagged after this change ran don't have it yet. Find the ones
          that match this job's filter now and give them the same change. They become part
          of this job, so Revert and auto-revert undo them too.
        </Text>
        <Checkbox
          label={`Apply to new matching products automatically (checked every ${SYNC_INTERVAL_MINUTES} minutes)`}
          checked={job.autoApplyNewProducts}
          disabled={submitting === "autoApply"}
          onChange={(enabled) =>
            fetcher.submit({ intent: "autoApply", enabled: String(enabled) }, { method: "POST" })
          }
        />
        {job.lastSyncedAt && (
          <Text as="p" variant="bodySm" tone="subdued">
            Last checked {new Date(job.lastSyncedAt).toLocaleString()}
          </Text>
        )}
        <InlineStack gap="300">
          <Button
            onClick={() => fetcher.submit({ intent: "findNew" }, { method: "POST" })}
            loading={submitting === "findNew"}
            disabled={busy || !job.canApplyToNewProducts}
          >
            Find new products
          </Button>
          {found && found.count > 0 && (
            <Button
              variant="primary"
              onClick={() => fetcher.submit({ intent: "applyNew" }, { method: "POST" })}
              loading={submitting === "applyNew"}
              disabled={busy}
            >
              {`Apply to ${found.count} variant${found.count === 1 ? "" : "s"}`}
            </Button>
          )}
        </InlineStack>
        {found && found.count === 0 && (
          <Text as="p">No new products match — everything matching already has this change.</Text>
        )}
        {found && found.count > 0 && (
          <BlockStack gap="100">
            <DataTable
              columnContentTypes={["text", "text", "numeric", "numeric", "numeric"]}
              headings={["Product", "SKU", "Current price", "New price", "New compare-at"]}
              rows={found.rows.map((r) => [
                r.product,
                r.sku ?? "—",
                r.oldPrice.toFixed(2),
                r.newPrice.toFixed(2),
                r.newCompareAtPrice?.toFixed(2) ?? "—",
              ])}
            />
            {found.count > found.rows.length && (
              <Text as="span" tone="subdued">
                Showing first {found.rows.length} of {found.count}.
              </Text>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
