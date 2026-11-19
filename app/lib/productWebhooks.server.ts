// Instant "apply to new products": Shopify tells us when a product is created
// or changed (products/create, products/update). We collect the product ids
// per shop for a short while, then check just those products against every
// job set to "apply to products that match later".
//
// Collecting first matters: a bulk import or our own price/tag changes fire
// one webhook per product, and one search per burst is far cheaper than one
// per event. The every-15-minutes full check in the scheduler stays as a
// safety net for anything missed here (e.g. a server restart mid-wait).
import prisma from "../db.server";
import {
  applyToNewProductsInBackground,
  canApplyToNewProducts,
  isJobActiveInThisProcess,
} from "./jobs.server";

/** How long to collect product events before checking them. */
const DEBOUNCE_MS = 20_000;
/** Retry delay when a job is busy (e.g. still applying its last batch). */
const BUSY_RETRY_MS = 60_000;

/** "*" = check against every auto-apply job of the shop; otherwise one job (a retry). */
type Target = "*" | string;
type Pending = { productIds: Set<string>; timer: ReturnType<typeof setTimeout> };

declare global {
  var productWebhookQueue: Map<string, Pending> | undefined;
}
// Keyed by `${shop} ${target}`.
const queue = (global.productWebhookQueue ??= new Map<string, Pending>());

/** Records that a product was created or changed; checks happen shortly after. */
export function queueProductCheck(
  shop: string,
  productId: string,
  delayMs = DEBOUNCE_MS,
  target: Target = "*",
) {
  queueProducts(shop, [productId], delayMs, target);
}

function queueProducts(shop: string, productIds: string[], delayMs: number, target: Target) {
  const key = `${shop} ${target}`;
  const pending = queue.get(key);
  if (pending) {
    for (const id of productIds) pending.productIds.add(id);
    return;
  }
  const ids = new Set(productIds);
  const timer = setTimeout(() => {
    queue.delete(key);
    flush(shop, [...ids], target).catch((error) =>
      console.error(`[webhooks] product check for ${shop} failed`, error),
    );
  }, delayMs);
  queue.set(key, { productIds: ids, timer });
}

async function flush(shop: string, productIds: string[], target: Target) {
  const jobs = await prisma.priceJob.findMany({
    where: {
      shopName: shop,
      autoApplyNewProducts: true,
      status: { in: ["completed", "running"] },
      ...(target === "*" ? {} : { id: target }),
    },
    select: { id: true, status: true, filterType: true, revertAt: true },
  });

  for (const job of jobs) {
    // Busy applying an earlier batch: check these products for this job
    // only, once it's done. Other jobs aren't re-checked.
    const retryLater = () => queueProducts(shop, productIds, BUSY_RETRY_MS, job.id);
    if (job.status === "running") {
      if (isJobActiveInThisProcess(job.id)) retryLater();
      continue;
    }
    if (!canApplyToNewProducts(job)) continue;
    applyToNewProductsInBackground(shop, job.id, productIds, retryLater);
  }
}
