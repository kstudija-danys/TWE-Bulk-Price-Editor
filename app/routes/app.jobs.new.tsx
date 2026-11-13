import { useState } from "react";
import type { ActionFunctionArgs } from "@remix-run/node";
import { useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  FormLayout,
  Select,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Text,
  DataTable,
  Banner,
  Checkbox,
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
import type { JobMode, JobTargetField } from "../lib/pricing";
import type { JobFilterType } from "@prisma/client";

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

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResponse> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = formData.get("intent") as "preview" | "create";
  const name = formData.get("name") as string;
  const mode = formData.get("mode") as JobMode;
  const targetField = formData.get("targetField") as JobTargetField;
  const value = Number(formData.get("value"));
  const filterType = formData.get("filterType") as JobFilterType;
  const filterValue = formData.get("filterValue") as string;
  const runAtRaw = formData.get("runAt") as string;
  const revertAtRaw = formData.get("revertAt") as string;
  const skipExistingCompareAt = formData.get("skipExistingCompareAt") === "true";

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

    const items = buildPreview({ mode, targetField, value, variants });

    if (intent === "preview") {
      const allMarketChanges = await previewMarketChanges(
        admin,
        { mode, targetField, value, skipExistingCompareAt },
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

const FILTER_OPTIONS = [
  { label: "Filter by tag / vendor / product type / collection", value: "advanced" },
  { label: "Manual product selection", value: "manual" },
];

const COMBINATOR_OPTIONS = [
  { label: "ANY of these (OR)", value: "OR" },
  { label: "ALL of these (AND)", value: "AND" },
];

const MODE_OPTIONS = [
  { label: "Percentage change (e.g. -10 or 15)", value: "percent" },
  { label: "Fixed amount change (e.g. -5 or 2.50)", value: "fixed" },
  { label: "Set to exact value", value: "setvalue" },
];

const TARGET_OPTIONS = [
  { label: "Price", value: "price" },
  { label: "Compare-at price", value: "compareAtPrice" },
  { label: "Both", value: "both" },
];

export default function NewJob() {
  const fetcher = useFetcher<ActionResponse>();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [name, setName] = useState("");
  const [filterType, setFilterType] = useState("advanced");
  const [combinator, setCombinator] = useState<"AND" | "OR">("OR");
  const [tagsInput, setTagsInput] = useState("");
  const [vendorsInput, setVendorsInput] = useState("");
  const [productTypesInput, setProductTypesInput] = useState("");
  const [collections, setCollections] = useState<{ id: string; title: string }[]>([]);
  const [manualFilterValue, setManualFilterValue] = useState("");
  const [mode, setMode] = useState("percent");
  const [targetField, setTargetField] = useState("price");
  const [value, setValue] = useState("");
  const [runAt, setRunAt] = useState("");
  const [revertAt, setRevertAt] = useState("");
  const [skipExistingCompareAt, setSkipExistingCompareAt] = useState(false);

  const isLoading = fetcher.state !== "idle";
  const preview = fetcher.data?.intent === "preview" ? fetcher.data.items : null;
  const skippedCount = fetcher.data?.intent === "preview" ? fetcher.data.skippedCount ?? 0 : 0;
  const marketChanges = fetcher.data?.intent === "preview" ? fetcher.data.marketChanges ?? {} : {};
  const marketChangeCount =
    fetcher.data?.intent === "preview" ? fetcher.data.marketChangeCount ?? 0 : 0;
  const previewError = fetcher.data?.error;

  if (fetcher.data?.intent === "create" && fetcher.data.jobId) {
    shopify.toast.show("Price change job created");
    navigate(`/app/jobs/${fetcher.data.jobId}`);
  }

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

  async function pickCollections() {
    const selection = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      action: "select",
    });
    if (!selection) return;
    setCollections(
      selection.map((c) => ({ id: c.id, title: c.title ?? c.id })),
    );
  }

  function splitList(input: string): string[] {
    return input
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function buildFilterValue(): string {
    if (filterType === "manual") return manualFilterValue;
    return JSON.stringify({
      combinator,
      tags: splitList(tagsInput),
      vendors: splitList(vendorsInput),
      productTypes: splitList(productTypesInput),
      collectionIds: collections.map((c) => c.id),
    });
  }

  const advancedCriteriaCount =
    splitList(tagsInput).length +
    splitList(vendorsInput).length +
    splitList(productTypesInput).length +
    collections.length;

  const canSubmit =
    filterType === "manual" ? Boolean(manualFilterValue) : advancedCriteriaCount > 0;

  function submit(intent: "preview" | "create") {
    fetcher.submit(
      {
        intent,
        name,
        mode,
        targetField,
        value,
        filterType,
        filterValue: buildFilterValue(),
        runAt,
        revertAt,
        skipExistingCompareAt: String(skipExistingCompareAt),
      },
      { method: "POST" },
    );
  }

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
                {advancedCriteriaCount > 1 && (
                  <Select
                    label="Combine criteria"
                    options={COMBINATOR_OPTIONS}
                    value={combinator}
                    onChange={(v) => setCombinator(v as "AND" | "OR")}
                  />
                )}
                <TextField
                  label="Tags (comma separated)"
                  placeholder="sale, clearance"
                  value={tagsInput}
                  onChange={setTagsInput}
                  autoComplete="off"
                />
                <TextField
                  label="Vendors (comma separated)"
                  value={vendorsInput}
                  onChange={setVendorsInput}
                  autoComplete="off"
                />
                <TextField
                  label="Product types (comma separated)"
                  value={productTypesInput}
                  onChange={setProductTypesInput}
                  autoComplete="off"
                />
                <BlockStack gap="200">
                  <Button onClick={pickCollections}>Pick collections</Button>
                  <Text as="span" tone="subdued">
                    {collections.length
                      ? collections.map((c) => c.title).join(", ")
                      : "No collections selected"}
                  </Text>
                </BlockStack>
              </BlockStack>
            )}

            <Select label="Rule" options={MODE_OPTIONS} value={mode} onChange={setMode} />
            <Select
              label="Apply to"
              options={TARGET_OPTIONS}
              value={targetField}
              onChange={setTargetField}
            />
            <TextField
              label={
                mode === "percent"
                  ? "Percent change"
                  : mode === "fixed"
                    ? "Amount change"
                    : "New value"
              }
              type="number"
              value={value}
              onChange={setValue}
              autoComplete="off"
            />
            {mode === "percent" && targetField === "price" && Number(value) < 0 && (
              <Banner tone="info">
                This is a markdown — compare-at-price will be set to each
                variant's current price automatically, so the discount shows
                with a strikethrough.
              </Banner>
            )}
            <Checkbox
              label="Skip products that already have a compare-at price"
              helpText="Variants with an existing compare-at price are left completely unchanged (price and compare-at), so an existing sale isn't overwritten."
              checked={skipExistingCompareAt}
              onChange={setSkipExistingCompareAt}
            />

            <TextField
              label="Run at (leave blank to run immediately)"
              type="datetime-local"
              value={runAt}
              onChange={setRunAt}
              autoComplete="off"
            />
            <TextField
              label="Auto-revert at (optional)"
              type="datetime-local"
              value={revertAt}
              onChange={setRevertAt}
              autoComplete="off"
            />

            <InlineStack gap="300">
              <Button onClick={() => submit("preview")} loading={isLoading} disabled={!canSubmit || !value}>
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
              <DataTable
                columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "text"]}
                headings={[
                  "SKU",
                  "Old price",
                  "New price",
                  "Old compare-at",
                  "New compare-at",
                  "Market fixed prices",
                ]}
                rows={preview.slice(0, PREVIEW_ROWS).map((item) => [
                  item.sku ?? "—",
                  item.oldPrice.toFixed(2),
                  item.newPrice.toFixed(2),
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
