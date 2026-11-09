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

export async function executeJob(admin: AdminGraphqlClient, jobId: string) {
  const job = await claimJobForExecution(jobId);
  if (!job) return;

  const { succeeded, failed } = await applyVariantPriceUpdates(
    admin,
    job.items.map((item) => ({
      variantId: item.variantId,
      productId: item.productId,
      price: item.newPrice.toString(),
      compareAtPrice: item.newCompareAtPrice?.toString() ?? null,
    })),
    (batch) => recordBatch(jobId, "applied", batch),
  );

  await prisma.$transaction([
    prisma.priceJob.update({
      where: { id: jobId },
      data: {
        status: failed.length === job.items.length && job.items.length > 0 ? "failed" : "completed",
        completedAt: new Date(),
        errorMessage: failed.length
          ? `${failed.length} of ${job.items.length} variants failed to update.`
          : null,
      },
    }),
  ]);

  return { succeeded, failed };
}

/**
 * Starts a job without waiting for it, so large jobs don't hold the browser
 * request open for minutes. Progress is written per batch and shown on the
 * job page. Uses an offline admin client so it keeps working after the
 * request that started it has returned.
 */
export function executeJobInBackground(shopName: string, jobId: string) {
  void (async () => {
    try {
      const { admin } = await unauthenticated.admin(shopName);
      const result = await executeJob(admin, jobId);
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
