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
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { buildPreview, createJob, executeJob, resolveJobVariants } from "../lib/jobs.server";
import type { JobMode, JobTargetField } from "../lib/pricing";
import type { JobFilterType } from "@prisma/client";

type ActionResponse = {
  intent: "preview" | "create";
  items?: ReturnType<typeof buildPreview>;
  jobId?: string;
  error?: string;
};

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResponse> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = formData.get("intent") as "preview" | "create";
  const mode = formData.get("mode") as JobMode;
  const targetField = formData.get("targetField") as JobTargetField;
  const value = Number(formData.get("value"));
  const filterType = formData.get("filterType") as JobFilterType;
  const filterValue = formData.get("filterValue") as string;
  const runAtRaw = formData.get("runAt") as string;
  const revertAtRaw = formData.get("revertAt") as string;

  try {
    const variants = await resolveJobVariants(admin, filterType, filterValue);
    if (variants.length === 0) {
      return { intent, items: [], error: "No matching variants found for this filter." };
    }

    const items = buildPreview({ mode, targetField, value, variants });

    if (intent === "preview") {
      return { intent, items };
    }

    const runAt = runAtRaw ? new Date(runAtRaw) : null;
    const revertAt = revertAtRaw ? new Date(revertAtRaw) : null;

    const job = await createJob({
      shopName: session.shop,
      mode,
      targetField,
      value,
      filterType,
      filterValue,
      runAt,
      revertAt,
      items,
    });

    if (!runAt || runAt.getTime() <= Date.now()) {
      await executeJob(admin, job.id);
    }

    return { intent, jobId: job.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { intent, error: message };
  }
};

const FILTER_OPTIONS = [
  { label: "Collection (ID)", value: "collection" },
  { label: "Tag", value: "tag" },
  { label: "Vendor", value: "vendor" },
  { label: "Product type", value: "productType" },
  { label: "Manual (variant GIDs, comma separated)", value: "manual" },
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

  const [filterType, setFilterType] = useState("collection");
  const [filterValue, setFilterValue] = useState("");
  const [mode, setMode] = useState("percent");
  const [targetField, setTargetField] = useState("price");
  const [value, setValue] = useState("");
  const [runAt, setRunAt] = useState("");
  const [revertAt, setRevertAt] = useState("");

  const isLoading = fetcher.state !== "idle";
  const preview = fetcher.data?.intent === "preview" ? fetcher.data.items : null;
  const previewError = fetcher.data?.error;

  if (fetcher.data?.intent === "create" && fetcher.data.jobId) {
    shopify.toast.show("Price change job created");
    navigate(`/app/jobs/${fetcher.data.jobId}`);
  }

  async function pickProducts() {
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
    setFilterType("manual");
    setFilterValue(JSON.stringify(variantIds));
  }

  function submit(intent: "preview" | "create") {
    fetcher.submit(
      { intent, mode, targetField, value, filterType, filterValue, runAt, revertAt },
      { method: "POST" },
    );
  }

  return (
    <Page>
      <TitleBar title="New price change" />
      <BlockStack gap="400">
        <Card>
          <FormLayout>
            <Select
              label="Target by"
              options={FILTER_OPTIONS}
              value={filterType}
              onChange={setFilterType}
            />
            {filterType === "manual" ? (
              <BlockStack gap="200">
                <Button onClick={pickProducts}>Pick products</Button>
                <Text as="span" tone="subdued">
                  {filterValue ? `${JSON.parse(filterValue).length} variant(s) selected` : "No products selected"}
                </Text>
              </BlockStack>
            ) : (
              <TextField
                label={FILTER_OPTIONS.find((o) => o.value === filterType)?.label ?? "Value"}
                value={filterValue}
                onChange={setFilterValue}
                autoComplete="off"
              />
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
              <Button onClick={() => submit("preview")} loading={isLoading} disabled={!filterValue || !value}>
                Preview
              </Button>
              <Button
                variant="primary"
                onClick={() => submit("create")}
                loading={isLoading}
                disabled={!filterValue || !value}
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
                columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric"]}
                headings={["SKU", "Old price", "New price", "Old compare-at", "New compare-at"]}
                rows={preview.slice(0, 100).map((item) => [
                  item.sku ?? "—",
                  item.oldPrice.toFixed(2),
                  item.newPrice.toFixed(2),
                  item.oldCompareAtPrice?.toFixed(2) ?? "—",
                  item.newCompareAtPrice?.toFixed(2) ?? "—",
                ])}
              />
              {preview.length > 100 && (
                <Text as="span" tone="subdued">
                  Showing first 100 of {preview.length} variants.
                </Text>
              )}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
