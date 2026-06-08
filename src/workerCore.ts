import { getJob, updateJob } from "./jobs/jobStore.js";
import { runMastraAgent } from "./agents/mastraAdapter.js";
import { renderReportText } from "./agents/formatReport.js";
import { createExecutionContext, LocalContext } from "./runtime/execContext.js";
import { withRunContext } from "./runtime/runContext.js";

export async function runWorkerJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Unknown job: ${jobId}`);
  }

  updateJob(jobId, { status: "running", startedAt: new Date().toISOString() });

  try {
    // Build the execution context once per job. If --user (and a network-looking
    // target) was supplied, this opens an SSH connection and detects the
    // remote OS via `uname -s`. Otherwise the job runs against the local host.
    const ctx = job.input.connection
      ? await createExecutionContext({
          target: job.input.target,
          user: job.input.connection.user,
          port: job.input.connection.port,
          identity: job.input.connection.identity
        })
      : new LocalContext();

    const report = await withRunContext(ctx, () =>
      runMastraAgent({
        product: job.product,
        task: job.type,
        input: job.input
      })
    );
    // Stamp the report with WHERE the probes actually ran so consumers
    // (CLI, REPL, jobs show --markdown) can show "Execution: ssh user@host".
    report.executionTarget = ctx.description;

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
