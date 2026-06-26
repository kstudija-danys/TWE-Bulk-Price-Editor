import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Badge,
  DataTable,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { revertJob } from "../lib/jobs.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const job = await prisma.priceJob.findFirst({
    where: { id: params.id, shopName: session.shop },
    include: { items: true },
  });

  if (!job) throw new Response("Not found", { status: 404 });

  return {
    job: {
      id: job.id,
      name: job.name,
      status: job.status,
      mode: job.mode,
      targetField: job.targetField,
      filterType: job.filterType,
      filterValue: job.filterValue,
      value: job.value?.toString() ?? null,
      runAt: job.runAt?.toISOString() ?? null,
      revertAt: job.revertAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
      errorMessage: job.errorMessage,
      items: job.items.map((i) => ({
        id: i.id,
        sku: i.sku,
        oldPrice: i.oldPrice.toString(),
        newPrice: i.newPrice.toString(),
        oldCompareAtPrice: i.oldCompareAtPrice?.toString() ?? null,
        newCompareAtPrice: i.newCompareAtPrice?.toString() ?? null,
        status: i.status,
        errorMessage: i.errorMessage,
      })),
    },
  };
};

type RevertActionResponse = {
  ok: boolean;
  result?: { succeeded: string[]; failed: { variantId: string; error: string }[] };
  error?: string;
};

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<RevertActionResponse> => {
  const { admin } = await authenticate.admin(request);
  try {
    const result = await revertJob(admin, params.id as string);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const STATUS_TONE: Record<string, "info" | "success" | "critical" | "warning" | "attention"> = {
  draft: "info",
  scheduled: "attention",
  running: "warning",
  completed: "success",
  reverted: "info",
  failed: "critical",
};

export default function JobDetail() {
  const { job } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const canRevert = job.status === "completed";
  const isReverting = fetcher.state !== "idle";

  if (fetcher.data?.ok) {
    shopify.toast.show("Job reverted");
  }

  return (
    <Page>
      <TitleBar title={job.name || `Price change — ${job.filterType}`}>
        {canRevert && (
          <button
            variant="primary"
            tone="critical"
            onClick={() => fetcher.submit({}, { method: "POST" })}
            disabled={isReverting}
          >
            Revert
          </button>
        )}
      </TitleBar>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <InlineSummary job={job} />
            {job.errorMessage && <Banner tone="warning">{job.errorMessage}</Banner>}
            {fetcher.data && !fetcher.data.ok && (
              <Banner tone="critical">{fetcher.data.error}</Banner>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Variants ({job.items.length})
            </Text>
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "text"]}
              headings={["SKU", "Old price", "New price", "Old compare-at", "New compare-at", "Status"]}
              rows={job.items.map((item) => [
                item.sku ?? "—",
                Number(item.oldPrice).toFixed(2),
                Number(item.newPrice).toFixed(2),
                item.oldCompareAtPrice ? Number(item.oldCompareAtPrice).toFixed(2) : "—",
                item.newCompareAtPrice ? Number(item.newCompareAtPrice).toFixed(2) : "—",
                item.status,
              ])}
            />
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

function InlineSummary({ job }: { job: ReturnType<typeof useLoaderData<typeof loader>>["job"] }) {
  return (
    <BlockStack gap="100">
      <Text as="p">
        <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
      </Text>
      <Text as="p" tone="subdued">
        {job.mode} / {job.targetField} · value: {job.value} · created{" "}
        {new Date(job.createdAt).toLocaleString()}
      </Text>
      {job.runAt && (
        <Text as="p" tone="subdued">
          Scheduled for {new Date(job.runAt).toLocaleString()}
        </Text>
      )}
      {job.revertAt && (
        <Text as="p" tone="subdued">
          Auto-revert at {new Date(job.revertAt).toLocaleString()}
        </Text>
      )}
    </BlockStack>
  );
}
