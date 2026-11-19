import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  Select,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  DataTable,
  Banner,
  Checkbox,
  ChoiceList,
  Collapsible,
  Divider,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  buildPreview,
  createJob,
  executeJobInBackground,
  previewMarketChanges,
  resolveJobVariants,
  type MarketPriceChange,
} from "../lib/jobs.server";
import { fetchProductFacets, type ProductFacets } from "../lib/shopifyAdmin.server";
import {
  ROUNDINGS,
  type JobMode,
  type JobTargetField,
  type PricingOptions,
  type Rounding,
} from "../lib/pricing";
import type { AdvancedFilter, ProductStatus, StockFilter } from "../lib/filters";
import { MultiValuePicker } from "../components/MultiValuePicker";
import type { JobFilterType } from "@prisma/client";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  // The pickers still work (free text) if this fails, so don't block the page.
  let facets: ProductFacets = { tags: [], vendors: [], productTypes: [] };
  try {
    facets = await fetchProductFacets(admin);
  } catch (error) {
    console.error("[jobs.new] couldn't load tags/vendors/product types", error);
  }
  return { facets };
};

type ActionResponse = {
  intent: "preview" | "create";
  items?: ReturnType<typeof buildPreview>;
  skippedCount?: number;
  /** Market fixed-price changes for the variants shown in the preview, keyed by variant id. */
  marketChanges?: Record<string, MarketPriceChange[]>;
  marketChangeCount?: number;
  jobId?: string;
  error?: string;
};

function optionalNumber(raw: FormDataEntryValue | null): number | null {
  if (raw === null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResponse> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = formData.get("intent") as "preview" | "create";
  const name = formData.get("name") as string;
  const mode = formData.get("mode") as JobMode;
  const targetField: JobTargetField =
    mode === "compareAtMarkup" ? "compareAtPrice" : (formData.get("targetField") as JobTargetField);
  const value = Number(formData.get("value"));
  const filterType = formData.get("filterType") as JobFilterType;
  const filterValue = formData.get("filterValue") as string;
  // The browser sends these as ISO timestamps (with the merchant's timezone
  // already applied), so they mean the same moment on a UTC server.
  const runAtRaw = formData.get("runAt") as string;
  const revertAtRaw = formData.get("revertAt") as string;
  const skipExistingCompareAt = formData.get("skipExistingCompareAt") === "true";
  const rounding = formData.get("rounding") as Rounding;
  const options: PricingOptions = {
    rounding: ROUNDINGS.includes(rounding) ? rounding : "none",
    minPrice: optionalNumber(formData.get("minPrice")),
    maxDiscountPercent: optionalNumber(formData.get("maxDiscountPercent")),
  };

  if (!Number.isFinite(value)) {
    return { intent, error: "Enter a valid number for the change." };
  }

  try {
    const allVariants = await resolveJobVariants(admin, filterType, filterValue);
    if (allVariants.length === 0) {
      return { intent, items: [], error: "No matching variants found for this filter." };
    }

    // Optionally leave variants that already have a compare-at price untouched,
    // so an existing sale/strikethrough price is never overwritten.
    const variants = skipExistingCompareAt
      ? allVariants.filter((v) => !hasCompareAtPrice(v.compareAtPrice))
      : allVariants;
    const skippedCount = allVariants.length - variants.length;

    if (variants.length === 0) {
      return {
        intent,
        items: [],
        skippedCount,
        error: `All ${skippedCount} matching variant(s) already have a compare-at price, so nothing would change.`,
      };
    }

    const items = buildPreview({ mode, targetField, value, options, variants });

    if (intent === "preview") {
      const allMarketChanges = await previewMarketChanges(
        admin,
        { mode, targetField, value, skipExistingCompareAt, options },
        items,
      );
      const shown = new Set(items.slice(0, PREVIEW_ROWS).map((i) => i.variantId));
      const marketChanges = Object.fromEntries(
        Object.entries(allMarketChanges).filter(([variantId]) => shown.has(variantId)),
      );
      const marketChangeCount = Object.values(allMarketChanges).reduce(
        (n, list) => n + list.length,
        0,
      );
      return { intent, items, skippedCount, marketChanges, marketChangeCount };
    }

    const runAt = runAtRaw ? new Date(runAtRaw) : null;
    const revertAt = revertAtRaw ? new Date(revertAtRaw) : null;
    if (revertAt && revertAt.getTime() <= (runAt ?? new Date()).getTime()) {
      return { intent, error: "Auto-revert must be after the time the change runs." };
    }

    const job = await createJob({
      shopName: session.shop,
      name,
      mode,
      targetField,
      value,
      filterType,
      filterValue,
      runAt,
      revertAt,
      skipExistingCompareAt,
      options,
      items,
    });

    if (!runAt || runAt.getTime() <= Date.now()) {
      // Don't wait: the job page shows live progress while it runs.
      executeJobInBackground(session.shop, job.id);
    }

    return { intent, jobId: job.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { intent, error: message };
  }
};

const PREVIEW_ROWS = 100;

function formatMarketChanges(changes: MarketPriceChange[] | undefined): string {
  if (!changes?.length) return "—";
  return changes
    .map(
      (c) =>
        `${c.marketName}: ${c.oldPrice.toFixed(2)} → ${c.newPrice.toFixed(2)} ${c.currency}` +
        (c.newCompareAtPrice !== c.oldCompareAtPrice
          ? ` (compare-at ${c.newCompareAtPrice?.toFixed(2) ?? "none"})`
          : ""),
    )
    .join("; ");
}

function hasCompareAtPrice(compareAtPrice: string | null): boolean {
  return compareAtPrice !== null && Number(compareAtPrice) > 0;
}

function percentChange(oldValue: number, newValue: number): string {
  if (oldValue === 0) return "—";
  const pct = ((newValue - oldValue) / oldValue) * 100;
  if (Math.abs(pct) < 0.05) return "0%";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** A datetime-local value (merchant's local time) as an ISO timestamp, or "". */
function localToIso(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

const FILTER_OPTIONS = [
  { label: "Filter by tag / vendor / product type / collection", value: "advanced" },
  { label: "Manual product selection", value: "manual" },
];

const COMBINATOR_OPTIONS = [
  { label: "Match ANY of the criteria", value: "OR" },
  { label: "Match ALL the fields (any value within each field)", value: "AND" },
];

const MODE_OPTIONS = [
  { label: "Percentage change (e.g. -10 or 15)", value: "percent" },
  { label: "Fixed amount change (e.g. -5 or 2.50)", value: "fixed" },
  { label: "Set to exact value", value: "setvalue" },
  { label: "Set compare-at = price + X% (e.g. 20)", value: "compareAtMarkup" },
];

const TARGET_OPTIONS = [
  { label: "Price", value: "price" },
  { label: "Compare-at price", value: "compareAtPrice" },
  { label: "Both", value: "both" },
];

const ROUNDING_OPTIONS: { label: string; value: Rounding }[] = [
  { label: "No rounding", value: "none" },
  { label: "End in .99 (e.g. 44.99)", value: "99" },
  { label: "End in .95 (e.g. 44.95)", value: "95" },
  { label: "Whole number (e.g. 45.00)", value: "00" },
  { label: "Nearest 5 (e.g. 45.00, 50.00)", value: "5" },
];

const STATUS_CHOICES: { label: string; value: ProductStatus }[] = [
  { label: "Active", value: "ACTIVE" },
  { label: "Draft", value: "DRAFT" },
  { label: "Archived", value: "ARCHIVED" },
];

const STOCK_OPTIONS: { label: string; value: StockFilter }[] = [
  { label: "Any stock level", value: "any" },
  { label: "In stock only", value: "inStock" },
  { label: "Out of stock only", value: "outOfStock" },
];

type Collection = { id: string; title: string };

export default function NewJob() {
  const { facets } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResponse>();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [name, setName] = useState("");
  const [filterType, setFilterType] = useState("advanced");
  const [combinator, setCombinator] = useState<"AND" | "OR">("OR");
  const [tags, setTags] = useState<string[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [productTypes, setProductTypes] = useState<string[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [excludeTags, setExcludeTags] = useState<string[]>([]);
  const [excludeVendors, setExcludeVendors] = useState<string[]>([]);
  const [excludeProductTypes, setExcludeProductTypes] = useState<string[]>([]);
  const [excludeCollections, setExcludeCollections] = useState<Collection[]>([]);
  const [statuses, setStatuses] = useState<ProductStatus[]>(["ACTIVE"]);
  const [minPriceFilter, setMinPriceFilter] = useState("");
  const [maxPriceFilter, setMaxPriceFilter] = useState("");
  const [skuContains, setSkuContains] = useState("");
  const [titleContains, setTitleContains] = useState("");
  const [stock, setStock] = useState<StockFilter>("any");
  const [showExclude, setShowExclude] = useState(false);
  const [showRefine, setShowRefine] = useState(false);
  const [manualFilterValue, setManualFilterValue] = useState("");
  const [mode, setMode] = useState("percent");
  const [targetField, setTargetField] = useState("price");
  const [value, setValue] = useState("");
  const [rounding, setRounding] = useState<Rounding>("none");
  const [minPrice, setMinPrice] = useState("");
  const [maxDiscountPercent, setMaxDiscountPercent] = useState("");
  const [runAt, setRunAt] = useState("");
  const [revertAt, setRevertAt] = useState("");
  const [skipExistingCompareAt, setSkipExistingCompareAt] = useState(false);

  const isLoading = fetcher.state !== "idle";
  const isPreview = fetcher.data?.intent === "preview";
  const preview = isPreview ? fetcher.data?.items ?? null : null;
  const skippedCount = isPreview ? fetcher.data?.skippedCount ?? 0 : 0;
  const marketChanges = isPreview ? fetcher.data?.marketChanges ?? {} : {};
  const marketChangeCount = isPreview ? fetcher.data?.marketChangeCount ?? 0 : 0;
  const previewError = fetcher.data?.error;
  const createdJobId = fetcher.data?.intent === "create" ? fetcher.data.jobId : undefined;

  useEffect(() => {
    if (!createdJobId) return;
    shopify.toast.show("Price change job created");
    navigate(`/app/jobs/${createdJobId}`);
  }, [createdJobId, navigate, shopify]);

  const timeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "your local time";
    }
  }, []);

  async function pickProductVariants() {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
    });
    if (!selection) return;
    const variantIds: string[] = [];
    for (const product of selection) {
      for (const variant of product.variants ?? []) {
        if (variant.id) variantIds.push(variant.id);
      }
    }
    setManualFilterValue(JSON.stringify(variantIds));
  }

  async function pickCollections(current: Collection[], set: (c: Collection[]) => void) {
    const selection = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      action: "select",
      selectionIds: current.map((c) => ({ id: c.id })),
    });
    if (!selection) return;
    set(selection.map((c) => ({ id: c.id, title: c.title ?? c.id })));
  }

  function numberOrNull(input: string): number | null {
    if (input.trim() === "") return null;
    const n = Number(input);
    return Number.isFinite(n) ? n : null;
  }

  function buildFilterValue(): string {
    if (filterType === "manual") return manualFilterValue;
    const filter: AdvancedFilter = {
      combinator,
      tags,
      vendors,
      productTypes,
      collectionIds: collections.map((c) => c.id),
      exclude: {
        tags: excludeTags,
        vendors: excludeVendors,
        productTypes: excludeProductTypes,
        collectionIds: excludeCollections.map((c) => c.id),
      },
      statuses,
      minPrice: numberOrNull(minPriceFilter),
      maxPrice: numberOrNull(maxPriceFilter),
      skuContains: skuContains.trim(),
      titleContains: titleContains.trim(),
      stock,
    };
    return JSON.stringify(filter);
  }

  const includeFieldCount = [tags, vendors, productTypes, collections].filter(
    (list) => list.length > 0,
  ).length;
  const includeCount = tags.length + vendors.length + productTypes.length + collections.length;
  const excludeCount =
    excludeTags.length +
    excludeVendors.length +
    excludeProductTypes.length +
    excludeCollections.length;
  const refineCount =
    (statuses.length && statuses.length < 3 ? 1 : 0) +
    (minPriceFilter ? 1 : 0) +
    (maxPriceFilter ? 1 : 0) +
    (skuContains.trim() ? 1 : 0) +
    (titleContains.trim() ? 1 : 0) +
    (stock !== "any" ? 1 : 0);

  const canSubmit = filterType === "manual" ? Boolean(manualFilterValue) : true;
  const isMarkup = mode === "compareAtMarkup";
  const effectiveTarget = isMarkup ? "compareAtPrice" : targetField;
  const lowersPrice =
    (mode === "percent" || mode === "fixed") && Number(value) < 0 && effectiveTarget !== "compareAtPrice";

  function submit(intent: "preview" | "create") {
    fetcher.submit(
      {
        intent,
        name,
        mode,
        targetField: effectiveTarget,
        value,
        filterType,
        filterValue: buildFilterValue(),
        runAt: localToIso(runAt),
        revertAt: localToIso(revertAt),
        skipExistingCompareAt: String(skipExistingCompareAt),
        rounding,
        minPrice,
        maxDiscountPercent,
      },
      { method: "POST" },
    );
  }

  const previewStats = useMemo(() => {
    if (!preview?.length) return null;
    const changed = preview.filter(
      (i) => i.newPrice !== i.oldPrice || i.newCompareAtPrice !== i.oldCompareAtPrice,
    ).length;
    const oldTotal = preview.reduce((n, i) => n + i.oldPrice, 0);
    const newTotal = preview.reduce((n, i) => n + i.newPrice, 0);
    return { changed, unchanged: preview.length - changed, avg: percentChange(oldTotal, newTotal) };
  }, [preview]);

  return (
    <Page>
      <TitleBar title="New price change" />
      <BlockStack gap="400">
        <Card>
          <FormLayout>
            <TextField
              label="Name (optional)"
              placeholder="e.g. Summer sale — riding gear -15%"
              value={name}
              onChange={setName}
              autoComplete="off"
            />
            <Select
              label="Target by"
              options={FILTER_OPTIONS}
              value={filterType}
              onChange={setFilterType}
            />
            {filterType === "manual" ? (
              <BlockStack gap="200">
                <Button onClick={pickProductVariants}>Pick products</Button>
                <Text as="span" tone="subdued">
                  {manualFilterValue
                    ? `${JSON.parse(manualFilterValue).length} variant(s) selected`
                    : "No products selected"}
                </Text>
              </BlockStack>
            ) : (
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Include products
                </Text>
                {includeFieldCount > 1 && (
                  <Select
                    label="Combine criteria"
                    options={COMBINATOR_OPTIONS}
                    value={combinator}
                    onChange={(v) => setCombinator(v as "AND" | "OR")}
                    helpText={
                      combinator === "AND"
                        ? "e.g. tagged sale OR clearance, AND by vendor Alpinestars."
                        : "A product matching any single tag, vendor, type or collection is included."
                    }
                  />
                )}
                <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                  <MultiValuePicker
                    label="Tags"
                    options={facets.tags}
                    selected={tags}
                    onChange={setTags}
                    placeholder="Search tags"
                  />
                  <MultiValuePicker
                    label="Vendors"
                    options={facets.vendors}
                    selected={vendors}
                    onChange={setVendors}
                    placeholder="Search vendors"
                  />
                  <MultiValuePicker
                    label="Product types"
                    options={facets.productTypes}
                    selected={productTypes}
                    onChange={setProductTypes}
                    placeholder="Search product types"
                  />
                  <BlockStack gap="100">
                    <Text as="span">Collections</Text>
                    <InlineStack gap="200" blockAlign="center">
                      <Button onClick={() => pickCollections(collections, setCollections)}>
                        Pick collections
                      </Button>
                      {collections.length > 0 && (
                        <Button variant="plain" onClick={() => setCollections([])}>
                          Clear
                        </Button>
                      )}
                    </InlineStack>
                    <Text as="span" tone="subdued">
                      {collections.length
                        ? collections.map((c) => c.title).join(", ")
                        : "No collections selected"}
                    </Text>
                  </BlockStack>
                </InlineGrid>
                {includeCount === 0 && (
                  <Banner tone="warning">
                    No include criteria: this targets every product in the store that
                    passes the exclusions and refinements below. Preview before applying.
                  </Banner>
                )}

                <Divider />
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    Exclude products{excludeCount ? ` (${excludeCount})` : ""}
                  </Text>
                  <Button variant="plain" onClick={() => setShowExclude((s) => !s)}>
                    {showExclude ? "Hide" : "Show"}
                  </Button>
                </InlineStack>
                <Collapsible open={showExclude} id="exclude-section">
                  <BlockStack gap="300">
                    <Text as="p" tone="subdued">
                      Products matching any of these are always left out, e.g. a
                      "no-discount" tag or a vendor with fixed pricing.
                    </Text>
                    <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                      <MultiValuePicker
                        label="Exclude tags"
                        options={facets.tags}
                        selected={excludeTags}
                        onChange={setExcludeTags}
                        placeholder="e.g. no-discount"
                      />
                      <MultiValuePicker
                        label="Exclude vendors"
                        options={facets.vendors}
                        selected={excludeVendors}
                        onChange={setExcludeVendors}
                      />
                      <MultiValuePicker
                        label="Exclude product types"
                        options={facets.productTypes}
                        selected={excludeProductTypes}
                        onChange={setExcludeProductTypes}
                      />
                      <BlockStack gap="100">
                        <Text as="span">Exclude collections</Text>
                        <InlineStack gap="200" blockAlign="center">
                          <Button
                            onClick={() => pickCollections(excludeCollections, setExcludeCollections)}
                          >
                            Pick collections
                          </Button>
                          {excludeCollections.length > 0 && (
                            <Button variant="plain" onClick={() => setExcludeCollections([])}>
                              Clear
                            </Button>
                          )}
                        </InlineStack>
                        <Text as="span" tone="subdued">
                          {excludeCollections.length
                            ? excludeCollections.map((c) => c.title).join(", ")
                            : "None"}
                        </Text>
                      </BlockStack>
                    </InlineGrid>
                  </BlockStack>
                </Collapsible>

                <Divider />
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    Refine{refineCount ? ` (${refineCount})` : ""}
                  </Text>
                  <Button variant="plain" onClick={() => setShowRefine((s) => !s)}>
                    {showRefine ? "Hide" : "Show"}
                  </Button>
                </InlineStack>
                {!showRefine && statuses.length === 1 && statuses[0] === "ACTIVE" && (
                  <Text as="p" tone="subdued">
                    Active products only.
                  </Text>
                )}
                <Collapsible open={showRefine} id="refine-section">
                  <BlockStack gap="300">
                    <ChoiceList
                      title="Product status"
                      allowMultiple
                      choices={STATUS_CHOICES}
                      selected={statuses}
                      onChange={(v) => setStatuses(v as ProductStatus[])}
                    />
                    <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                      <TextField
                        label="Current price from"
                        type="number"
                        value={minPriceFilter}
                        onChange={setMinPriceFilter}
                        autoComplete="off"
                      />
                      <TextField
                        label="Current price to"
                        type="number"
                        value={maxPriceFilter}
                        onChange={setMaxPriceFilter}
                        autoComplete="off"
                      />
                      <TextField
                        label="SKU contains"
                        placeholder="e.g. ALP-"
                        value={skuContains}
                        onChange={setSkuContains}
                        autoComplete="off"
                      />
                      <TextField
                        label="Product title contains"
                        placeholder="e.g. helmet"
                        value={titleContains}
                        onChange={setTitleContains}
                        autoComplete="off"
                      />
                    </InlineGrid>
                    <Select
                      label="Stock"
                      options={STOCK_OPTIONS}
                      value={stock}
                      onChange={(v) => setStock(v as StockFilter)}
                      helpText="Uses each variant's available quantity in Shopify (all locations)."
                    />
                  </BlockStack>
                </Collapsible>
              </BlockStack>
            )}
          </FormLayout>
        </Card>

        <Card>
          <FormLayout>
            <Text as="h3" variant="headingSm">
              Price rule
            </Text>
            <Select label="Rule" options={MODE_OPTIONS} value={mode} onChange={setMode} />
            {!isMarkup && (
              <Select
                label="Apply to"
                options={TARGET_OPTIONS}
                value={targetField}
                onChange={setTargetField}
              />
            )}
            <TextField
              label={
                mode === "percent"
                  ? "Percent change"
                  : mode === "fixed"
                    ? "Amount change"
                    : isMarkup
                      ? "Compare-at is price plus this percent"
                      : "New value"
              }
              type="number"
              value={value}
              onChange={setValue}
              autoComplete="off"
            />
            {lowersPrice && targetField === "price" && (
              <Banner tone="info">
                This is a markdown — compare-at price will be set to each variant's current
                price so the discount shows with a strikethrough. Variants already on sale
                keep their existing (higher) compare-at price.
              </Banner>
            )}
            <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
              <Select
                label="Rounding"
                options={ROUNDING_OPTIONS}
                value={rounding}
                onChange={(v) => setRounding(v as Rounding)}
              />
              <TextField
                label="Never lower prices below"
                type="number"
                value={minPrice}
                onChange={setMinPrice}
                autoComplete="off"
                helpText="Optional floor, in base currency"
              />
              <TextField
                label="Max discount %"
                type="number"
                value={maxDiscountPercent}
                onChange={setMaxDiscountPercent}
                autoComplete="off"
                helpText="Optional, e.g. 40"
              />
            </InlineGrid>
            <Checkbox
              label="Skip products that already have a compare-at price"
              helpText="Variants with an existing compare-at price are left completely unchanged (price and compare-at), so an existing sale isn't overwritten."
              checked={skipExistingCompareAt}
              onChange={setSkipExistingCompareAt}
            />

            <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
              <TextField
                label="Run at (leave blank to run immediately)"
                type="datetime-local"
                value={runAt}
                onChange={setRunAt}
                autoComplete="off"
                helpText={`Times are in ${timeZone}.`}
              />
              <TextField
                label="Auto-revert at (optional)"
                type="datetime-local"
                value={revertAt}
                onChange={setRevertAt}
                autoComplete="off"
              />
            </InlineGrid>

            <InlineStack gap="300">
              <Button
                onClick={() => submit("preview")}
                loading={isLoading}
                disabled={!canSubmit || !value}
              >
                Preview
              </Button>
              <Button
                variant="primary"
                onClick={() => submit("create")}
                loading={isLoading}
                disabled={!canSubmit || !value}
              >
                {runAt ? "Schedule price change" : "Apply price change"}
              </Button>
            </InlineStack>
          </FormLayout>
        </Card>

        {previewError && <Banner tone="critical">{previewError}</Banner>}

        {preview && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Preview ({preview.length} variant{preview.length === 1 ? "" : "s"})
              </Text>
              {previewStats && (
                <Text as="p" tone="subdued">
                  {previewStats.changed} will change
                  {previewStats.unchanged ? `, ${previewStats.unchanged} stay the same` : ""} ·
                  average price change {previewStats.avg}
                </Text>
              )}
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "numeric",
                  "numeric",
                  "numeric",
                  "numeric",
                  "numeric",
                  "text",
                ]}
                headings={[
                  "Product",
                  "SKU",
                  "Old price",
                  "New price",
                  "Change",
                  "Old compare-at",
                  "New compare-at",
                  "Market fixed prices",
                ]}
                rows={preview.slice(0, PREVIEW_ROWS).map((item) => [
                  item.variantTitle && item.variantTitle !== "Default Title"
                    ? `${item.productTitle} — ${item.variantTitle}`
                    : item.productTitle ?? "—",
                  item.sku ?? "—",
                  item.oldPrice.toFixed(2),
                  item.newPrice.toFixed(2),
                  percentChange(item.oldPrice, item.newPrice),
                  item.oldCompareAtPrice?.toFixed(2) ?? "—",
                  item.newCompareAtPrice?.toFixed(2) ?? "—",
                  formatMarketChanges(marketChanges[item.variantId]),
                ])}
              />
              {marketChangeCount > 0 && (
                <Text as="span" tone="subdued">
                  Also changing {marketChangeCount} market fixed price
                  {marketChangeCount === 1 ? "" : "s"} (e.g. UK prices in GBP), by the same
                  proportion as the base price.
                </Text>
              )}
              {skippedCount > 0 && (
                <Text as="span" tone="subdued">
                  Skipping {skippedCount} variant{skippedCount === 1 ? "" : "s"} that
                  already {skippedCount === 1 ? "has" : "have"} a compare-at price.
                </Text>
              )}
              {preview.length > PREVIEW_ROWS && (
                <Text as="span" tone="subdued">
                  Showing first {PREVIEW_ROWS} of {preview.length} variants.
                </Text>
              )}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
