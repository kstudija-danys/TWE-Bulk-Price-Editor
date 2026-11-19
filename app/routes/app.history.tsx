import type { LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  TextField,
  Button,
  DataTable,
  Text,
  Link,
  Badge,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const MAX_ROWS = 300;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return { q, rows: [], truncated: false };

  // SKU or product title; MySQL's default collation makes this case-insensitive.
  const items = await prisma.priceJobItem.findMany({
    where: {
      job: { shopName: session.shop },
      OR: [{ sku: { contains: q } }, { productTitle: { contains: q } }],
    },
    include: {
      job: { select: { id: true, name: true, status: true, createdAt: true, completedAt: true, revertedAt: true } },
      marketPrices: { select: { marketName: true, currency: true, oldPrice: true, newPrice: true, status: true } },
    },
    orderBy: { job: { createdAt: "desc" } },
    take: MAX_ROWS + 1,
  });

  return {
    q,
    truncated: items.length > MAX_ROWS,
    rows: items.slice(0, MAX_ROWS).map((i) => ({
      id: i.id,
      jobId: i.job.id,
      jobName: i.job.name,
      jobStatus: i.job.status,
      date: (i.job.completedAt ?? i.job.createdAt).toISOString(),
      revertedAt: i.job.revertedAt?.toISOString() ?? null,
      sku: i.sku,
      productTitle: i.productTitle,
      oldPrice: i.oldPrice.toString(),
      newPrice: i.newPrice.toString(),
      oldCompareAtPrice: i.oldCompareAtPrice?.toString() ?? null,
      newCompareAtPrice: i.newCompareAtPrice?.toString() ?? null,
      status: i.status,
      markets: i.marketPrices
        .map((m) => `${m.marketName}: ${Number(m.oldPrice).toFixed(2)} → ${Number(m.newPrice).toFixed(2)} ${m.currency}`)
        .join("; "),
    })),
  };
};

const STATUS_TONE: Record<string, "info" | "success" | "critical" | "warning" | "attention"> = {
  applied: "success",
  reverted: "info",
  skipped: "warning",
  notApplied: "info",
  error: "critical",
  pending: "attention",
};

const money = (v: string | null) => (v === null ? "—" : Number(v).toFixed(2));

export default function PriceHistory() {
  const { q, rows, truncated } = useLoaderData<typeof loader>();
  const [search, setSearch] = useState(q);
  const [, setSearchParams] = useSearchParams();
  const navigation = useNavigation();

  return (
    <Page>
      <TitleBar title="Price history" />
      <BlockStack gap="400">
        <Card>
          <Form
            method="get"
            onSubmit={(e) => {
              e.preventDefault();
              setSearchParams(search.trim() ? { q: search.trim() } : {});
            }}
          >
            <InlineStack gap="200" blockAlign="end">
              <div style={{ flex: 1 }}>
                <TextField
                  label="SKU or product title"
                  value={search}
                  onChange={setSearch}
                  autoComplete="off"
                  placeholder="e.g. ALP-3300 or Race Helmet"
                />
              </div>
              <Button submit variant="primary" loading={navigation.state === "loading"}>
                Search
              </Button>
            </InlineStack>
          </Form>
        </Card>

        {q.length >= 2 && rows.length === 0 && (
          <Card>
            <EmptyState heading="No price changes found" image="">
              <p>No job has changed a variant whose SKU or title contains "{q}".</p>
            </EmptyState>
          </Card>
        )}

        {rows.length > 0 && (
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Every price change this app made to matching variants, newest first.
                Product titles are only recorded for jobs created from this version on.
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "numeric", "numeric", "text", "text"]}
                headings={["Date", "Price change", "Product", "SKU", "Price", "Compare-at", "Markets", "Status"]}
                rows={rows.map((r) => [
                  new Date(r.date).toLocaleString(),
                  <Link key={r.id} url={`/app/jobs/${r.jobId}`}>
                    {r.jobName || "Unnamed"}
                  </Link>,
                  r.productTitle ?? "—",
                  r.sku ?? "—",
                  `${money(r.oldPrice)} → ${money(r.newPrice)}`,
                  r.oldCompareAtPrice === r.newCompareAtPrice
                    ? money(r.newCompareAtPrice)
                    : `${money(r.oldCompareAtPrice)} → ${money(r.newCompareAtPrice)}`,
                  r.markets || "—",
                  <Badge key={`${r.id}-s`} tone={STATUS_TONE[r.status]}>
                    {r.revertedAt && r.status === "reverted"
                      ? `reverted ${new Date(r.revertedAt).toLocaleDateString()}`
                      : r.status}
                  </Badge>,
                ])}
              />
              {truncated && (
                <Text as="p" tone="subdued">
                  Showing the newest {MAX_ROWS}. Search for a fuller SKU to narrow it down.
                </Text>
              )}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
