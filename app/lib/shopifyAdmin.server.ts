// Thin wrapper around the Admin GraphQL client for the variant price mutations
// this app needs, with batching (Shopify allows max 250 variants per
// productVariantsBulkUpdate call) and retry-on-throttle.

type AdminGraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

const MAX_VARIANTS_PER_CALL = 250;
const MAX_RETRIES = 5;

async function graphqlWithRetry(
  admin: AdminGraphqlClient,
  query: string,
  variables: Record<string, unknown>,
) {
  let attempt = 0;
  for (;;) {
    const response = await admin.graphql(query, { variables });
    const json = await response.json();

    const throttled = json.errors?.some(
      (e: { extensions?: { code?: string } }) =>
        e.extensions?.code === "THROTTLED",
    );

    if (throttled && attempt < MAX_RETRIES) {
      attempt += 1;
      const waitMs = Math.min(1000 * 2 ** attempt, 10_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    if (json.errors?.length) {
      throw new Error(
        `Admin GraphQL error: ${json.errors.map((e: { message: string }) => e.message).join("; ")}`,
      );
    }

    return json;
  }
}

export type VariantPriceUpdate = {
  variantId: string;
  productId: string;
  price?: string;
  /** A value sets it, null clears it, undefined leaves it as it is. */
  compareAtPrice?: string | null;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Applies variant price/compareAtPrice updates. Groups by productId (the
 * mutation is scoped to one product per call) and batches within that.
 * Returns the variant ids that failed, with their error messages.
 */
export type BatchResult = {
  succeeded: string[];
  failed: { variantId: string; error: string }[];
};

export async function applyVariantPriceUpdates(
  admin: AdminGraphqlClient,
  updates: VariantPriceUpdate[],
  /** Called after each Shopify call with that batch's results, so callers can record progress. */
  onBatchDone?: (result: BatchResult) => Promise<void>,
): Promise<{ succeeded: string[]; failed: { variantId: string; error: string }[] }> {
  const byProduct = new Map<string, VariantPriceUpdate[]>();
  for (const update of updates) {
    const list = byProduct.get(update.productId) ?? [];
    list.push(update);
    byProduct.set(update.productId, list);
  }

  const succeeded: string[] = [];
  const failed: { variantId: string; error: string }[] = [];

  for (const [productId, productUpdates] of byProduct) {
    for (const batch of chunk(productUpdates, MAX_VARIANTS_PER_CALL)) {
      const batchSucceeded: string[] = [];
      const batchFailed: { variantId: string; error: string }[] = [];
      try {
        const json = await graphqlWithRetry(
          admin,
          `#graphql
          mutation bulkUpdateVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants {
                id
              }
              userErrors {
                field
                message
              }
            }
          }`,
          {
            productId,
            variants: batch.map((u) => ({
              id: u.variantId,
              price: u.price,
              // Kept as-is: null must reach Shopify to clear a compare-at
              // price; undefined is dropped from the JSON and changes nothing.
              compareAtPrice: u.compareAtPrice,
            })),
          },
        );

        const userErrors = json.data?.productVariantsBulkUpdate?.userErrors ?? [];
        if (userErrors.length) {
          const message = userErrors
            .map((e: { message: string }) => e.message)
            .join("; ");
          for (const u of batch) batchFailed.push({ variantId: u.variantId, error: message });
        } else {
          const updatedIds = new Set(
            (json.data?.productVariantsBulkUpdate?.productVariants ?? []).map(
              (v: { id: string }) => v.id,
            ),
          );
          for (const u of batch) {
            if (updatedIds.has(u.variantId)) batchSucceeded.push(u.variantId);
            else batchFailed.push({ variantId: u.variantId, error: "Not returned by Shopify" });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const u of batch) batchFailed.push({ variantId: u.variantId, error: message });
      }

      succeeded.push(...batchSucceeded);
      failed.push(...batchFailed);
      if (onBatchDone) {
        await onBatchDone({ succeeded: batchSucceeded, failed: batchFailed });
      }
    }
  }

  return { succeeded, failed };
}

export type ResolvedVariant = {
  variantId: string;
  productId: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  variantTitle: string;
  productTitle: string;
  /** ACTIVE / DRAFT / ARCHIVED */
  productStatus: string;
  tags: string[];
  vendor: string;
  productType: string;
  /** Only fetched when a stock filter needs it; null otherwise. */
  inventoryQuantity: number | null;
};

const PRODUCT_FIELDS = `
  id
  title
  status
  tags
  vendor
  productType
`;

// inventoryQuantity is only requested when a stock filter is used.
const VARIANT_FIELDS = `
  id
  title
  price
  compareAtPrice
  sku
  inventoryQuantity @include(if: $withInventory)
`;

const VARIANT_FRAGMENT = `
  ${VARIANT_FIELDS}
  product {
    ${PRODUCT_FIELDS}
  }
`;

type ProductNode = {
  id: string;
  title: string;
  status: string;
  tags: string[];
  vendor: string;
  productType: string;
};

type VariantNode = {
  id: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  sku: string | null;
  inventoryQuantity?: number | null;
};

function toResolved(v: VariantNode, product: ProductNode): ResolvedVariant {
  return {
    variantId: v.id,
    productId: product.id,
    sku: v.sku,
    price: v.price,
    compareAtPrice: v.compareAtPrice,
    variantTitle: v.title,
    productTitle: product.title,
    productStatus: product.status,
    tags: product.tags ?? [],
    vendor: product.vendor ?? "",
    productType: product.productType ?? "",
    inventoryQuantity: v.inventoryQuantity ?? null,
  };
}

/** Fetches the variants after the first page, for products with more than 100. */
async function fetchRemainingVariants(
  admin: AdminGraphqlClient,
  productId: string,
  after: string,
  withInventory: boolean,
): Promise<VariantNode[]> {
  const out: VariantNode[] = [];
  let cursor: string | null = after;
  while (cursor) {
    const json = await graphqlWithRetry(
      admin,
      `#graphql
      query bulkPriceEditorMoreVariants($id: ID!, $after: String, $withInventory: Boolean!) {
        product(id: $id) {
          variants(first: 100, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ${VARIANT_FIELDS}
            }
          }
        }
      }`,
      { id: productId, after: cursor, withInventory },
    );
    const variants = json.data?.product?.variants;
    out.push(...(variants?.nodes ?? []));
    cursor = variants?.pageInfo?.hasNextPage ? variants.pageInfo.endCursor : null;
  }
  return out;
}

/**
 * Resolves all variants matching a Shopify product search query
 * (e.g. "tag:'sale'", "vendor:'Nike'", "collection_id:123"). An empty query
 * matches every product.
 */
export async function resolveVariantsByQuery(
  admin: AdminGraphqlClient,
  searchQuery: string,
  withInventory = false,
): Promise<ResolvedVariant[]> {
  const results: ResolvedVariant[] = [];
  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const json = await graphqlWithRetry(
      admin,
      `#graphql
      query bulkPriceEditorProducts($query: String!, $after: String, $withInventory: Boolean!) {
        products(first: 50, after: $after, query: $query) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            ${PRODUCT_FIELDS}
            variants(first: 100) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                ${VARIANT_FIELDS}
              }
            }
          }
        }
      }`,
      { query: searchQuery, after, withInventory },
    );

    const products = json.data?.products;
    for (const product of products?.nodes ?? []) {
      const variants: VariantNode[] = [...product.variants.nodes];
      if (product.variants.pageInfo?.hasNextPage) {
        variants.push(
          ...(await fetchRemainingVariants(
            admin,
            product.id,
            product.variants.pageInfo.endCursor,
            withInventory,
          )),
        );
      }
      for (const v of variants) results.push(toResolved(v, product));
    }

    hasNextPage = products?.pageInfo?.hasNextPage ?? false;
    after = products?.pageInfo?.endCursor ?? null;
  }

  return results;
}

/** Resolves an explicit list of variant gids (manual selection). */
export async function resolveVariantsByIds(
  admin: AdminGraphqlClient,
  variantIds: string[],
  withInventory = false,
): Promise<ResolvedVariant[]> {
  const results: ResolvedVariant[] = [];

  for (const batch of chunk(variantIds, 100)) {
    const json = await graphqlWithRetry(
      admin,
      `#graphql
      query bulkPriceEditorVariantsByIds($ids: [ID!]!, $withInventory: Boolean!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            ${VARIANT_FRAGMENT}
          }
        }
      }`,
      { ids: batch, withInventory },
    );

    for (const node of json.data?.nodes ?? []) {
      if (!node?.product) continue;
      results.push(toResolved(node, node.product));
    }
  }

  return results;
}

/** The ids of every product in any of the given collections. */
export async function fetchProductIdsInCollections(
  admin: AdminGraphqlClient,
  collectionIds: string[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (collectionIds.length === 0) return ids;
  const query = collectionIds
    .map((c) => `collection_id:${c.includes("/") ? c.split("/").pop() : c}`)
    .join(" OR ");

  let after: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const json = await graphqlWithRetry(
      admin,
      `#graphql
      query bulkPriceEditorProductIds($query: String!, $after: String) {
        products(first: 250, after: $after, query: $query) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
          }
        }
      }`,
      { query, after },
    );
    const products = json.data?.products;
    for (const p of products?.nodes ?? []) ids.add(p.id);
    hasNextPage = products?.pageInfo?.hasNextPage ?? false;
    after = products?.pageInfo?.endCursor ?? null;
  }
  return ids;
}

export type ProductFacets = { tags: string[]; vendors: string[]; productTypes: string[] };

/** Every product tag, vendor and product type in the store, for the filter pickers. */
export async function fetchProductFacets(admin: AdminGraphqlClient): Promise<ProductFacets> {
  const facets: ProductFacets = { tags: [], vendors: [], productTypes: [] };
  const fields = [
    ["productTags", "tags"],
    ["productVendors", "vendors"],
    ["productTypes", "productTypes"],
  ] as const;

  for (const [field, key] of fields) {
    let after: string | null = null;
    // Capped so a store with a huge number of tags can't stall the page.
    for (let page = 0; page < 20; page++) {
      const json = await graphqlWithRetry(
        admin,
        `#graphql
        query bulkPriceEditorFacets($after: String) {
          ${field}(first: 250, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes
          }
        }`,
        { after },
      );
      const conn = json.data?.[field];
      facets[key].push(...((conn?.nodes ?? []) as string[]).filter(Boolean));
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  }
  return facets;
}

/** Resolves variants by SKU (used by CSV import when variant_id isn't supplied). */
export async function resolveVariantsBySkus(
  admin: AdminGraphqlClient,
  skus: string[],
): Promise<ResolvedVariant[]> {
  const results: ResolvedVariant[] = [];

  for (const batch of chunk(skus, 50)) {
    const searchQuery = batch.map((sku) => `sku:'${sku.replace(/'/g, "")}'`).join(" OR ");
    const json = await graphqlWithRetry(
      admin,
      `#graphql
      query bulkPriceEditorVariantsBySku($query: String!, $withInventory: Boolean!) {
        productVariants(first: 100, query: $query) {
          edges {
            node {
              ${VARIANT_FRAGMENT}
            }
          }
        }
      }`,
      { query: searchQuery, withInventory: false },
    );

    for (const edge of json.data?.productVariants?.edges ?? []) {
      results.push(toResolved(edge.node, edge.node.product));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Market fixed prices
//
// A market (e.g. United Kingdom) can give a variant a fixed price in its own
// currency. That price overrides the base price in that market, so changing
// the base price alone does nothing there.
// ---------------------------------------------------------------------------

export type MarketFixedPrice = {
  priceListId: string;
  marketName: string;
  currency: string;
  price: string;
  compareAtPrice: string | null;
};

/** Returns every market fixed price for the given variants, keyed by variant id. */
export async function fetchMarketFixedPrices(
  admin: AdminGraphqlClient,
  variantIds: string[],
): Promise<Map<string, MarketFixedPrice[]>> {
  const wanted = new Set(variantIds);
  const out = new Map<string, MarketFixedPrice[]>();
  if (wanted.size === 0) return out;

  const marketsJson = await graphqlWithRetry(
    admin,
    `#graphql
    query bulkPriceEditorMarketPriceLists {
      markets(first: 100) {
        nodes {
          name
          catalogs(first: 10) {
            nodes {
              ... on MarketCatalog {
                priceList {
                  id
                  currency
                  fixedPricesCount
                }
              }
            }
          }
        }
      }
    }`,
    {},
  );

  const priceLists = new Map<string, { marketName: string; currency: string }>();
  for (const market of marketsJson.data?.markets?.nodes ?? []) {
    for (const catalog of market.catalogs?.nodes ?? []) {
      const pl = catalog?.priceList;
      if (pl && pl.fixedPricesCount > 0 && !priceLists.has(pl.id)) {
        priceLists.set(pl.id, { marketName: market.name, currency: pl.currency });
      }
    }
  }

  for (const [priceListId, info] of priceLists) {
    let after: string | null = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const json = await graphqlWithRetry(
        admin,
        `#graphql
        query bulkPriceEditorFixedPrices($id: ID!, $after: String) {
          priceList(id: $id) {
            prices(first: 100, after: $after, originType: FIXED) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                variant {
                  id
                }
                price {
                  amount
                }
                compareAtPrice {
                  amount
                }
              }
            }
          }
        }`,
        { id: priceListId, after },
      );

      const prices = json.data?.priceList?.prices;
      for (const node of prices?.nodes ?? []) {
        const variantId = node.variant?.id;
        if (!variantId || !wanted.has(variantId)) continue;
        const list = out.get(variantId) ?? [];
        list.push({
          priceListId,
          marketName: info.marketName,
          currency: info.currency,
          price: node.price.amount,
          compareAtPrice: node.compareAtPrice?.amount ?? null,
        });
        out.set(variantId, list);
      }
      hasNextPage = prices?.pageInfo?.hasNextPage ?? false;
      after = prices?.pageInfo?.endCursor ?? null;
    }
  }

  return out;
}

export type FixedPriceUpdate = {
  variantId: string;
  currency: string;
  price: string;
  compareAtPrice: string | null;
};

/**
 * Overwrites fixed prices in one market price list. A null compare-at
 * price leaves the fixed price without one.
 */
export async function applyFixedPriceUpdates(
  admin: AdminGraphqlClient,
  priceListId: string,
  updates: FixedPriceUpdate[],
  onBatchDone?: (result: BatchResult) => Promise<void>,
): Promise<BatchResult> {
  const succeeded: string[] = [];
  const failed: { variantId: string; error: string }[] = [];

  for (const batch of chunk(updates, MAX_VARIANTS_PER_CALL)) {
    const batchSucceeded: string[] = [];
    const batchFailed: { variantId: string; error: string }[] = [];
    try {
      const json = await graphqlWithRetry(
        admin,
        `#graphql
        mutation bulkPriceEditorFixedPricesUpdate(
          $priceListId: ID!
          $pricesToAdd: [PriceListPriceInput!]!
        ) {
          priceListFixedPricesUpdate(
            priceListId: $priceListId
            pricesToAdd: $pricesToAdd
            variantIdsToDelete: []
          ) {
            pricesAdded {
              variant {
                id
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          priceListId,
          pricesToAdd: batch.map((u) => ({
            variantId: u.variantId,
            price: { amount: u.price, currencyCode: u.currency },
            ...(u.compareAtPrice !== null
              ? { compareAtPrice: { amount: u.compareAtPrice, currencyCode: u.currency } }
              : {}),
          })),
        },
      );

      const userErrors = json.data?.priceListFixedPricesUpdate?.userErrors ?? [];
      if (userErrors.length) {
        const message = userErrors.map((e: { message: string }) => e.message).join("; ");
        for (const u of batch) batchFailed.push({ variantId: u.variantId, error: message });
      } else {
        const added = new Set(
          (json.data?.priceListFixedPricesUpdate?.pricesAdded ?? []).map(
            (p: { variant: { id: string } }) => p.variant.id,
          ),
        );
        for (const u of batch) {
          if (added.has(u.variantId)) batchSucceeded.push(u.variantId);
          else batchFailed.push({ variantId: u.variantId, error: "Not returned by Shopify" });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const u of batch) batchFailed.push({ variantId: u.variantId, error: message });
    }

    succeeded.push(...batchSucceeded);
    failed.push(...batchFailed);
    if (onBatchDone) await onBatchDone({ succeeded: batchSucceeded, failed: batchFailed });
  }

  return { succeeded, failed };
}

// ---------------------------------------------------------------------------
// Product tags (sale tag added while a job's change is live)
// ---------------------------------------------------------------------------

/**
 * Adds or removes one tag on each of the given products. Returns the products
 * that failed, with the reason.
 */
export async function setProductTag(
  admin: AdminGraphqlClient,
  productIds: string[],
  tag: string,
  action: "add" | "remove",
): Promise<{ productId: string; error: string; definite: boolean }[]> {
  // definite: Shopify answered and refused. Otherwise (network error, timeout)
  // the change may or may not have gone through.
  const failed: { productId: string; error: string; definite: boolean }[] = [];
  const mutation =
    action === "add"
      ? `#graphql
        mutation bulkPriceEditorTagsAdd($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            userErrors {
              message
            }
          }
        }`
      : `#graphql
        mutation bulkPriceEditorTagsRemove($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) {
            userErrors {
              message
            }
          }
        }`;
  const field = action === "add" ? "tagsAdd" : "tagsRemove";

  for (const productId of productIds) {
    try {
      const json = await graphqlWithRetry(admin, mutation, { id: productId, tags: [tag] });
      const errors = json.data?.[field]?.userErrors ?? [];
      if (errors.length) {
        failed.push({
          productId,
          error: errors.map((e: { message: string }) => e.message).join("; "),
          definite: true,
        });
      }
    } catch (error) {
      failed.push({
        productId,
        error: error instanceof Error ? error.message : String(error),
        definite: false,
      });
    }
  }
  return failed;
}

/** Titles of the given nodes (e.g. collections), keyed by id. Missing nodes are left out. */
export async function fetchNodeTitles(
  admin: AdminGraphqlClient,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const batch of chunk(ids, 100)) {
    const json = await graphqlWithRetry(
      admin,
      `#graphql
      query bulkPriceEditorNodeTitles($ids: [ID!]!) {
        nodes(ids: $ids) {
          id
          ... on Collection {
            title
          }
        }
      }`,
      { ids: batch },
    );
    for (const node of json.data?.nodes ?? []) {
      if (node?.id && node.title) out.set(node.id, node.title);
    }
  }
  return out;
}

/** Each product's current tags, keyed by product id. Missing products are left out. */
export async function fetchProductTags(
  admin: AdminGraphqlClient,
  productIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const batch of chunk(productIds, 100)) {
    const json = await graphqlWithRetry(
      admin,
      `#graphql
      query bulkPriceEditorProductTags($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            tags
          }
        }
      }`,
      { ids: batch },
    );
    for (const node of json.data?.nodes ?? []) {
      if (node?.id) out.set(node.id, node.tags ?? []);
    }
  }
  return out;
}
