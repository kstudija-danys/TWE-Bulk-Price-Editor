// Product/variant filtering for "advanced" jobs. Pure functions: turning a
// filter into a Shopify product search query, and the variant-level checks
// Shopify search can't do reliably (exclusions, price range, SKU/title text,
// stock), which run on the variants the query returned.

/** How often jobs set to "also apply to products that match later" check for new products. */
export const SYNC_INTERVAL_MINUTES = 15;

export type ProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";
export type StockFilter = "any" | "inStock" | "outOfStock";

export type FilterCriteria = {
  tags: string[];
  vendors: string[];
  productTypes: string[];
  collectionIds: string[];
};

export type AdvancedFilter = FilterCriteria & {
  /**
   * How the include criteria combine. Values within one field always match
   * ANY of them; "AND" then requires every field that has values to match
   * (e.g. tag sale-or-clearance AND vendor Alpinestars).
   */
  combinator: "AND" | "OR";
  exclude: FilterCriteria;
  /** Empty = any status. */
  statuses: ProductStatus[];
  /** Current price range (inclusive), base currency. */
  minPrice: number | null;
  maxPrice: number | null;
  /** Case-insensitive "contains" on the variant SKU. */
  skuContains: string;
  /** Case-insensitive "contains" on the product title. */
  titleContains: string;
  stock: StockFilter;
  /**
   * Filters saved before per-field matching existed: their "AND" required
   * every single value (e.g. both tags), so re-running them keeps that.
   */
  legacyAllValues?: boolean;
};

/** The subset of a resolved variant that filtering looks at. */
export type FilterableVariant = {
  productId: string;
  sku: string | null;
  price: string;
  productTitle: string;
  productStatus: string;
  tags: string[];
  vendor: string;
  productType: string;
  inventoryQuantity: number | null;
};

const emptyCriteria = (): FilterCriteria => ({
  tags: [],
  vendors: [],
  productTypes: [],
  collectionIds: [],
});

/** Parses a stored filter, filling in fields that older jobs didn't have. */
export function parseAdvancedFilter(filterValue: string): AdvancedFilter {
  const raw = JSON.parse(filterValue) as Partial<AdvancedFilter>;
  return {
    combinator: raw.combinator === "AND" ? "AND" : "OR",
    tags: raw.tags ?? [],
    vendors: raw.vendors ?? [],
    productTypes: raw.productTypes ?? [],
    collectionIds: raw.collectionIds ?? [],
    exclude: { ...emptyCriteria(), ...(raw.exclude ?? {}) },
    statuses: raw.statuses ?? [],
    minPrice: raw.minPrice ?? null,
    maxPrice: raw.maxPrice ?? null,
    skuContains: raw.skuContains ?? "",
    titleContains: raw.titleContains ?? "",
    stock: raw.stock ?? "any",
    legacyAllValues: raw.statuses === undefined && raw.combinator === "AND",
  };
}

function escapeQueryValue(value: string): string {
  return value.replace(/['"\\]/g, "");
}

export function numericId(gid: string): string {
  return gid.includes("/") ? (gid.split("/").pop() as string) : gid;
}

function anyOf(clauses: string[]): string | null {
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

/**
 * The Shopify product search query for a filter's include criteria and
 * statuses. An empty string means "all products".
 */
export function buildProductSearchQuery(filter: AdvancedFilter): string {
  const fields = [
    filter.tags.map((t) => `tag:'${escapeQueryValue(t)}'`),
    filter.vendors.map((v) => `vendor:'${escapeQueryValue(v)}'`),
    filter.productTypes.map((p) => `product_type:'${escapeQueryValue(p)}'`),
    filter.collectionIds.map((c) => `collection_id:${numericId(c)}`),
  ];

  const include = filter.legacyAllValues
    ? fields.flat().join(" AND ")
    : filter.combinator === "AND"
      ? fields
          .map(anyOf)
          .filter((g): g is string => g !== null)
          .join(" AND ")
      : (anyOf(fields.flat()) ?? "");

  const status = anyOf(filter.statuses.map((s) => `status:${s.toLowerCase()}`));

  return [include, status].filter(Boolean).join(" AND ");
}

export function hasIncludeCriteria(filter: AdvancedFilter): boolean {
  return (
    filter.tags.length +
      filter.vendors.length +
      filter.productTypes.length +
      filter.collectionIds.length >
    0
  );
}

const lower = (s: string) => s.trim().toLowerCase();

/**
 * Applies the variant-level parts of a filter. `excludedProductIds` are the
 * products in the excluded collections (looked up separately).
 */
export function applyVariantFilters<T extends FilterableVariant>(
  variants: T[],
  filter: AdvancedFilter,
  excludedProductIds: Set<string> = new Set(),
): T[] {
  const exTags = new Set(filter.exclude.tags.map(lower));
  const exVendors = new Set(filter.exclude.vendors.map(lower));
  const exTypes = new Set(filter.exclude.productTypes.map(lower));
  const statuses = new Set(filter.statuses);
  const sku = lower(filter.skuContains);
  const title = lower(filter.titleContains);

  return variants.filter((v) => {
    if (excludedProductIds.has(v.productId)) return false;
    if (exTags.size && v.tags.some((t) => exTags.has(lower(t)))) return false;
    if (exVendors.has(lower(v.vendor))) return false;
    if (exTypes.has(lower(v.productType))) return false;
    if (statuses.size && !statuses.has(v.productStatus as ProductStatus)) return false;

    const price = Number(v.price);
    if (filter.minPrice !== null && price < filter.minPrice) return false;
    if (filter.maxPrice !== null && price > filter.maxPrice) return false;

    if (sku && !(v.sku ?? "").toLowerCase().includes(sku)) return false;
    if (title && !v.productTitle.toLowerCase().includes(title)) return false;

    if (filter.stock !== "any" && v.inventoryQuantity !== null) {
      const inStock = v.inventoryQuantity > 0;
      if (filter.stock === "inStock" ? !inStock : inStock) return false;
    }
    return true;
  });
}

const STOCK_LABEL: Record<StockFilter, string> = {
  any: "",
  inStock: "in stock only",
  outOfStock: "out of stock only",
};

/** A one-line, human-readable summary of an advanced filter, for the job page. */
export function describeAdvancedFilter(filterValue: string): string {
  let f: AdvancedFilter;
  try {
    f = parseAdvancedFilter(filterValue);
  } catch {
    return "";
  }
  const list = (label: string, values: string[]) =>
    values.length ? `${label} ${values.join(" / ")}` : null;
  const count = (label: string, ids: string[]) =>
    ids.length ? `${ids.length} ${label}${ids.length === 1 ? "" : "s"}` : null;

  const include = [
    list("tag", f.tags),
    list("vendor", f.vendors),
    list("type", f.productTypes),
    count("collection", f.collectionIds),
  ].filter(Boolean);
  const exclude = [
    list("tag", f.exclude.tags),
    list("vendor", f.exclude.vendors),
    list("type", f.exclude.productTypes),
    count("collection", f.exclude.collectionIds),
  ].filter(Boolean);

  const parts = [
    include.length ? include.join(f.combinator === "AND" ? " AND " : " OR ") : "All products",
    exclude.length ? `excluding ${exclude.join(", ")}` : null,
    f.statuses.length && f.statuses.length < 3
      ? `status ${f.statuses.map((s) => s.toLowerCase()).join("/")}`
      : null,
    f.minPrice !== null || f.maxPrice !== null
      ? `price ${f.minPrice ?? 0}–${f.maxPrice ?? "∞"}`
      : null,
    f.skuContains ? `SKU contains "${f.skuContains}"` : null,
    f.titleContains ? `title contains "${f.titleContains}"` : null,
    STOCK_LABEL[f.stock] || null,
  ].filter(Boolean);
  return parts.join(" · ");
}
