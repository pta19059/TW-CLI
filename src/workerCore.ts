import { getJob, updateJob } from "./jobs/jobStore.js";
import { runMastraAgent } from "./agents/mastraAdapter.js";
import { renderReportText } from "./agents/formatReport.js";

export async function runWorkerJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Unknown job: ${jobId}`);
  }

  updateJob(jobId, { status: "running", startedAt: new Date().toISOString() });

  try {
    const report = await runMastraAgent({
      product: job.product,
      task: job.type,
      input: job.input
    });

    updateJob(jobId, {
      status: "completed",
      output: renderReportText(report),
      report,
      completedAt: new Date().toISOString()
    });
  } catch (error) {
    updateJob(jobId, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown worker failure",
      completedAt: new Date().toISOString()
    });
  }
}
