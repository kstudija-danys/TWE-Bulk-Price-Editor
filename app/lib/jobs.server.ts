import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  applyFixedPriceUpdates,
  applyVariantPriceUpdates,
  fetchMarketFixedPrices,
  type MarketFixedPrice,
  type BatchResult,
  resolveVariantsByIds,
  resolveVariantsByQuery,
  type ResolvedVariant,
} from "./shopifyAdmin.server";
import {
  computeMarketPrices,
  computeUpdatedPrices,
  type JobMode,
  type JobTargetField,
} from "./pricing";
import type { JobFilterType } from "@prisma/client";

type AdminGraphqlClient = Parameters<typeof resolveVariantsByQuery>[0];

export type JobItemPreview = {
  variantId: string;
  productId: string;
  sku: string | null;
  oldPrice: number;
  newPrice: number;
  oldCompareAtPrice: number | null;
  newCompareAtPrice: number | null;
};

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
};

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

export type AdvancedFilter = {
  combinator: "AND" | "OR";
  tags: string[];
  vendors: string[];
  productTypes: string[];
  collectionIds: string[];
};

function escapeQueryValue(value: string): string {
  return value.replace(/'/g, "");
}

function searchQueryForFilter(filterType: JobFilterType, filterValue: string): string {
  switch (filterType) {
    case "collection":
      return `collection_id:${filterValue}`;
    case "tag":
      return `tag:'${escapeQueryValue(filterValue)}'`;
    case "vendor":
      return `vendor:'${escapeQueryValue(filterValue)}'`;
    case "productType":
      return `product_type:'${escapeQueryValue(filterValue)}'`;
    default:
      throw new Error(`searchQueryForFilter does not support filterType ${filterType}`);
  }
}

function searchQueryForAdvancedFilter(filterValue: string): string {
  const filter: AdvancedFilter = JSON.parse(filterValue);
  const clauses = [
    ...filter.tags.map((t) => `tag:'${escapeQueryValue(t)}'`),
    ...filter.vendors.map((v) => `vendor:'${escapeQueryValue(v)}'`),
    ...filter.productTypes.map((p) => `product_type:'${escapeQueryValue(p)}'`),
    ...filter.collectionIds.map((c) => {
      const numericId = c.includes("/") ? c.split("/").pop() : c;
      return `collection_id:${numericId}`;
    }),
  ];

  if (clauses.length === 0) {
    throw new Error("Add at least one tag, vendor, product type, or collection to filter by.");
  }

  return clauses.join(filter.combinator === "AND" ? " AND " : " OR ");
}

/** Resolves the variant set for a non-CSV job (collection/tag/vendor/productType/advanced/manual). */
export async function resolveJobVariants(
  admin: AdminGraphqlClient,
  filterType: JobFilterType,
  filterValue: string,
): Promise<ResolvedVariant[]> {
  if (filterType === "manual") {
    const variantIds: string[] = JSON.parse(filterValue);
    return resolveVariantsByIds(admin, variantIds);
  }
  if (filterType === "csv") {
    throw new Error("CSV jobs build their item list directly, not via resolveJobVariants");
  }
  if (filterType === "advanced") {
    return resolveVariantsByQuery(admin, searchQueryForAdvancedFilter(filterValue));
  }
  return resolveVariantsByQuery(admin, searchQueryForFilter(filterType, filterValue));
}

/** Builds a price-change preview (no DB writes) for the wizard's review step. */
export function buildPreview(params: {
  mode: JobMode;
  targetField: JobTargetField;
  value: number;
  variants: ResolvedVariant[];
}): JobItemPreview[] {
  const { mode, targetField, value, variants } = params;

  return variants.map((v) => {
    const oldPrice = Number(v.price);
    const oldCompareAtPrice = v.compareAtPrice !== null ? Number(v.compareAtPrice) : null;
    const { newPrice, newCompareAtPrice } = computeUpdatedPrices({
      mode,
      targetField,
      value,
      oldPrice,
      oldCompareAtPrice,
    });

    return {
      variantId: v.variantId,
      productId: v.productId,
      sku: v.sku,
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
      status: runAt && runAt.getTime() > Date.now() ? "scheduled" : "draft",
      items: {
        create: items.map((item) => ({
          variantId: item.variantId,
          productId: item.productId,
          sku: item.sku,
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
    const conflicting = await tx.priceJobItem.findFirst({
      where: {
        variantId: { in: variantIds },
        jobId: { not: jobId },
        job: { status: "running" },
      },
    });

    if (conflicting) {
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

    return tx.priceJob.update({
      where: { id: jobId },
      data: { status: "running" },
      include: { items: true },
    });
  });
}

/** Writes one batch's outcome to the job's items as soon as Shopify answers, so the job page can show live progress. */
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
        data: { status: "error", errorMessage: f.error },
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

  const rule: PriceRule = {
    mode: job.mode,
    targetField: job.targetField,
    value: job.value !== null ? Number(job.value) : 0,
    skipExistingCompareAt: job.skipExistingCompareAt,
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
              data: { status: "error", errorMessage: f.error },
            }),
          );
        }
        if (ops.length) await prisma.$transaction(ops);
      },
    );
  }
}

/** Sets a job's final status from its variants' and market prices' outcomes. */
async function finishJob(jobId: string) {
  const total = await prisma.priceJobItem.count({ where: { jobId } });
  const errors = await prisma.priceJobItem.count({ where: { jobId, status: "error" } });
  const marketErrors = await prisma.priceJobMarketPrice.count({
    where: { status: "error", item: { jobId } },
  });

  const messages = [];
  if (errors) messages.push(`${errors} of ${total} variants failed to update.`);
  if (marketErrors) messages.push(`${marketErrors} market prices failed to update.`);

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
async function applyItemsAndFinish(admin: AdminGraphqlClient, jobId: string, items: JobItemRow[]) {
  activeJobIds.add(jobId);
  try {
    const { succeeded, failed } = await applyVariantPriceUpdates(
      admin,
      items.map((item) => ({
        variantId: item.variantId,
        productId: item.productId,
        price: item.newPrice.toString(),
        compareAtPrice: item.newCompareAtPrice?.toString() ?? null,
      })),
      (batch) => recordBatch(jobId, "applied", batch),
    );

    await applyMarketRows(admin, jobId, "applied");
    await finishJob(jobId);

    return { succeeded, failed };
  } finally {
    activeJobIds.delete(jobId);
  }
}

export async function executeJob(admin: AdminGraphqlClient, jobId: string) {
  const job = await claimJobForExecution(jobId);
  if (!job) return;
  // Read market fixed prices before anything changes, so revert can restore them.
  await ensureMarketRows(admin, jobId, job.items);
  return applyItemsAndFinish(admin, jobId, job.items);
}

/**
 * For a completed job that ran before market prices were supported: changes
 * the market fixed prices (e.g. UK GBP) of every variant the job updated, so
 * they match. Revert then restores them along with the base prices.
 */
export async function applyMissingMarketPrices(
  admin: AdminGraphqlClient,
  jobId: string,
  skipExistingCompareAt: boolean,
) {
  const job = await prisma.priceJob.findUnique({ where: { id: jobId }, include: { items: true } });
  if (!job || job.status !== "completed" || job.marketPricesRecorded || activeJobIds.has(jobId)) {
    return;
  }

  activeJobIds.add(jobId);
  try {
    await prisma.priceJob.update({
      where: { id: jobId },
      data: { status: "running", skipExistingCompareAt },
    });
    await ensureMarketRows(
      admin,
      jobId,
      job.items.filter((i) => i.status === "applied"),
    );
    await applyMarketRows(admin, jobId, "applied");
    await finishJob(jobId);
    return { succeeded: [], failed: [] };
  } finally {
    activeJobIds.delete(jobId);
  }
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


function sameMoney(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 0.005;
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
  try {
    const pending = job.items.filter((i) => i.status === "pending");
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
      const price = Number(live.price);
      const compareAt = live.compareAtPrice !== null ? Number(live.compareAtPrice) : null;
      const newCompareAt = item.newCompareAtPrice !== null ? Number(item.newCompareAtPrice) : null;
      const oldCompareAt = item.oldCompareAtPrice !== null ? Number(item.oldCompareAtPrice) : null;

      // A null new compare-at means the job doesn't touch it, so any value matches.
      const isNew =
        sameMoney(price, Number(item.newPrice)) &&
        (newCompareAt === null || sameMoney(compareAt, newCompareAt));
      const isOld = sameMoney(price, Number(item.oldPrice)) && sameMoney(compareAt, oldCompareAt);

      if (isNew) alreadyApplied.push(item.variantId);
      else if (isOld) toApply.push(item);
      else
        errors.push({
          variantId: item.variantId,
          error: `Skipped: price was changed outside this job (now ${live.price}${live.compareAtPrice ? `, compare-at ${live.compareAtPrice}` : ""}).`,
        });
    }

    await recordBatch(jobId, "applied", { succeeded: alreadyApplied, failed: errors });
    // Jobs that started before market prices were supported have no market
    // rows yet. Their market fixed prices were never touched, so reading them
    // now still gives the right "old" values.
    await ensureMarketRows(admin, jobId, job.items);
    console.log(
      `[jobs] resuming job ${jobId}: ${alreadyApplied.length} already applied, ${toApply.length} to apply, ${errors.length} skipped`,
    );
  } catch (error) {
    activeJobIds.delete(jobId);
    throw error;
  }
  activeJobIds.delete(jobId);

  return applyItemsAndFinish(admin, jobId, toApply);
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

export async function revertJob(admin: AdminGraphqlClient, jobId: string) {
  const job = await prisma.priceJob.findUnique({ where: { id: jobId }, include: { items: true } });
  if (!job || job.status !== "completed") {
    throw new Error("Only completed jobs can be reverted.");
  }

  const appliedItems = job.items.filter((i) => i.status === "applied");

  const { succeeded, failed } = await applyVariantPriceUpdates(
    admin,
    appliedItems.map((item) => ({
      variantId: item.variantId,
      productId: item.productId,
      price: item.oldPrice.toString(),
      compareAtPrice: item.oldCompareAtPrice?.toString() ?? null,
    })),
    (batch) => recordBatch(jobId, "reverted", batch),
  );

  await applyMarketRows(admin, jobId, "reverted");
  const marketErrors = await prisma.priceJobMarketPrice.count({
    where: { status: "applied", item: { jobId } },
  });

  await prisma.$transaction([
    prisma.priceJob.update({
      where: { id: jobId },
      data: {
        status: "reverted",
        revertedAt: new Date(),
        errorMessage:
          [
            failed.length ? `${failed.length} of ${appliedItems.length} variants failed to revert.` : "",
            marketErrors ? `${marketErrors} market prices failed to revert.` : "",
          ]
            .filter(Boolean)
            .join(" ") || null,
      },
    }),
  ]);

  return { succeeded, failed };
}
