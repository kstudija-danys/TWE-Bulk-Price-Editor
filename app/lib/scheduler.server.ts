// In-process scheduler: polls for due scheduled jobs and due auto-reverts
// every minute, from inside the same web service (no separate worker
// process/service needed).
import cron from "node-cron";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  applyToNewProductsInBackground,
  dueAutoApplyJobs,
  executeJob,
  interruptedNewProductChecks,
  jobsWithFailedReverts,
  recoverInterruptedCheck,
  retryFailedReverts,
  revertJob,
  waitingForRevertHandover,
} from "./jobs.server";

declare global {
  var schedulerStarted: boolean | undefined;
}

async function runDueScheduledJobs() {
  const dueJobs = await prisma.priceJob.findMany({
    where: { status: "scheduled", runAt: { lte: new Date() } },
  });

  for (const job of dueJobs) {
    try {
      if (await waitingForRevertHandover(job.id)) {
        console.log(`[scheduler] job ${job.id} waits for an overlapping sale to finish reverting`);
        continue;
      }
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

/** Puts jobs a restart left "running" mid new-product check back to completed. */
async function recoverInterruptedChecks() {
  for (const job of await interruptedNewProductChecks()) {
    try {
      const { admin } = await unauthenticated.admin(job.shopName);
      await recoverInterruptedCheck(admin, job.id);
    } catch (error) {
      console.error(`[scheduler] recovering job ${job.id} failed`, error);
    }
  }
}

/** Retries recent reverts that failed on some prices (their sale price is still live). */
async function retryRecentFailedReverts() {
  for (const job of await jobsWithFailedReverts()) {
    try {
      const { admin } = await unauthenticated.admin(job.shopName);
      await retryFailedReverts(admin, job.id);
    } catch (error) {
      console.error(`[scheduler] retrying failed reverts of job ${job.id} failed`, error);
    }
  }
}

/** Applies auto-apply jobs to products that started matching their filter. */
async function runDueAutoApplies() {
  for (const job of await dueAutoApplyJobs()) {
    applyToNewProductsInBackground(job.shopName, job.id);
  }
}

// Ticks may overlap when a job outlasts the one-minute interval. That's safe:
// a job can only be claimed once (claimJobForExecution / activeJobIds), and a
// scheduled job waits while an overlapping sale is mid-revert
// (waitingForRevertHandover), so one shop's long job never delays another's.
async function tick() {
  // Reverts first: when one sale ends as the next starts, the next must be
  // computed from the restored regular prices, not the outgoing sale's.
  // First, so a sale a restart left stuck can still auto-revert this tick.
  await recoverInterruptedChecks();
  await runDueAutoReverts();
  await retryRecentFailedReverts();
  await runDueScheduledJobs();
  await runDueAutoApplies();
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
