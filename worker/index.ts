// Standalone worker process (run as its own Render service) that polls the
// database for due scheduled jobs and due auto-reverts, and executes them
// against each shop's offline Admin API session.
import "dotenv/config";
import "@shopify/shopify-app-remix/adapters/node";
import cron from "node-cron";
import prisma from "../app/db.server";
import { unauthenticated } from "../app/shopify.server";
import { executeJob, revertJob } from "../app/lib/jobs.server";

async function runDueScheduledJobs() {
  const dueJobs = await prisma.priceJob.findMany({
    where: { status: "scheduled", runAt: { lte: new Date() } },
  });

  for (const job of dueJobs) {
    try {
      const { admin } = await unauthenticated.admin(job.shopName);
      await executeJob(admin, job.id);
      console.log(`[worker] executed job ${job.id} for ${job.shopName}`);
    } catch (error) {
      console.error(`[worker] failed to execute job ${job.id}`, error);
      await prisma.priceJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

async function runDueAutoReverts() {
  const dueReverts = await prisma.priceJob.findMany({
    where: { status: "completed", revertAt: { lte: new Date() } },
  });

  for (const job of dueReverts) {
    try {
      const { admin } = await unauthenticated.admin(job.shopName);
      await revertJob(admin, job.id);
      console.log(`[worker] auto-reverted job ${job.id} for ${job.shopName}`);
    } catch (error) {
      console.error(`[worker] failed to auto-revert job ${job.id}`, error);
    }
  }
}

async function tick() {
  await runDueScheduledJobs();
  await runDueAutoReverts();
}

console.log("[worker] starting bulk price editor worker, polling every 60s");
cron.schedule("* * * * *", () => {
  tick().catch((error) => console.error("[worker] tick failed", error));
});

// Run once immediately on boot so a due job isn't stuck waiting for the next minute mark.
tick().catch((error) => console.error("[worker] initial tick failed", error));
