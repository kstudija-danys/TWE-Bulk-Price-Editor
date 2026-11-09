import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  applyVariantPriceUpdates,
  type BatchResult,
  resolveVariantsByIds,
  resolveVariantsByQuery,
  type ResolvedVariant,
} from "./shopifyAdmin.server";
import { computeUpdatedPrices, type JobMode, type JobTargetField } from "./pricing";
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

/** Applies the given items' new prices, records progress per batch, then sets the job's final status from all its items. */
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

    const total = await prisma.priceJobItem.count({ where: { jobId } });
    const errors = await prisma.priceJobItem.count({ where: { jobId, status: "error" } });

    await prisma.priceJob.update({
      where: { id: jobId },
      data: {
        status: errors === total && total > 0 ? "failed" : "completed",
        completedAt: new Date(),
        errorMessage: errors ? `${errors} of ${total} variants failed to update.` : null,
      },
    });

    return { succeeded, failed };
  } finally {
    activeJobIds.delete(jobId);
  }
}

export async function executeJob(admin: AdminGraphqlClient, jobId: string) {
  const job = await claimJobForExecution(jobId);
  if (!job) return;
  return applyItemsAndFinish(admin, jobId, job.items);
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

  await prisma.$transaction([
    prisma.priceJob.update({
      where: { id: jobId },
      data: {
        status: "reverted",
        revertedAt: new Date(),
        errorMessage: failed.length
          ? `${failed.length} of ${appliedItems.length} variants failed to revert.`
          : null,
      },
    }),
  ]);

  return { succeeded, failed };
}
