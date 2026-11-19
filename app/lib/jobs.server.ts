import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  applyFixedPriceUpdates,
  applyVariantPriceUpdates,
  fetchMarketFixedPrices,
  type MarketFixedPrice,
  type BatchResult,
  fetchProductIdsInCollections,
  setProductTag,
  fetchProductTags,
  resolveVariantsByIds,
  resolveVariantsByQuery,
  type ResolvedVariant,
} from "./shopifyAdmin.server";
import {
  computeMarketPrices,
  computeUpdatedPrices,
  DEFAULT_PRICING_OPTIONS,
  jobChangedCompareAt,
  jobChangedPrice,
  normCompareAt,
  revertDecision,
  ROUNDINGS,
  type JobMode,
  type JobTargetField,
  type PricingOptions,
  type Rounding,
} from "./pricing";
import {
  applyVariantFilters,
  buildProductSearchQuery,
  numericId,
  parseAdvancedFilter,
  SYNC_INTERVAL_MINUTES,
} from "./filters";
import { Prisma, type JobFilterType } from "@prisma/client";

type AdminGraphqlClient = Parameters<typeof resolveVariantsByQuery>[0];

export type JobItemPreview = {
  variantId: string;
  productId: string;
  sku: string | null;
  /** For display in the preview only (not stored). */
  productTitle?: string;
  variantTitle?: string;
  oldPrice: number;
  newPrice: number;
  oldCompareAtPrice: number | null;
  newCompareAtPrice: number | null;
};

/** "Product — Variant" (or just the product for single-variant products), max 512 chars. */
export function displayTitle(item: {
  productTitle?: string | null;
  variantTitle?: string | null;
}): string | null {
  if (!item.productTitle) return null;
  const title =
    item.variantTitle && item.variantTitle !== "Default Title"
      ? `${item.productTitle} — ${item.variantTitle}`
      : item.productTitle;
  return title.slice(0, 512);
}

export type MarketPriceChange = {
  priceListId: string;
  marketName: string;
  currency: string;
  oldPrice: number;
  newPrice: number;
  oldCompareAtPrice: number | null;
  newCompareAtPrice: number | null;
};

type PriceRule = {
  mode: JobMode;
  targetField: JobTargetField;
  value: number;
  skipExistingCompareAt: boolean;
  options: PricingOptions;
};

/** Reads a job's stored pricing options (rounding and guardrails). */
export function pricingOptionsOf(job: {
  rounding: string | null;
  minPrice: { toString(): string } | null;
  maxDiscountPercent: { toString(): string } | null;
}): PricingOptions {
  return {
    rounding: ROUNDINGS.includes(job.rounding as Rounding) ? (job.rounding as Rounding) : "none",
    minPrice: job.minPrice !== null ? Number(job.minPrice.toString()) : null,
    maxDiscountPercent:
      job.maxDiscountPercent !== null ? Number(job.maxDiscountPercent.toString()) : null,
  };
}

type BasePriceChange = {
  variantId: string;
  oldPrice: number;
  newPrice: number;
  oldCompareAtPrice: number | null;
  newCompareAtPrice: number | null;
};

/**
 * Works out the market fixed-price changes (e.g. UK GBP prices) that go with
 * each variant's base price change. Fixed prices that already have a
 * compare-at price are left out when skipExistingCompareAt is on.
 */
function computeMarketChanges(
  rule: PriceRule,
  items: BasePriceChange[],
  fixedPrices: Map<string, MarketFixedPrice[]>,
): Map<string, MarketPriceChange[]> {
  const out = new Map<string, MarketPriceChange[]>();
  for (const item of items) {
    const changes: MarketPriceChange[] = [];
    for (const fixed of fixedPrices.get(item.variantId) ?? []) {
      const fixedPrice = Number(fixed.price);
      const fixedCompareAtPrice =
        fixed.compareAtPrice !== null ? Number(fixed.compareAtPrice) : null;
      if (rule.skipExistingCompareAt && fixedCompareAtPrice !== null && fixedCompareAtPrice > 0) {
        continue;
      }
      const { newFixedPrice, newFixedCompareAtPrice } = computeMarketPrices({
        mode: rule.mode,
        targetField: rule.targetField,
        value: rule.value,
        oldPrice: item.oldPrice,
        newPrice: item.newPrice,
        oldCompareAtPrice: item.oldCompareAtPrice,
        newCompareAtPrice: item.newCompareAtPrice,
        fixedPrice,
        fixedCompareAtPrice,
        options: rule.options,
      });
      changes.push({
        priceListId: fixed.priceListId,
        marketName: fixed.marketName,
        currency: fixed.currency,
        oldPrice: fixedPrice,
        newPrice: newFixedPrice,
        oldCompareAtPrice: fixedCompareAtPrice,
        newCompareAtPrice: newFixedCompareAtPrice,
      });
    }
    if (changes.length) out.set(item.variantId, changes);
  }
  return out;
}

/** Market fixed-price changes for the preview step (reads current fixed prices from Shopify). */
export async function previewMarketChanges(
  admin: AdminGraphqlClient,
  rule: PriceRule,
  items: JobItemPreview[],
): Promise<Record<string, MarketPriceChange[]>> {
  const fixed = await fetchMarketFixedPrices(
    admin,
    items.map((i) => i.variantId),
  );
  return Object.fromEntries(computeMarketChanges(rule, items, fixed));
}

function searchQueryForFilter(filterType: JobFilterType, filterValue: string): string {
  const quoted = filterValue.replace(/['"\\]/g, "");
  switch (filterType) {
    case "collection":
      return `collection_id:${filterValue}`;
    case "tag":
      return `tag:'${quoted}'`;
    case "vendor":
      return `vendor:'${quoted}'`;
    case "productType":
      return `product_type:'${quoted}'`;
    default:
      throw new Error(`searchQueryForFilter does not support filterType ${filterType}`);
  }
}

/** Resolves the variant set for a non-CSV job (collection/tag/vendor/productType/advanced/manual). */
export async function resolveJobVariants(
  admin: AdminGraphqlClient,
  filterType: JobFilterType,
  filterValue: string,
  /** Only look at these products (e.g. ones a webhook said were created or changed). */
  onlyProductIds?: string[],
  /** Products in the filter's excluded collections, if already looked up. */
  knownExcludedProductIds?: Set<string>,
): Promise<ResolvedVariant[]> {
  const restrict = (query: string) => {
    if (!onlyProductIds) return query;
    const ids = `(${onlyProductIds.map((id) => `id:${numericId(id)}`).join(" OR ")})`;
    return query ? `(${query}) AND ${ids}` : ids;
  };
  if (filterType === "manual") {
    const variantIds: string[] = JSON.parse(filterValue);
    return resolveVariantsByIds(admin, variantIds);
  }
  if (filterType === "csv") {
    throw new Error("CSV jobs build their item list directly, not via resolveJobVariants");
  }
  if (filterType === "advanced") {
    const filter = parseAdvancedFilter(filterValue);
    const [variants, excludedProductIds] = await Promise.all([
      resolveVariantsByQuery(
        admin,
        restrict(buildProductSearchQuery(filter)),
        filter.stock !== "any",
      ),
      knownExcludedProductIds ?? fetchProductIdsInCollections(admin, filter.exclude.collectionIds),
    ]);
    return applyVariantFilters(variants, filter, excludedProductIds);
  }
  return resolveVariantsByQuery(admin, restrict(searchQueryForFilter(filterType, filterValue)));
}

/** Builds a price-change preview (no DB writes) for the wizard's review step. */
export function buildPreview(params: {
  mode: JobMode;
  targetField: JobTargetField;
  value: number;
  options?: PricingOptions;
  variants: ResolvedVariant[];
}): JobItemPreview[] {
  const { mode, targetField, value, variants } = params;
  const options = params.options ?? DEFAULT_PRICING_OPTIONS;

  return variants.map((v) => {
    const oldPrice = Number(v.price);
    const oldCompareAtPrice = v.compareAtPrice !== null ? Number(v.compareAtPrice) : null;
    const { newPrice, newCompareAtPrice } = computeUpdatedPrices({
      mode,
      targetField,
      value,
      oldPrice,
      oldCompareAtPrice,
      options,
    });

    return {
      variantId: v.variantId,
      productId: v.productId,
      sku: v.sku,
      productTitle: v.productTitle,
      variantTitle: v.variantTitle,
      oldPrice,
      newPrice,
      oldCompareAtPrice,
      newCompareAtPrice,
    };
  });
}

export async function createJob(params: {
  shopName: string;
  name?: string | null;
  mode: JobMode;
  targetField: JobTargetField;
  value: number | null;
  filterType: JobFilterType;
  filterValue: string;
  runAt: Date | null;
  revertAt: Date | null;
  skipExistingCompareAt: boolean;
  options?: PricingOptions;
  autoApplyNewProducts?: boolean;
  saleTag?: string | null;
  items: JobItemPreview[];
}) {
  const {
    shopName,
    name,
    mode,
    targetField,
    value,
    filterType,
    filterValue,
    runAt,
    revertAt,
    skipExistingCompareAt,
    items,
  } = params;
  const options = params.options ?? DEFAULT_PRICING_OPTIONS;

  return prisma.priceJob.create({
    data: {
      shopName,
      name: name || null,
      mode,
      targetField,
      value,
      filterType,
      filterValue,
      runAt,
      revertAt,
      skipExistingCompareAt,
      rounding: options.rounding === "none" ? null : options.rounding,
      minPrice: options.minPrice,
      maxDiscountPercent: options.maxDiscountPercent,
      autoApplyNewProducts: params.autoApplyNewProducts ?? false,
      // Shopify splits tags on commas; the form rejects them, this is a backstop.
      saleTag: params.saleTag?.replace(/,/g, " ").trim() || null,
      status: runAt && runAt.getTime() > Date.now() ? "scheduled" : "draft",
      items: {
        create: items.map((item) => ({
          variantId: item.variantId,
          productId: item.productId,
          sku: item.sku,
          productTitle: displayTitle(item),
          oldPrice: item.oldPrice,
          newPrice: item.newPrice,
          oldCompareAtPrice: item.oldCompareAtPrice,
          newCompareAtPrice: item.newCompareAtPrice,
        })),
      },
    },
    include: { items: true },
  });
}

/**
 * Claims a job for execution, guarding against another in-flight job
 * touching the same variants. Returns the job with items if claimed,
 * or null if it couldn't be claimed (already running/done, or conflict).
 */
async function claimJobForExecution(jobId: string) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.priceJob.findUnique({ where: { id: jobId }, include: { items: true } });
    if (!job) return null;
    if (job.status !== "draft" && job.status !== "scheduled") return null;

    const variantIds = job.items.map((i) => i.variantId);
    // Only items a running job is still working on (pending) conflict.
    const conflicting = await tx.priceJobItem.findFirst({
      where: {
        variantId: { in: variantIds },
        jobId: { not: jobId },
        status: "pending",
        job: { status: "running" },
      },
    });

    if (conflicting) {
      // A scheduled job waits (it is tried again next minute) rather than
      // failing for good, e.g. while an auto-apply job adds new products.
      const waitedMs = Date.now() - firstAttemptAt(jobId);
      if (job.status === "scheduled" && waitedMs < REVERT_HANDOVER_MINUTES * 60_000) {
        console.log(`[jobs] job ${jobId} waits: another running job is changing the same variants`);
        return null;
      }
      await tx.priceJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          errorMessage:
            "Another price change job is currently running on one or more of the same variants.",
        },
      });
      return null;
    }

    // Conditional update: if an overlapping tick claimed it meanwhile, the
    // status is no longer draft/scheduled and this claims nothing.
    const claimed = await tx.priceJob.updateMany({
      where: { id: jobId, status: { in: ["draft", "scheduled"] } },
      data: { status: "running" },
    });
    if (claimed.count === 0) return null;
    return tx.priceJob.findUnique({ where: { id: jobId }, include: { items: true } });
  });
}

/** Writes one batch's outcome to the job's items as soon as Shopify answers, so the job page can show live progress. */
/**
 * Prefix of the error message on items (and market rows) whose *revert*
 * failed: their sale price is still live. Apply failures have no prefix:
 * those prices never changed.
 */
const REVERT_FAILED = "Revert failed: ";

/** Prisma filter: an item or market row whose job price is still live in Shopify. */
const STILL_LIVE = {
  OR: [
    { status: "applied" as const },
    { status: "error" as const, errorMessage: { startsWith: REVERT_FAILED } },
  ],
};

async function recordBatch(jobId: string, successStatus: "applied" | "reverted", batch: BatchResult) {
  const ops = [];
  if (batch.succeeded.length) {
    ops.push(
      prisma.priceJobItem.updateMany({
        where: { jobId, variantId: { in: batch.succeeded } },
        data: { status: successStatus, errorMessage: null },
      }),
    );
  }
  for (const f of batch.failed) {
    ops.push(
      prisma.priceJobItem.updateMany({
        where: { jobId, variantId: f.variantId },
        data: {
          status: "error",
          errorMessage: successStatus === "reverted" ? REVERT_FAILED + f.error : f.error,
        },
      }),
    );
  }
  if (ops.length) await prisma.$transaction(ops);
}

declare global {
  // Jobs being worked on by this server process right now. A job whose DB
  // status is "running" but isn't in here was cut off (e.g. a server restart).
  var activeJobIds: Set<string> | undefined;
}
const activeJobIds = (global.activeJobIds ??= new Set<string>());

export function isJobActiveInThisProcess(jobId: string): boolean {
  return activeJobIds.has(jobId);
}

type JobItemRow = Awaited<ReturnType<typeof prisma.priceJobItem.findMany>>[number];

/**
 * Records, for a job that has none yet, the market fixed prices (e.g. UK GBP)
 * of the given items as they are in Shopify right now, with their new values.
 */
async function ensureMarketRows(admin: AdminGraphqlClient, jobId: string, items: JobItemRow[]) {
  const job = await prisma.priceJob.findUniqueOrThrow({ where: { id: jobId } });
  if (job.marketPricesRecorded) return;
  await recordMarketRows(admin, job, items);
}

/**
 * Reads the given items' current market fixed prices and records them with
 * their new values, then marks the job's market prices as recorded.
 */
async function recordMarketRows(
  admin: AdminGraphqlClient,
  job: Awaited<ReturnType<typeof prisma.priceJob.findUniqueOrThrow>>,
  items: JobItemRow[],
) {
  const jobId = job.id;

  const rule: PriceRule = {
    mode: job.mode,
    targetField: job.targetField,
    value: job.value !== null ? Number(job.value) : 0,
    skipExistingCompareAt: job.skipExistingCompareAt,
    options: pricingOptionsOf(job),
  };
  const base: BasePriceChange[] = items.map((i) => ({
    variantId: i.variantId,
    oldPrice: Number(i.oldPrice),
    newPrice: Number(i.newPrice),
    oldCompareAtPrice: i.oldCompareAtPrice !== null ? Number(i.oldCompareAtPrice) : null,
    newCompareAtPrice: i.newCompareAtPrice !== null ? Number(i.newCompareAtPrice) : null,
  }));

  const fixed = await fetchMarketFixedPrices(
    admin,
    items.map((i) => i.variantId),
  );
  const changes = computeMarketChanges(rule, base, fixed);
  const itemIdByVariant = new Map(items.map((i) => [i.variantId, i.id]));

  const rows = [...changes].flatMap(([variantId, list]) =>
    list.map((c) => ({
      itemId: itemIdByVariant.get(variantId)!,
      priceListId: c.priceListId,
      marketName: c.marketName,
      currency: c.currency,
      oldPrice: c.oldPrice,
      newPrice: c.newPrice,
      oldCompareAtPrice: c.oldCompareAtPrice,
      newCompareAtPrice: c.newCompareAtPrice,
    })),
  );
  await prisma.$transaction([
    prisma.priceJobMarketPrice.createMany({ data: rows }),
    prisma.priceJob.update({ where: { id: jobId }, data: { marketPricesRecorded: true } }),
  ]);
  console.log(`[jobs] job ${jobId}: ${rows.length} market fixed prices to change`);
}

/**
 * Writes market fixed prices to Shopify: the new values ("applied") for rows
 * still pending whose variant's base price was applied, or the old values
 * ("reverted") for rows that were applied.
 */
async function applyMarketRows(
  admin: AdminGraphqlClient,
  jobId: string,
  direction: "applied" | "reverted",
) {
  const rows = await prisma.priceJobMarketPrice.findMany({
    where:
      direction === "applied"
        ? { status: "pending", item: { jobId, status: "applied" } }
        : { status: "applied", item: { jobId } },
    include: { item: { select: { variantId: true } } },
  });
  await writeMarketRows(admin, jobId, rows, direction);
}

type MarketRowWithVariant = Awaited<
  ReturnType<typeof prisma.priceJobMarketPrice.findMany<{
    include: { item: { select: { variantId: true } } };
  }>>
>[number];

/** Writes the given market rows' new ("applied") or old ("reverted") prices to Shopify. */
async function writeMarketRows(
  admin: AdminGraphqlClient,
  jobId: string,
  rows: MarketRowWithVariant[],
  direction: "applied" | "reverted",
) {
  const byPriceList = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byPriceList.get(row.priceListId) ?? [];
    list.push(row);
    byPriceList.set(row.priceListId, list);
  }

  for (const [priceListId, list] of byPriceList) {
    await applyFixedPriceUpdates(
      admin,
      priceListId,
      list.map((row) => {
        const useNew = direction === "applied";
        const price = useNew ? row.newPrice : row.oldPrice;
        const compareAt = useNew ? row.newCompareAtPrice : row.oldCompareAtPrice;
        return {
          variantId: row.item.variantId,
          currency: row.currency,
          price: price.toString(),
          compareAtPrice: compareAt?.toString() ?? null,
        };
      }),
      async (batch) => {
        const ops = [];
        if (batch.succeeded.length) {
          ops.push(
            prisma.priceJobMarketPrice.updateMany({
              where: { priceListId, item: { jobId, variantId: { in: batch.succeeded } } },
              data: { status: direction, errorMessage: null },
            }),
          );
        }
        for (const f of batch.failed) {
          ops.push(
            prisma.priceJobMarketPrice.updateMany({
              where: { priceListId, item: { jobId, variantId: f.variantId } },
              data: {
                status: "error",
                errorMessage: direction === "reverted" ? REVERT_FAILED + f.error : f.error,
              },
            }),
          );
        }
        if (ops.length) await prisma.$transaction(ops);
      },
    );
  }
}

/** Sets a job's final status from its variants' and market prices' outcomes. */
async function finishJob(jobId: string, extraMessages: (string | null)[] = []) {
  const total = await prisma.priceJobItem.count({ where: { jobId } });
  const errors = await prisma.priceJobItem.count({ where: { jobId, status: "error" } });
  const marketErrors = await prisma.priceJobMarketPrice.count({
    where: { status: "error", item: { jobId } },
  });

  const messages = [];
  if (errors) messages.push(`${errors} of ${total} variants failed to update.`);
  if (marketErrors) messages.push(`${marketErrors} market prices failed to update.`);
  const notApplied = await prisma.priceJobItem.count({ where: { jobId, status: "notApplied" } });
  if (notApplied) {
    messages.push(`${notApplied} variant(s) weren't changed (deleted, or already on sale when the job ran).`);
  }
  messages.push(...extraMessages.filter((m): m is string => Boolean(m)));

  await prisma.priceJob.update({
    where: { id: jobId },
    data: {
      status: errors === total && total > 0 ? "failed" : "completed",
      completedAt: new Date(),
      errorMessage: messages.length ? messages.join(" ") : null,
    },
  });
}

/**
 * Applies the given items' new base prices (recording progress per batch),
 * then the matching market fixed prices, then sets the job's final status.
 */
async function applyItemsAndFinish(
  admin: AdminGraphqlClient,
  jobId: string,
  items: JobItemRow[],
  /** Variants already applied earlier (e.g. before a cut-off) that still need the sale tag. */
  alreadyAppliedVariantIds: string[] = [],
) {
  activeJobIds.add(jobId);
  try {
    const { succeeded, failed } = await applyVariantPriceUpdates(
      admin,
      items.map((item) => ({
        variantId: item.variantId,
        productId: item.productId,
        // Only what the job changes is written (the same rule Resume and
        // Revert compare by), so an edit to the other field is never undone.
        price: jobChangedPrice(Number(item.oldPrice), Number(item.newPrice))
          ? item.newPrice.toString()
          : undefined,
        // null clears it (a set value of 0); no new compare-at leaves it alone.
        compareAtPrice: jobChangedCompareAt(toNum(item.oldCompareAtPrice), toNum(item.newCompareAtPrice))
          ? (normCompareAt(toNum(item.newCompareAtPrice))?.toString() ?? null)
          : undefined,
      })),
      (batch) => recordBatch(jobId, "applied", batch),
    );

    await applyMarketRows(admin, jobId, "applied");
    const tagError = await addSaleTag(admin, jobId, [
      ...alreadyAppliedVariantIds,
      ...succeeded,
    ]).catch(
      (e) => `Couldn't add sale tag: ${e instanceof Error ? e.message : String(e)}`,
    );
    await finishJob(jobId, [tagError]);

    return { succeeded, failed };
  } finally {
    activeJobIds.delete(jobId);
  }
}

export async function executeJob(admin: AdminGraphqlClient, jobId: string) {
  if (activeJobIds.has(jobId)) return;
  const job = await claimJobForExecution(jobId);
  if (!job) return;
  activeJobIds.add(jobId);
  let items: JobItemRow[];
  try {
    // A scheduled job's prices were worked out when it was created, maybe
    // weeks ago. Recompute them from the prices as they are now, so edits
    // made in between aren't overwritten and Revert restores today's prices.
    items = job.runAt && job.mode !== "csv" ? await refreshItemPrices(admin, job) : job.items;
    // Read market fixed prices before anything changes, so revert can restore them.
    await ensureMarketRows(admin, jobId, items);
  } catch (error) {
    activeJobIds.delete(jobId);
    throw error;
  }
  return applyItemsAndFinish(admin, jobId, items);
}

/**
 * Re-reads a job's variants from Shopify and recomputes each item's old and
 * new prices with the job's rule. Deleted variants, and (if the job skips
 * them) variants that went on sale meanwhile, are marked skipped. Returns the
 * items left to apply.
 */
async function refreshItemPrices(
  admin: AdminGraphqlClient,
  job: Awaited<ReturnType<typeof prisma.priceJob.findUniqueOrThrow>> & { items: JobItemRow[] },
): Promise<JobItemRow[]> {
  const pending = job.items.filter((i) => i.status === "pending");
  const current = await resolveVariantsByIds(
    admin,
    pending.map((i) => i.variantId),
  );
  const byId = new Map(current.map((v) => [v.variantId, v]));
  const options = pricingOptionsOf(job);
  const value = job.value !== null ? Number(job.value) : 0;

  const gone: string[] = [];
  const onSale: string[] = [];
  const updates = [];
  for (const item of pending) {
    const live = byId.get(item.variantId);
    if (!live) {
      gone.push(item.variantId);
      continue;
    }
    const oldCompareAtPrice =
      live.compareAtPrice !== null && Number(live.compareAtPrice) > 0
        ? Number(live.compareAtPrice)
        : null;
    if (job.skipExistingCompareAt && oldCompareAtPrice !== null) {
      onSale.push(item.variantId);
      continue;
    }
    const oldPrice = Number(live.price);
    const { newPrice, newCompareAtPrice } = computeUpdatedPrices({
      mode: job.mode,
      targetField: job.targetField,
      value,
      oldPrice,
      oldCompareAtPrice,
      options,
    });
    updates.push(
      prisma.priceJobItem.update({
        where: { id: item.id },
        data: { oldPrice, newPrice, oldCompareAtPrice, newCompareAtPrice },
      }),
    );
  }

  for (let i = 0; i < updates.length; i += 200) {
    await prisma.$transaction(updates.slice(i, i + 200));
  }
  // "notApplied", not "skipped": these were never changed, so no revert
  // (forced or not) may ever write their stale old prices.
  await markItems(job.id, gone, "notApplied", "Not changed: variant no longer exists.");
  await markItems(job.id, onSale, "notApplied", "Not changed: already on sale when the job ran.");
  // Nothing is applied before this is set, so a resume can safely refresh
  // again until it is.
  await prisma.priceJob.update({ where: { id: job.id }, data: { pricesRefreshedAt: new Date() } });

  return prisma.priceJobItem.findMany({ where: { jobId: job.id, status: "pending" } });
}

/**
 * For a completed job that ran before market prices were supported: changes
 * the market fixed prices (e.g. UK GBP) of every variant the job updated, so
 * they match. Revert then restores them along with the base prices.
 */
/**
 * Whether a job can get its market prices applied after the fact: it ran
 * before market prices were supported (or a previous attempt failed) and
 * changed at least one variant. A "failed" status here comes from such a
 * failed attempt, which used to mark the whole job as failed.
 */
export function canApplyMissingMarketPrices(
  job: { status: string; marketPricesRecorded: boolean },
  appliedItemCount: number,
): boolean {
  return (
    !job.marketPricesRecorded &&
    appliedItemCount > 0 &&
    (job.status === "completed" || job.status === "failed")
  );
}

export async function applyMissingMarketPrices(
  admin: AdminGraphqlClient,
  jobId: string,
  skipExistingCompareAt: boolean,
) {
  const job = await prisma.priceJob.findUnique({ where: { id: jobId }, include: { items: true } });
  const applied = job?.items.filter((i) => i.status === "applied") ?? [];
  if (!job || !canApplyMissingMarketPrices(job, applied.length) || activeJobIds.has(jobId)) {
    return;
  }

  activeJobIds.add(jobId);
  try {
    await prisma.priceJob.update({
      where: { id: jobId },
      data: { status: "running", skipExistingCompareAt },
    });
    await ensureMarketRows(admin, jobId, applied);
    await applyMarketRows(admin, jobId, "applied");
    await finishJob(jobId);
  } catch (error) {
    // The base prices are already changed, so the job stays completed (and
    // revertable); only the market step failed and can be retried.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[jobs] market prices for job ${jobId} failed`, error);
    await finishJob(jobId);
    await prisma.priceJob.update({
      where: { id: jobId },
      data: { errorMessage: `Market prices couldn't be updated: ${message}` },
    });
  } finally {
    activeJobIds.delete(jobId);
  }
  return { succeeded: [], failed: [] };
}

export function applyMissingMarketPricesInBackground(
  shopName: string,
  jobId: string,
  skipExistingCompareAt: boolean,
) {
  runInBackground(shopName, jobId, (admin, id) =>
    applyMissingMarketPrices(admin, id, skipExistingCompareAt),
  );
}



/**
 * Finishes a job that was cut off mid-run. Reads every unfinished variant's
 * current price from Shopify:
 * - already at the job's new price → marked applied (it went through before the cut-off)
 * - still at the job's old price → applied now
 * - anything else (changed by someone else, or deleted) → marked as an error and left alone
 */
export async function resumeJob(admin: AdminGraphqlClient, jobId: string) {
  const job = await prisma.priceJob.findUnique({ where: { id: jobId }, include: { items: true } });
  // Not stuck (finished, or still being worked on): nothing to do. Returning
  // instead of throwing so a double click can't mark a healthy job as failed.
  if (!job || job.status !== "running" || activeJobIds.has(jobId)) {
    console.log(`[jobs] resume ignored for job ${jobId}: not stuck`);
    return;
  }

  activeJobIds.add(jobId);
  let toApply: JobItemRow[] = [];
  let resumedApplied: string[] = [];
  try {
    let items = job.items;
    // Cut off while a scheduled job was still recomputing its prices from the
    // live ones: finish that first (and the "already on sale" rule). Nothing
    // was applied yet then; if anything was, the refresh had finished.
    if (
      job.runAt &&
      job.mode !== "csv" &&
      !job.pricesRefreshedAt &&
      !items.some((i) => i.status === "applied")
    ) {
      await refreshItemPrices(admin, job);
      items = await prisma.priceJobItem.findMany({ where: { jobId } });
    }
    const pending = items.filter((i) => i.status === "pending");
    const current = await resolveVariantsByIds(
      admin,
      pending.map((i) => i.variantId),
    );
    const currentById = new Map(current.map((v) => [v.variantId, v]));

    const alreadyApplied: string[] = [];
    const errors: { variantId: string; error: string }[] = [];

    for (const item of pending) {
      const live = currentById.get(item.variantId);
      if (!live) {
        errors.push({ variantId: item.variantId, error: "Variant no longer exists in Shopify." });
        continue;
      }
      // Same rule as revert: only the fields this job changes are compared,
      // and "no compare-at" may be reported as null or 0. "revert" here means
      // the variant is already at the job's new price.
      const decision = revertDecision({
        currentPrice: Number(live.price),
        currentCompareAt: live.compareAtPrice !== null ? Number(live.compareAtPrice) : null,
        oldPrice: Number(item.oldPrice),
        newPrice: Number(item.newPrice),
        oldCompareAt: toNum(item.oldCompareAtPrice),
        newCompareAt: toNum(item.newCompareAtPrice),
      });

      if (decision === "revert") alreadyApplied.push(item.variantId);
      else if (decision === "alreadyOld") toApply.push(item);
      else
        errors.push({
          variantId: item.variantId,
          error: `Skipped: price was changed outside this job (now ${live.price}${live.compareAtPrice ? `, compare-at ${live.compareAtPrice}` : ""}).`,
        });
    }

    await recordBatch(jobId, "applied", { succeeded: alreadyApplied, failed: errors });
    // Everything applied before the cut-off also needs the sale tag.
    resumedApplied = items
      .filter((i) => i.status === "applied")
      .map((i) => i.variantId)
      .concat(alreadyApplied);
    // Jobs that started before market prices were supported have no market
    // rows yet. Their market fixed prices were never touched, so reading them
    // now still gives the right "old" values.
    await ensureMarketRows(
      admin,
      jobId,
      items.filter((i) => i.status !== "notApplied"),
    );
    console.log(
      `[jobs] resuming job ${jobId}: ${alreadyApplied.length} already applied, ${toApply.length} to apply, ${errors.length} skipped`,
    );
  } catch (error) {
    activeJobIds.delete(jobId);
    throw error;
  }
  activeJobIds.delete(jobId);

  return applyItemsAndFinish(admin, jobId, toApply, resumedApplied);
}

/** Starts resumeJob without waiting for it; progress shows on the job page. */
export function resumeJobInBackground(shopName: string, jobId: string) {
  runInBackground(shopName, jobId, resumeJob);
}

/**
 * Starts a job without waiting for it, so large jobs don't hold the browser
 * request open for minutes. Progress is written per batch and shown on the
 * job page. Uses an offline admin client so it keeps working after the
 * request that started it has returned.
 */
export function executeJobInBackground(shopName: string, jobId: string) {
  runInBackground(shopName, jobId, executeJob);
}

function runInBackground(
  shopName: string,
  jobId: string,
  run: (
    admin: AdminGraphqlClient,
    jobId: string,
  ) => Promise<{ succeeded: string[]; failed: unknown[] } | undefined>,
) {
  void (async () => {
    try {
      const { admin } = await unauthenticated.admin(shopName);
      const result = await run(admin, jobId);
      console.log(
        `[jobs] job ${jobId} finished: ${result?.succeeded.length ?? 0} succeeded, ${result?.failed.length ?? 0} failed`,
      );
    } catch (error) {
      console.error(`[jobs] job ${jobId} crashed`, error);
      await prisma.priceJob
        .update({
          where: { id: jobId },
          data: {
            status: "failed",
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        })
        .catch((e) => console.error(`[jobs] could not mark job ${jobId} as failed`, e));
    }
  })();
}

const toNum = (d: { toString(): string } | null): number | null =>
  d === null ? null : Number(d.toString());

const MARKET_PRICE_GONE = "This market no longer has a fixed price for the variant.";
const VARIANT_GONE = "Skipped: variant no longer exists.";

/** Marks the given variants' items (or market rows) with one status and message. */
async function markItems(
  jobId: string,
  variantIds: string[],
  status: "reverted" | "skipped" | "notApplied",
  message: string | null,
) {
  if (variantIds.length === 0) return;
  await prisma.priceJobItem.updateMany({
    where: { jobId, variantId: { in: variantIds } },
    data: { status, errorMessage: message },
  });
}

/**
 * The base-price update that puts an item back to its old prices. Only what
 * the job changed is written, so a later edit to the other field survives.
 */
function revertUpdate(item: JobItemRow) {
  const oldPrice = Number(item.oldPrice);
  const oldCompareAt = toNum(item.oldCompareAtPrice);
  return {
    variantId: item.variantId,
    productId: item.productId,
    price: jobChangedPrice(oldPrice, Number(item.newPrice)) ? item.oldPrice.toString() : undefined,
    // null clears a compare-at the job added (e.g. a markdown's strikethrough).
    compareAtPrice: jobChangedCompareAt(oldCompareAt, toNum(item.newCompareAtPrice))
      ? (normCompareAt(oldCompareAt)?.toString() ?? null)
      : undefined,
  };
}

/**
 * A market row ready to be written back. A fixed price is written whole, so
 * the live value is kept for whatever the job didn't change (price or
 * compare-at) instead of rolling that back too.
 */
function marketRevertRow(
  row: MarketRowWithVariant,
  live: { price: string; compareAtPrice: string | null },
): MarketRowWithVariant {
  return {
    ...row,
    oldPrice: jobChangedPrice(Number(row.oldPrice), Number(row.newPrice))
      ? row.oldPrice
      : new Prisma.Decimal(live.price),
    oldCompareAtPrice: jobChangedCompareAt(toNum(row.oldCompareAtPrice), toNum(row.newCompareAtPrice))
      ? row.oldCompareAtPrice
      : live.compareAtPrice !== null
        ? new Prisma.Decimal(live.compareAtPrice)
        : null,
  };
}

/**
 * Puts back the market fixed prices (e.g. UK GBP) this job applied, but only
 * those still at the job's new value. Returns how many were skipped.
 */
async function revertMarketRowsSafely(admin: AdminGraphqlClient, jobId: string) {
  const rows = await prisma.priceJobMarketPrice.findMany({
    where: { item: { jobId }, ...STILL_LIVE },
    include: { item: { select: { variantId: true } } },
  });
  if (rows.length === 0) return 0;

  const current = await fetchMarketFixedPrices(
    admin,
    [...new Set(rows.map((r) => r.item.variantId))],
  );
  const toRevert: MarketRowWithVariant[] = [];
  const alreadyOld: string[] = [];
  const skipped: { id: string; message: string }[] = [];

  for (const row of rows) {
    const live = (current.get(row.item.variantId) ?? []).find(
      (f) => f.priceListId === row.priceListId,
    );
    if (!live) {
      skipped.push({ id: row.id, message: MARKET_PRICE_GONE });
      continue;
    }
    const decision = revertDecision({
      currentPrice: Number(live.price),
      currentCompareAt: live.compareAtPrice !== null ? Number(live.compareAtPrice) : null,
      oldPrice: Number(row.oldPrice),
      newPrice: Number(row.newPrice),
      oldCompareAt: toNum(row.oldCompareAtPrice),
      newCompareAt: toNum(row.newCompareAtPrice),
    });
    if (decision === "revert") {
      toRevert.push(marketRevertRow(row, live));
    } else if (decision === "alreadyOld") alreadyOld.push(row.id);
    else
      skipped.push({
        id: row.id,
        message: `Skipped: changed after this job (now ${live.price} ${live.currency}).`,
      });
  }

  const ops = [];
  if (alreadyOld.length) {
    ops.push(
      prisma.priceJobMarketPrice.updateMany({
        where: { id: { in: alreadyOld } },
        data: { status: "reverted", errorMessage: null },
      }),
    );
  }
  for (const s of skipped) {
    ops.push(
      prisma.priceJobMarketPrice.update({
        where: { id: s.id },
        data: { status: "skipped", errorMessage: s.message },
      }),
    );
  }
  if (ops.length) await prisma.$transaction(ops);

  await writeMarketRows(admin, jobId, toRevert, "reverted");
  return skipped.length;
}

/**
 * Removes the job's sale tag from products this job tagged, once none of the
 * job's prices are live on them any more: at least one variant was put back
 * and none is still applied or failed to revert. Products that had the tag
 * before the job (e.g. the tag it filtered on) are never touched, nor ones
 * another live job with the same tag still covers. Returns an error message
 * if some couldn't be updated.
 */
async function removeSaleTag(admin: AdminGraphqlClient, jobId: string): Promise<string | null> {
  const job = await prisma.priceJob.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      items: {
        select: {
          productId: true,
          status: true,
          errorMessage: true,
          taggedByJob: true,
          marketPrices: { select: { status: true, errorMessage: true } },
        },
      },
    },
  });
  if (!job.saleTag) return null;

  // Live = the job's price is still in Shopify: applied, or its revert failed
  // (base price or any market fixed price). Apply failures never changed it.
  const isLive = (r: { status: string; errorMessage: string | null }) =>
    r.status === "applied" ||
    (r.status === "error" && (r.errorMessage ?? "").startsWith(REVERT_FAILED));

  const byProduct = new Map<string, { tagged: boolean; live: boolean; reverted: boolean }>();
  for (const i of job.items) {
    const p = byProduct.get(i.productId) ?? { tagged: false, live: false, reverted: false };
    p.tagged ||= i.taggedByJob;
    p.live ||= isLive(i) || i.marketPrices.some(isLive);
    p.reverted ||= i.status === "reverted";
    byProduct.set(i.productId, p);
  }
  const candidates = [...byProduct]
    .filter(([, p]) => p.tagged && p.reverted && !p.live)
    .map(([productId]) => productId);
  if (candidates.length === 0) return null;

  // Another job with the same tag that is live on the product, or about to
  // be (pending: starting right now or scheduled), keeps the tag and takes
  // it over, whichever of the two jobs gets there first.
  const coveredElsewhere = await prisma.priceJobItem.findMany({
    where: {
      productId: { in: candidates },
      job: { id: { not: jobId }, shopName: job.shopName, saleTag: job.saleTag },
      OR: [
        { status: "applied", job: { status: { in: ["completed", "running"] } } },
        { status: "pending", job: { status: { in: ["draft", "scheduled", "running"] } } },
      ],
    },
    select: { productId: true, jobId: true },
  });
  const keep = new Set(coveredElsewhere.map((i) => i.productId));
  // Hand the tag over to the job that still covers the product, so it is
  // removed when that job ends instead of staying forever.
  if (coveredElsewhere.length) {
    await prisma.$transaction([
      ...coveredElsewhere.map((c) =>
        prisma.priceJobItem.updateMany({
          where: { jobId: c.jobId, productId: c.productId },
          data: { taggedByJob: true },
        }),
      ),
      prisma.priceJobItem.updateMany({
        where: { jobId, productId: { in: [...keep] } },
        data: { taggedByJob: false },
      }),
    ]);
  }
  const toUntag = candidates.filter((p) => !keep.has(p));
  const failed = await setProductTag(admin, toUntag, job.saleTag, "remove");
  const failedIds = new Set(failed.map((f) => f.productId));
  const untagged = toUntag.filter((p) => !failedIds.has(p));
  if (untagged.length) {
    await prisma.priceJobItem.updateMany({
      where: { jobId, productId: { in: untagged } },
      data: { taggedByJob: false },
    });
  }
  return failed.length ? `Couldn't remove tag "${job.saleTag}" from ${failed.length} product(s).` : null;
}

/**
 * Adds the job's sale tag to the products of the given (applied) variants
 * that don't have it yet, and remembers those, so revert only removes a tag
 * this job added.
 */
async function addSaleTag(
  admin: AdminGraphqlClient,
  jobId: string,
  appliedVariantIds: string[],
): Promise<string | null> {
  const job = await prisma.priceJob.findUniqueOrThrow({ where: { id: jobId } });
  if (!job.saleTag || appliedVariantIds.length === 0) return null;
  const tag = job.saleTag;
  const items = await prisma.priceJobItem.findMany({
    where: { jobId, variantId: { in: appliedVariantIds } },
    select: {
      productId: true,
      oldPrice: true,
      newPrice: true,
      oldCompareAtPrice: true,
      newCompareAtPrice: true,
    },
  });
  // Only products whose price this job actually changed: a variant the rule
  // left as it was (e.g. held back by the minimum price) isn't on sale.
  const changed = items.filter(
    (i) =>
      jobChangedPrice(Number(i.oldPrice), Number(i.newPrice)) ||
      jobChangedCompareAt(toNum(i.oldCompareAtPrice), toNum(i.newCompareAtPrice)),
  );
  const productIds = [...new Set(changed.map((i) => i.productId))];
  if (productIds.length === 0) return null;
  const tags = await fetchProductTags(admin, productIds);
  const lower = tag.toLowerCase();
  const needTag = productIds.filter(
    (id) => tags.has(id) && !(tags.get(id) ?? []).some((t) => t.toLowerCase() === lower),
  );

  // Record ownership before calling Shopify: if the server stops midway, a
  // resume would see these products already tagged and not know this job did
  // it. Removing a tag a product doesn't have is harmless.
  if (needTag.length) {
    await prisma.priceJobItem.updateMany({
      where: { jobId, productId: { in: needTag } },
      data: { taggedByJob: true },
    });
  }
  const failed = await setProductTag(admin, needTag, tag, "add");
  // Only a definite refusal means the tag wasn't added. After a lost
  // response it may have been, so keep ownership (removing is harmless).
  const refused = failed.filter((f) => f.definite).map((f) => f.productId);
  if (refused.length) {
    await prisma.priceJobItem.updateMany({
      where: { jobId, productId: { in: refused } },
      data: { taggedByJob: false },
    });
  }
  return failed.length ? `Couldn't add tag "${tag}" to ${failed.length} product(s).` : null;
}

/**
 * Reverts a completed job, safely: each variant (and market fixed price) is
 * only put back if it's still at the price this job set. Ones changed since,
 * by another job or by hand, are marked "skipped" and left alone, so an
 * overlapping sale or a manual fix is never overwritten. revertSkippedItems
 * can force those back afterwards.
 */
export async function revertJob(
  admin: AdminGraphqlClient,
  jobId: string,
  /**
   * Retry an earlier revert's failures: the job stays "reverted" throughout
   * (so it never looks live again, even if this fails) and only the prices
   * whose revert failed are tried again.
   */
  retryFailed = false,
) {
  // Claimed before any await, so a webhook check or "apply to new products"
  // can't start on the job in between.
  if (activeJobIds.has(jobId)) {
    throw new Error("This job is busy (e.g. applying to new products). Try again in a moment.");
  }
  activeJobIds.add(jobId);
  try {
    const job = await prisma.priceJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== (retryFailed ? "reverted" : "completed")) {
      throw new Error("Only completed jobs can be reverted.");
    }

    // A check for new products that was cut off can leave items pending,
    // some of them already at the sale price: settle them first so revert
    // covers every price that is live. If this fails, the revert fails and
    // is retried (the job stays completed).
    if (!retryFailed) await reconcilePendingItems(admin, jobId);
    const items = await prisma.priceJobItem.findMany({ where: { jobId } });
    // Every price of this job still live: applied, or an earlier revert failed.
    const appliedItems = items.filter(
      (i) =>
        i.status === "applied" ||
        (i.status === "error" && (i.errorMessage ?? "").startsWith(REVERT_FAILED)),
    );
    const current = await resolveVariantsByIds(
      admin,
      appliedItems.map((i) => i.variantId),
    );
    const currentById = new Map(current.map((v) => [v.variantId, v]));

    const toRevert: JobItemRow[] = [];
    const alreadyOld: string[] = [];
    const gone: string[] = [];
    const changed: { variantId: string; message: string }[] = [];

    for (const item of appliedItems) {
      const live = currentById.get(item.variantId);
      if (!live) {
        gone.push(item.variantId);
        continue;
      }
      const decision = revertDecision({
        currentPrice: Number(live.price),
        currentCompareAt: live.compareAtPrice !== null ? Number(live.compareAtPrice) : null,
        oldPrice: Number(item.oldPrice),
        newPrice: Number(item.newPrice),
        oldCompareAt: toNum(item.oldCompareAtPrice),
        newCompareAt: toNum(item.newCompareAtPrice),
      });
      if (decision === "revert") toRevert.push(item);
      else if (decision === "alreadyOld") alreadyOld.push(item.variantId);
      else
        changed.push({
          variantId: item.variantId,
          message: `Skipped: price changed after this job (now ${live.price}${
            live.compareAtPrice ? `, compare-at ${live.compareAtPrice}` : ""
          }).`,
        });
    }

    await markItems(jobId, alreadyOld, "reverted", null);
    await markItems(jobId, gone, "skipped", VARIANT_GONE);
    for (const c of changed) await markItems(jobId, [c.variantId], "skipped", c.message);

    const { succeeded, failed } = await applyVariantPriceUpdates(
      admin,
      toRevert.map(revertUpdate),
      (batch) => recordBatch(jobId, "reverted", batch),
    );

    const marketSkipped = await revertMarketRowsSafely(admin, jobId);
    // Market prices whose job price is still live (revert failed). Ones that
    // failed back when the job ran were never changed, so they don't count.
    const marketErrors = await prisma.priceJobMarketPrice.count({
      where: { item: { jobId }, ...STILL_LIVE },
    });

    const tagError = await removeSaleTag(admin, jobId).catch((e) =>
      `Couldn't remove sale tag: ${e instanceof Error ? e.message : String(e)}`,
    );

    const skippedCount = gone.length + changed.length;
    const messages = [
      failed.length ? `${failed.length} of ${appliedItems.length} variants failed to revert.` : "",
      skippedCount
        ? `${skippedCount} variant(s) were left alone because their price changed after this job (or they were deleted).`
        : "",
      marketSkipped ? `${marketSkipped} market price(s) were left alone because they changed after this job.` : "",
      marketErrors ? `${marketErrors} market prices failed to revert.` : "",
      tagError ?? "",
    ].filter(Boolean);

    await prisma.priceJob.update({
      where: { id: jobId },
      data: {
        status: "reverted",
        // Kept from the first revert, so retries of failed prices stop after
        // an hour instead of extending their own window forever.
        revertedAt: job.revertedAt ?? new Date(),
        errorMessage: messages.join(" ") || null,
      },
    });

    return { succeeded, failed };
  } finally {
    activeJobIds.delete(jobId);
  }
}

/** Whether a reverted job has skipped prices that can be forced back. */
export async function countSkippedItems(jobId: string) {
  // Only prices skipped by a revert that can still be put back: not deleted
  // variants or deleted market overrides.
  const [items, markets] = await Promise.all([
    prisma.priceJobItem.count({
      where: { jobId, status: "skipped", NOT: { errorMessage: VARIANT_GONE } },
    }),
    prisma.priceJobMarketPrice.count({
      where: { status: "skipped", item: { jobId }, NOT: { errorMessage: MARKET_PRICE_GONE } },
    }),
  ]);
  return items + markets;
}

/**
 * After a safe revert: puts the skipped variants and market prices back to
 * their old prices anyway, overwriting whatever they were changed to.
 */
/**
 * After a safe revert: puts the skipped variants and market prices back to
 * their old prices anyway, overwriting what they were changed to. Only the
 * fields this job changed are written. The caller must have claimed the job
 * (see revertSkippedItemsInBackground).
 */
async function revertSkippedItemsClaimed(admin: AdminGraphqlClient, jobId: string) {
  const job = await prisma.priceJob.findUnique({ where: { id: jobId }, include: { items: true } });
  if (!job || job.status !== "reverted") return;

  // Only items a revert skipped (never "notApplied" ones, which were never
  // changed), and not deleted variants.
  const skipped = job.items.filter(
    (i) => i.status === "skipped" && i.errorMessage !== VARIANT_GONE,
  );
  await applyVariantPriceUpdates(
    admin,
    skipped.map(revertUpdate),
    (batch) => recordBatch(jobId, "reverted", batch),
  );

  // A market fixed price that was deleted stays deleted: writing it back
  // would re-create an override someone removed on purpose.
  const marketRows = await prisma.priceJobMarketPrice.findMany({
    where: { status: "skipped", item: { jobId }, NOT: { errorMessage: MARKET_PRICE_GONE } },
    include: { item: { select: { variantId: true } } },
  });
  if (marketRows.length) {
    const live = await fetchMarketFixedPrices(
      admin,
      [...new Set(marketRows.map((r) => r.item.variantId))],
    );
    const goneIds: string[] = [];
    const rows = marketRows.flatMap((row) => {
      const current = (live.get(row.item.variantId) ?? []).find(
        (f) => f.priceListId === row.priceListId,
      );
      if (!current) goneIds.push(row.id);
      return current ? [marketRevertRow(row, current)] : [];
    });
    // Deleted since: nothing to put back, and no longer counted as skipped.
    if (goneIds.length) {
      await prisma.priceJobMarketPrice.updateMany({
        where: { id: { in: goneIds } },
        data: { errorMessage: MARKET_PRICE_GONE },
      });
    }
    await writeMarketRows(admin, jobId, rows, "reverted");
  }

  const tagError = await removeSaleTag(admin, jobId).catch(() => null);
  const left = await countSkippedItems(jobId);
  const errors = await prisma.priceJobItem.count({ where: { jobId, status: "error" } });
  await prisma.priceJob.update({
    where: { id: jobId },
    data: {
      errorMessage:
        [
          errors ? `${errors} variants failed to update.` : "",
          left ? `${left} price(s) are still not put back.` : "",
          tagError ?? "",
        ]
          .filter(Boolean)
          .join(" ") || null,
    },
  });
}

/**
 * Starts "put skipped prices back" without waiting. The job is marked busy
 * before this returns, so the page reloading right after already shows it
 * as in progress. Returns false if the job was already busy.
 */
export function revertSkippedItemsInBackground(shopName: string, jobId: string): boolean {
  if (activeJobIds.has(jobId)) return false;
  activeJobIds.add(jobId);
  void (async () => {
    try {
      const { admin } = await unauthenticated.admin(shopName);
      await revertSkippedItemsClaimed(admin, jobId);
    } catch (error) {
      console.error(`[jobs] forcing skipped reverts for job ${jobId} failed`, error);
    } finally {
      activeJobIds.delete(jobId);
    }
  })();
  return true;
}

// ---------------------------------------------------------------------------
// Applying a finished job to products that match its filter later
//
// e.g. a Black Friday job ran on everything tagged "black-month", then more
// products got that tag: these find those products and give them the same
// change, as part of the same job (so Revert and auto-revert cover them too).
// ---------------------------------------------------------------------------


type SyncableJob = {
  status: string;
  filterType: JobFilterType;
  revertAt: Date | null;
};

/** Whether a job can be applied to newly matching products. */
export function canApplyToNewProducts(job: SyncableJob): boolean {
  return (
    job.status === "completed" &&
    job.filterType !== "manual" &&
    job.filterType !== "csv" &&
    (job.revertAt === null || job.revertAt.getTime() > Date.now())
  );
}

/**
 * The variants that match a completed job's filter now but aren't part of
 * the job yet, with the job's rule applied. Skips variants in a job that is
 * running right now, and (if the job does) variants already on sale.
 */
export async function findNewMatches(
  admin: AdminGraphqlClient,
  jobId: string,
  /** Only check these products; all matching products when left out. */
  onlyProductIds?: string[],
): Promise<JobItemPreview[]> {
  const job = await prisma.priceJob.findUniqueOrThrow({ where: { id: jobId } });
  if (!canApplyToNewProducts(job) || !job.filterValue) return [];
  const filterValue = job.filterValue;

  const resolveMatches = async () => {
    if (!onlyProductIds) return resolveJobVariants(admin, job.filterType, filterValue);
    // Look the excluded collections up once, not once per batch of products.
    const excluded =
      job.filterType === "advanced"
        ? await fetchProductIdsInCollections(
            admin,
            parseAdvancedFilter(filterValue).exclude.collectionIds,
          )
        : undefined;
    const out: ResolvedVariant[] = [];
    // Keep each search query short.
    for (let i = 0; i < onlyProductIds.length; i += 50) {
      out.push(
        ...(await resolveJobVariants(
          admin,
          job.filterType,
          filterValue,
          onlyProductIds.slice(i, i + 50),
          excluded,
        )),
      );
    }
    return out;
  };

  const [matches, existing, busy] = await Promise.all([
    resolveMatches(),
    // notApplied items (deleted, or already on sale when the job ran) may
    // match later, e.g. once that other sale ends: they don't block.
    prisma.priceJobItem.findMany({
      where: { jobId, status: { not: "notApplied" } },
      select: { variantId: true },
    }),
    prisma.priceJobItem.findMany({
      where: { job: { status: "running", id: { not: jobId }, shopName: job.shopName } },
      select: { variantId: true },
    }),
  ]);
  const skip = new Set([...existing, ...busy].map((i) => i.variantId));
  const variants = matches.filter(
    (v) =>
      !skip.has(v.variantId) &&
      !(job.skipExistingCompareAt && v.compareAtPrice !== null && Number(v.compareAtPrice) > 0),
  );

  return buildPreview({
    mode: job.mode,
    targetField: job.targetField,
    value: job.value !== null ? Number(job.value) : 0,
    options: pricingOptionsOf(job),
    variants,
  });
}

/**
 * Adds the newly matching variants to a completed job and applies the job's
 * change to them (and their market fixed prices). Returns how many were added.
 */
export async function applyToNewProducts(
  admin: AdminGraphqlClient,
  jobId: string,
  /** Only check these products (from a webhook); a full check when left out. */
  onlyProductIds?: string[],
) {
  if (activeJobIds.has(jobId)) return { succeeded: [], failed: [], busy: true };
  activeJobIds.add(jobId);
  try {
    // Settle items a previous, interrupted check left pending first.
    await reconcilePendingItems(admin, jobId);
    const newItems = await findNewMatches(admin, jobId, onlyProductIds);
    // Only a full check counts as "checked": a webhook only looked at a few products.
    if (!onlyProductIds) {
      await prisma.priceJob.update({ where: { id: jobId }, data: { lastSyncedAt: new Date() } });
    }
    if (newItems.length === 0) return { succeeded: [], failed: [] };

    const job = await prisma.priceJob.findUniqueOrThrow({ where: { id: jobId } });
    // Re-check: the job may have been reverted while we were looking.
    if (job.status !== "completed") return { succeeded: [], failed: [] };

    try {
      await prisma.$transaction([
        // Replaced by the new items below.
        prisma.priceJobItem.deleteMany({
          where: { jobId, status: "notApplied", variantId: { in: newItems.map((i) => i.variantId) } },
        }),
        prisma.priceJobItem.createMany({
          data: newItems.map((item) => ({
            jobId,
            variantId: item.variantId,
            productId: item.productId,
            sku: item.sku,
            productTitle: displayTitle(item),
            oldPrice: item.oldPrice,
            newPrice: item.newPrice,
            oldCompareAtPrice: item.oldCompareAtPrice,
            newCompareAtPrice: item.newCompareAtPrice,
          })),
        }),
        prisma.priceJob.update({ where: { id: jobId }, data: { status: "running" } }),
      ]);
      const rows = await prisma.priceJobItem.findMany({
        where: { jobId, status: "pending", variantId: { in: newItems.map((i) => i.variantId) } },
      });
      console.log(`[jobs] job ${jobId}: applying to ${rows.length} newly matching variants`);

      // Jobs that never recorded market prices get them later via the
      // "Update market prices" banner, which covers these items too.
      if (job.marketPricesRecorded) await recordMarketRows(admin, job, rows);
      return await applyItemsAndFinish(admin, jobId, rows);
    } catch (error) {
      // Settle what got applied before the failure, so nothing stays pending
      // (which would hide those products from every later check). If this
      // fails too, the next check runs it again before anything else.
      // applyItemsAndFinish already released the job; hold it again so the
      // page can't offer Resume on it while this settles.
      activeJobIds.add(jobId);
      await reconcilePendingItems(admin, jobId, true).catch((e) =>
        console.error(`[jobs] couldn't settle pending items of job ${jobId}`, e),
      );
      throw error;
    }
  } finally {
    activeJobIds.delete(jobId);
  }
}

/**
 * Runs applyToNewProducts without waiting. Unlike other background runs, a
 * crash here must not mark the job failed: its original prices are applied
 * and must stay revertable. The job's status is recomputed from its items.
 */
export function applyToNewProductsInBackground(
  shopName: string,
  jobId: string,
  onlyProductIds?: string[],
  /** Called if the job was busy, so the caller can try again later. */
  onBusy?: () => void,
) {
  void (async () => {
    try {
      const { admin } = await unauthenticated.admin(shopName);
      const result = await applyToNewProducts(admin, jobId, onlyProductIds);
      if ("busy" in result && result.busy) onBusy?.();
      if (result.succeeded.length || result.failed.length) {
        console.log(
          `[jobs] job ${jobId} new products: ${result.succeeded.length} applied, ${result.failed.length} failed`,
        );
      }
    } catch (error) {
      console.error(`[jobs] applying job ${jobId} to new products failed`, error);
      try {
        const job = await prisma.priceJob.findUnique({ where: { id: jobId } });
        if (job?.status === "running") await finishJob(jobId);
        await prisma.priceJob.update({
          where: { id: jobId },
          data: {
            errorMessage: `Couldn't apply to new products: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        });
      } catch (e) {
        console.error(`[jobs] could not record sync failure for job ${jobId}`, e);
      }
    }
  })();
}

/** Every auto-apply job due for a check for new products, across all shops. */
export async function dueAutoApplyJobs() {
  const cutoff = new Date(Date.now() - SYNC_INTERVAL_MINUTES * 60_000);
  const jobs = await prisma.priceJob.findMany({
    where: {
      autoApplyNewProducts: true,
      status: "completed",
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lte: cutoff } }],
    },
    select: { id: true, shopName: true, status: true, filterType: true, revertAt: true },
  });
  return jobs.filter(canApplyToNewProducts);
}

// ---------------------------------------------------------------------------
// Overlapping jobs
// ---------------------------------------------------------------------------

export type OverlappingJob = {
  jobId: string;
  name: string | null;
  status: string;
  runAt: string | null;
  revertAt: string | null;
  variantCount: number;
};

/**
 * Other jobs whose change is live or still to come on any of these variants:
 * scheduled/draft/running jobs, and completed jobs (not yet reverted) whose
 * change on the variant is still applied.
 */
export async function findOverlappingJobs(
  shopName: string,
  variantIds: string[],
  excludeJobId?: string,
): Promise<OverlappingJob[]> {
  const counts = new Map<string, number>();
  const unique = [...new Set(variantIds)];
  for (let i = 0; i < unique.length; i += 1000) {
    const rows = await prisma.priceJobItem.groupBy({
      by: ["jobId"],
      where: {
        variantId: { in: unique.slice(i, i + 1000) },
        ...(excludeJobId ? { jobId: { not: excludeJobId } } : {}),
        OR: [
          { status: "applied", job: { shopName, status: { in: ["completed", "running"] } } },
          {
            status: "pending",
            job: { shopName, status: { in: ["scheduled", "draft", "running"] } },
          },
        ],
      },
      _count: { _all: true },
    });
    for (const r of rows) counts.set(r.jobId, (counts.get(r.jobId) ?? 0) + r._count._all);
  }
  if (counts.size === 0) return [];

  const jobs = await prisma.priceJob.findMany({
    where: { id: { in: [...counts.keys()] } },
    select: { id: true, name: true, status: true, runAt: true, revertAt: true },
  });
  return jobs
    .map((j) => ({
      jobId: j.id,
      name: j.name,
      status: j.status,
      runAt: j.runAt?.toISOString() ?? null,
      revertAt: j.revertAt?.toISOString() ?? null,
      variantCount: counts.get(j.id) ?? 0,
    }))
    .sort((a, b) => b.variantCount - a.variantCount);
}

/** How long a scheduled job waits for an overdue revert on its variants. */
const REVERT_HANDOVER_MINUTES = 30;

/**
 * Whether a due scheduled job should wait: another job on the same variants
 * was due to auto-revert by now but is still live (its revert is running, or
 * failed and will be retried). Starting now would compute the new sale's
 * prices from the old sale's prices and stack the discounts. Gives up waiting
 * after REVERT_HANDOVER_MINUTES so a revert that keeps failing can't block
 * the new job forever.
 */
export async function waitingForRevertHandover(jobId: string): Promise<boolean> {
  const job = await prisma.priceJob.findUnique({
    where: { id: jobId },
    include: { items: { select: { variantId: true, productId: true } } },
  });
  if (!job?.runAt) return false;
  const now = Date.now();
  const busyJobIds = [...activeJobIds].filter((id) => id !== jobId);

  // A job being worked on right now (e.g. reverting, or removing a sale tag)
  // on any of these products always blocks: it will finish.
  const productIds = [...new Set(job.items.map((i) => i.productId))];
  if (busyJobIds.length) {
    for (let i = 0; i < productIds.length; i += 1000) {
      const busy = await prisma.priceJobItem.findFirst({
        where: { jobId: { in: busyJobIds }, productId: { in: productIds.slice(i, i + 1000) } },
        select: { jobId: true },
      });
      if (busy) return true;
    }
  }

  // The rest waits at most REVERT_HANDOVER_MINUTES, counted from when the
  // scheduler first tried this job (not runAt: after downtime it may be
  // overdue already), so a revert that keeps failing can't block it forever.
  if (now - firstAttemptAt(jobId) > REVERT_HANDOVER_MINUTES * 60_000) return false;

  const variantIds = job.items.map((i) => i.variantId);
  const recentRevert = new Date(now - 2 * REVERT_HANDOVER_MINUTES * 60_000);
  for (let i = 0; i < variantIds.length; i += 1000) {
    const chunk = variantIds.slice(i, i + 1000);
    const blocking = await prisma.priceJobItem.findFirst({
      where: {
        variantId: { in: chunk },
        jobId: { not: jobId },
        job: { shopName: job.shopName },
        OR: [
          // A sale that should have ended by now but is still live on this
          // variant: base price, or a market fixed price (e.g. UK GBP).
          // (A "running" job only counts while it's being worked on here: one
          // cut off by a restart won't be reverted until someone resumes it.)
          {
            job: {
              revertAt: { lte: new Date(now) },
              OR: [
                { status: "completed" },
                // Being worked on here, or a sale a restart left stuck while
                // checking new products: the scheduler recovers and reverts it.
                { status: "running", completedAt: { not: null } },
                ...(busyJobIds.length ? [{ status: "running" as const, id: { in: busyJobIds } }] : []),
              ],
            },
            OR: [
              STILL_LIVE,
              { marketPrices: { some: STILL_LIVE } },
              // A stuck job's pending items may already be live in Shopify.
              { status: "pending", job: { status: "running" } },
            ],
          },
          // A sale that just ended whose revert failed on this variant: the
          // scheduler retries those for a while (retryFailedReverts).
          {
            job: { status: "reverted", revertedAt: { gte: recentRevert } },
            OR: [
              { status: "error", errorMessage: { startsWith: REVERT_FAILED } },
              {
                marketPrices: {
                  some: { status: "error", errorMessage: { startsWith: REVERT_FAILED } },
                },
              },
            ],
          },
          // A job being worked on right now (reverting, or applying to new
          // products) that has this variant.

        ],
      },
      select: { jobId: true },
    });
    if (blocking) return true;
  }
  return false;
}

/**
 * Settles a completed job's items left "pending" by an interrupted check for
 * new products, by reading each variant's live price (like Resume does):
 * - at the job's new price → it went through: marked applied (market prices too)
 * - still at its old price → never applied: the item is removed, so the next
 *   check finds the product again and applies it fresh
 * - anything else → changed by someone else: marked as an error, left alone
 * Never re-applies anything itself, so a discount can't be applied twice.
 */
async function reconcilePendingItems(
  admin: AdminGraphqlClient,
  jobId: string,
  /** Set right after this process's own check failed (the job is then "running"). */
  afterOwnFailure = false,
) {
  // A job cut off during its first run also has pending items: those belong
  // to Resume, never to this.
  const job = await prisma.priceJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!job || (job.status !== "completed" && !(afterOwnFailure && job.status === "running"))) {
    return;
  }
  const pending = await prisma.priceJobItem.findMany({ where: { jobId, status: "pending" } });
  if (pending.length === 0) return;

  const live = new Map(
    (await resolveVariantsByIds(admin, pending.map((i) => i.variantId))).map((v) => [v.variantId, v]),
  );
  const applied: string[] = [];
  const notApplied: string[] = [];
  const changed: { variantId: string; error: string }[] = [];
  const gone: string[] = [];
  for (const item of pending) {
    const v = live.get(item.variantId);
    if (!v) {
      gone.push(item.variantId);
      continue;
    }
    const decision = revertDecision({
      currentPrice: Number(v.price),
      currentCompareAt: v.compareAtPrice !== null ? Number(v.compareAtPrice) : null,
      oldPrice: Number(item.oldPrice),
      newPrice: Number(item.newPrice),
      oldCompareAt: toNum(item.oldCompareAtPrice),
      newCompareAt: toNum(item.newCompareAtPrice),
    });
    // "revert" here means "still at the job's new price", i.e. applied.
    if (decision === "revert") applied.push(item.variantId);
    else if (decision === "alreadyOld") notApplied.push(item.variantId);
    else
      changed.push({
        variantId: item.variantId,
        error: `Price changed outside this job before it was confirmed (now ${v.price}).`,
      });
  }

  await recordBatch(jobId, "applied", { succeeded: applied, failed: changed });
  await markItems(jobId, gone, "notApplied", "Not changed: variant no longer exists.");
  if (notApplied.length) {
    await prisma.priceJobItem.deleteMany({
      where: { jobId, status: "pending", variantId: { in: notApplied } },
    });
  }
  if (applied.length) {
    await applyMarketRows(admin, jobId, "applied");
    await addSaleTag(admin, jobId, applied).catch((e) =>
      console.error(`[jobs] couldn't tag reconciled products of job ${jobId}`, e),
    );
  }
  console.log(
    `[jobs] job ${jobId}: settled pending items: ${applied.length} applied, ${notApplied.length} to retry, ${changed.length} changed, ${gone.length} gone`,
  );
}

/**
 * Reverted jobs (in the last hour) where putting some prices back failed, so
 * the sale price is still live there. Retried every scheduler tick.
 */
export async function jobsWithFailedReverts() {
  const since = new Date(Date.now() - 2 * REVERT_HANDOVER_MINUTES * 60_000);
  const failed = { status: "error" as const, errorMessage: { startsWith: REVERT_FAILED } };
  return prisma.priceJob.findMany({
    where: {
      status: "reverted",
      revertedAt: { gte: since },
      items: { some: { OR: [failed, { marketPrices: { some: failed } }] } },
    },
    select: { id: true, shopName: true },
  });
}

/**
 * Tries the failed part of a revert again, with the normal safe checks (each
 * live price is read before writing, so nothing is overwritten). The job
 * stays "reverted" the whole time.
 */
export async function retryFailedReverts(admin: AdminGraphqlClient, jobId: string) {
  if (activeJobIds.has(jobId)) return;
  console.log(`[jobs] retrying failed reverts of job ${jobId}`);
  return revertJob(admin, jobId, true);
}

/**
 * Jobs a restart cut off while they were applying to new products: they had
 * finished their first run (completedAt is set) but are stuck in "running",
 * so their auto-revert would never fire. A first run that was cut off
 * (completedAt not set) is left for Resume.
 */
export async function interruptedNewProductChecks() {
  const jobs = await prisma.priceJob.findMany({
    where: { status: "running", completedAt: { not: null } },
    select: { id: true, shopName: true },
  });
  const now = Date.now();
  const stuck = jobs.filter((j) => !activeJobIds.has(j.id));
  // Only once it has looked stuck for a while: during a zero-downtime
  // deploy the old server may still be working on it.
  for (const id of stuckSince.keys()) {
    if (!stuck.some((j) => j.id === id)) stuckSince.delete(id);
  }
  return stuck.filter((j) => {
    const since = stuckSince.get(j.id) ?? now;
    stuckSince.set(j.id, since);
    return now - since >= STUCK_GRACE_MS;
  });
}

const STUCK_GRACE_MS = 5 * 60_000;
declare global {
  var stuckSince: Map<string, number> | undefined;
}
const stuckSince = (global.stuckSince ??= new Map<string, number>());

/**
 * Settles such a job's pending items by their live prices (applied ones
 * stay, unapplied ones are dropped and found again by the next check) and
 * marks it completed again, so its revert and new-product checks carry on.
 */
export async function recoverInterruptedCheck(admin: AdminGraphqlClient, jobId: string) {
  if (activeJobIds.has(jobId)) return;
  activeJobIds.add(jobId);
  try {
    await reconcilePendingItems(admin, jobId, true);
    const job = await prisma.priceJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (job?.status === "running") await finishJob(jobId);
    console.log(`[jobs] recovered job ${jobId} after an interrupted new-product check`);
  } finally {
    activeJobIds.delete(jobId);
  }
}

declare global {
  var jobFirstAttempt: Map<string, number> | undefined;
}
const jobFirstAttempt = (global.jobFirstAttempt ??= new Map<string, number>());

/** When this process first tried to run a scheduled job (for its waiting limits). */
function firstAttemptAt(jobId: string): number {
  let t = jobFirstAttempt.get(jobId);
  if (t === undefined) {
    t = Date.now();
    jobFirstAttempt.set(jobId, t);
    // Forget old entries; a job waits at most REVERT_HANDOVER_MINUTES.
    for (const [id, at] of jobFirstAttempt) {
      if (t - at > 24 * 60 * 60_000) jobFirstAttempt.delete(id);
    }
  }
  return t;
}
