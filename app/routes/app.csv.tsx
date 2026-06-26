import { useState } from "react";
import type { ActionFunctionArgs } from "@remix-run/node";
import { useFetcher, useNavigate } from "@remix-run/react";
import { Page, Card, BlockStack, Text, DropZone, Button, Banner, DataTable } from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import Papa from "papaparse";
import { authenticate } from "../shopify.server";
import { resolveVariantsByIds, resolveVariantsBySkus } from "../lib/shopifyAdmin.server";
import { createJob, executeJob } from "../lib/jobs.server";

type CsvRow = {
  variant_id?: string;
  sku?: string;
  price?: string;
  compare_at_price?: string;
};

type CsvActionResponse = {
  jobId?: string;
  unmatched?: string[];
  error?: string;
};

export const action = async ({ request }: ActionFunctionArgs): Promise<CsvActionResponse> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const rowsRaw = formData.get("rows") as string;
  const rows: CsvRow[] = JSON.parse(rowsRaw);

  const byVariantId = rows.filter((r) => r.variant_id);
  const bySku = rows.filter((r) => !r.variant_id && r.sku);

  const resolvedById = byVariantId.length
    ? await resolveVariantsByIds(admin, byVariantId.map((r) => r.variant_id as string))
    : [];
  const resolvedBySku = bySku.length
    ? await resolveVariantsBySkus(admin, bySku.map((r) => r.sku as string))
    : [];

  const variantByKey = new Map<string, (typeof resolvedById)[number]>();
  for (const v of resolvedById) variantByKey.set(v.variantId, v);
  for (const v of resolvedBySku) if (v.sku) variantByKey.set(v.sku, v);

  const items = [];
  const unmatched: string[] = [];

  for (const row of rows) {
    const key = row.variant_id ?? row.sku;
    const resolved = key ? variantByKey.get(key) : undefined;
    if (!resolved || !row.price) {
      unmatched.push(key ?? "(missing key)");
      continue;
    }
    items.push({
      variantId: resolved.variantId,
      productId: resolved.productId,
      sku: resolved.sku,
      oldPrice: Number(resolved.price),
      newPrice: Number(row.price),
      oldCompareAtPrice: resolved.compareAtPrice !== null ? Number(resolved.compareAtPrice) : null,
      newCompareAtPrice: row.compare_at_price ? Number(row.compare_at_price) : null,
    });
  }

  if (items.length === 0) {
    return { error: "No rows could be matched to existing variants.", unmatched };
  }

  const job = await createJob({
    shopName: session.shop,
    mode: "csv",
    targetField: "both",
    value: null,
    filterType: "csv",
    filterValue: JSON.stringify({ rowCount: rows.length }),
    runAt: null,
    revertAt: null,
    items,
  });

  await executeJob(admin, job.id);

  return { jobId: job.id, unmatched };
};

export default function CsvUpload() {
  const fetcher = useFetcher<CsvActionResponse>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);

  if (fetcher.data?.jobId) {
    shopify.toast.show("CSV price change applied");
    navigate(`/app/jobs/${fetcher.data.jobId}`);
  }

  function handleDrop(_dropFiles: File[], acceptedFiles: File[]) {
    const file = acceptedFiles[0];
    if (!file) return;
    setParseError(null);
    Papa.parse<CsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const hasKey = results.meta.fields?.includes("variant_id") || results.meta.fields?.includes("sku");
        const hasPrice = results.meta.fields?.includes("price");
        if (!hasKey || !hasPrice) {
          setParseError("CSV must include a 'price' column and either 'variant_id' or 'sku'.");
          return;
        }
        setRows(results.data);
      },
      error: (err) => setParseError(err.message),
    });
  }

  function submit() {
    fetcher.submit({ rows: JSON.stringify(rows) }, { method: "POST" });
  }

  return (
    <Page>
      <TitleBar title="CSV price upload" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="p">
              Upload a CSV with columns: <code>variant_id</code> or <code>sku</code>,{" "}
              <code>price</code>, and optionally <code>compare_at_price</code>. Changes apply
              immediately.
            </Text>
            <DropZone accept=".csv" type="file" onDrop={handleDrop}>
              <DropZone.FileUpload actionTitle="Add CSV file" />
            </DropZone>
            {parseError && <Banner tone="critical">{parseError}</Banner>}
            {fetcher.data?.error && <Banner tone="critical">{fetcher.data.error}</Banner>}
            {rows.length > 0 && (
              <Button variant="primary" onClick={submit} loading={fetcher.state !== "idle"}>
                {`Apply ${rows.length} row${rows.length === 1 ? "" : "s"}`}
              </Button>
            )}
          </BlockStack>
        </Card>

        {rows.length > 0 && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Preview
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "numeric", "numeric"]}
                headings={["Variant ID", "SKU", "Price", "Compare-at price"]}
                rows={rows
                  .slice(0, 50)
                  .map((r) => [r.variant_id ?? "—", r.sku ?? "—", r.price ?? "—", r.compare_at_price ?? "—"])}
              />
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
