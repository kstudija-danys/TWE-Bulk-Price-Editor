// In-process scheduler: polls for due scheduled jobs and due auto-reverts
// every minute, from inside the same web service (no separate worker
// process/service needed).
import cron from "node-cron";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { executeJob, revertJob } from "./jobs.server";

declare global {
  var schedulerStarted: boolean | undefined;
}

async function runDueScheduledJobs() {
  const dueJobs = await prisma.priceJob.findMany({
    where: { status: "scheduled", runAt: { lte: new Date() } },
  });

  for (const job of dueJobs) {
    try {
      const { admin } = await unauthenticated.admin(job.shopName);
      await executeJob(admin, job.id);
      console.log(`[scheduler] executed job ${job.id} for ${job.shopName}`);
    } catch (error) {
      console.error(`[scheduler] failed to execute job ${job.id}`, error);
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
      console.log(`[scheduler] auto-reverted job ${job.id} for ${job.shopName}`);
    } catch (error) {
      console.error(`[scheduler] failed to auto-revert job ${job.id}`, error);
    }
  }
}

async function tick() {
  await runDueScheduledJobs();
  await runDueAutoReverts();
}

/** Starts the cron poll loop once per process (safe to call on every module load, e.g. across Vite HMR in dev). */
export function startScheduler() {
  if (global.schedulerStarted) return;
  global.schedulerStarted = true;

  console.log("[scheduler] starting in-process scheduler, polling every 60s");
  cron.schedule("* * * * *", () => {
    tick().catch((error) => console.error("[scheduler] tick failed", error));
  });

  tick().catch((error) => console.error("[scheduler] initial tick failed", error));
}
