import prisma from "../db.server";
import {
  applyVariantPriceUpdates,
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

function searchQueryForFilter(filterType: JobFilterType, filterValue: string): string {
  switch (filterType) {
    case "collection":
      return `collection_id:${filterValue}`;
    case "tag":
      return `tag:'${filterValue.replace(/'/g, "")}'`;
    case "vendor":
      return `vendor:'${filterValue.replace(/'/g, "")}'`;
    case "productType":
      return `product_type:'${filterValue.replace(/'/g, "")}'`;
    default:
      throw new Error(`searchQueryForFilter does not support filterType ${filterType}`);
  }
}

/** Resolves the variant set for a non-CSV job (collection/tag/vendor/productType/manual). */
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
  );

  const failedMap = new Map(failed.map((f) => [f.variantId, f.error]));

  await prisma.$transaction([
    ...job.items.map((item) =>
      prisma.priceJobItem.update({
        where: { id: item.id },
        data: failedMap.has(item.variantId)
          ? { status: "error", errorMessage: failedMap.get(item.variantId) }
          : { status: "applied" },
      }),
    ),
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
  );

  const failedMap = new Map(failed.map((f) => [f.variantId, f.error]));

  await prisma.$transaction([
    ...appliedItems.map((item) =>
      prisma.priceJobItem.update({
        where: { id: item.id },
        data: failedMap.has(item.variantId)
          ? { status: "error", errorMessage: failedMap.get(item.variantId) }
          : { status: "reverted" },
      }),
    ),
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
