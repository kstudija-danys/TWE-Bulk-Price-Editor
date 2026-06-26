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
export async function applyVariantPriceUpdates(
  admin: AdminGraphqlClient,
  updates: VariantPriceUpdate[],
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
              compareAtPrice: u.compareAtPrice ?? undefined,
            })),
          },
        );

        const userErrors = json.data?.productVariantsBulkUpdate?.userErrors ?? [];
        if (userErrors.length) {
          const message = userErrors
            .map((e: { message: string }) => e.message)
            .join("; ");
          for (const u of batch) failed.push({ variantId: u.variantId, error: message });
          continue;
        }

        const updatedIds = new Set(
          (json.data?.productVariantsBulkUpdate?.productVariants ?? []).map(
            (v: { id: string }) => v.id,
          ),
        );
        for (const u of batch) {
          if (updatedIds.has(u.variantId)) succeeded.push(u.variantId);
          else failed.push({ variantId: u.variantId, error: "Not returned by Shopify" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const u of batch) failed.push({ variantId: u.variantId, error: message });
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
};

const VARIANT_FRAGMENT = `
  id
  price
  compareAtPrice
  sku
  product {
    id
  }
`;

/**
 * Resolves all variants matching a Shopify product search query
 * (e.g. "tag:'sale'", "vendor:'Nike'", "collection_id:123").
 */
export async function resolveVariantsByQuery(
  admin: AdminGraphqlClient,
  searchQuery: string,
): Promise<ResolvedVariant[]> {
  const results: ResolvedVariant[] = [];
  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const json = await graphqlWithRetry(
      admin,
      `#graphql
      query bulkPriceEditorProducts($query: String!, $after: String) {
        products(first: 50, after: $after, query: $query) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              variants(first: 100) {
                edges {
                  node {
                    ${VARIANT_FRAGMENT}
                  }
                }
              }
            }
          }
        }
      }`,
      { query: searchQuery, after },
    );

    const products = json.data?.products;
    for (const productEdge of products?.edges ?? []) {
      for (const variantEdge of productEdge.node.variants.edges) {
        const v = variantEdge.node;
        results.push({
          variantId: v.id,
          productId: v.product.id,
          sku: v.sku,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
        });
      }
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
): Promise<ResolvedVariant[]> {
  const results: ResolvedVariant[] = [];

  for (const batch of chunk(variantIds, 100)) {
    const json = await graphqlWithRetry(
      admin,
      `#graphql
      query bulkPriceEditorVariantsByIds($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            ${VARIANT_FRAGMENT}
          }
        }
      }`,
      { ids: batch },
    );

    for (const node of json.data?.nodes ?? []) {
      if (!node) continue;
      results.push({
        variantId: node.id,
        productId: node.product.id,
        sku: node.sku,
        price: node.price,
        compareAtPrice: node.compareAtPrice,
      });
    }
  }

  return results;
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
      query bulkPriceEditorVariantsBySku($query: String!) {
        productVariants(first: 100, query: $query) {
          edges {
            node {
              ${VARIANT_FRAGMENT}
            }
          }
        }
      }`,
      { query: searchQuery },
    );

    for (const edge of json.data?.productVariants?.edges ?? []) {
      const v = edge.node;
      results.push({
        variantId: v.id,
        productId: v.product.id,
        sku: v.sku,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
      });
    }
  }

  return results;
}
