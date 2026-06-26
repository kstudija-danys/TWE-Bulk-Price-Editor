import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Card,
  IndexTable,
  Badge,
  EmptyState,
  Text,
  useIndexResourceState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STATUS_TONE: Record<string, "info" | "success" | "critical" | "warning" | "attention"> = {
  draft: "info",
  scheduled: "attention",
  running: "warning",
  completed: "success",
  reverted: "info",
  failed: "critical",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const jobs = await prisma.priceJob.findMany({
    where: { shopName: session.shop },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { _count: { select: { items: true } } },
  });

  return {
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      mode: job.mode,
      targetField: job.targetField,
      filterType: job.filterType,
      itemCount: job._count.items,
      createdAt: job.createdAt.toISOString(),
      runAt: job.runAt?.toISOString() ?? null,
    })),
  };
};

export default function Index() {
  const { jobs } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const resourceState = useIndexResourceState(jobs);

  return (
    <Page>
      <TitleBar title="Bulk Price Editor">
        <button variant="primary" onClick={() => navigate("/app/jobs/new")}>
          New price change
        </button>
      </TitleBar>
      <Card padding="0">
        {jobs.length === 0 ? (
          <EmptyState
            heading="No price changes yet"
            action={{ content: "New price change", onAction: () => navigate("/app/jobs/new") }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>Bulk-edit prices by collection, tag, vendor, or CSV upload — with full revert support.</p>
          </EmptyState>
        ) : (
          <IndexTable
            resourceName={{ singular: "price change", plural: "price changes" }}
            itemCount={jobs.length}
            selectedItemsCount={resourceState.selectedResources.length}
            onSelectionChange={resourceState.handleSelectionChange}
            headings={[
              { title: "Name" },
              { title: "Created" },
              { title: "Filter" },
              { title: "Rule" },
              { title: "Variants" },
              { title: "Status" },
            ]}
            selectable={false}
          >
            {jobs.map((job, index) => (
              <IndexTable.Row
                id={job.id}
                key={job.id}
                position={index}
                onClick={() => navigate(`/app/jobs/${job.id}`)}
              >
                <IndexTable.Cell>
                  <Text as="span" variant="bodyMd" fontWeight="medium">
                    {job.name || "—"}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="span" variant="bodyMd">
                    {new Date(job.createdAt).toLocaleString()}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{job.filterType}</IndexTable.Cell>
                <IndexTable.Cell>
                  {job.mode} / {job.targetField}
                </IndexTable.Cell>
                <IndexTable.Cell>{job.itemCount}</IndexTable.Cell>
                <IndexTable.Cell>
                  <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}
