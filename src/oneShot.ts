// Synchronous one-shot pipeline: runs the Mastra workflow in-process and
// renders a human-readable report. Used by the REPL and by `twc -p`.

import { runMastraAgent } from "./agents/mastraAdapter.js";
import { renderReportText } from "./agents/formatReport.js";
import { normalizeProduct, productName } from "./catalog/teamviewerProducts.js";
import { JobType, ProductKey, WorkflowReport } from "./types.js";
import { color, startSpinner } from "./ui.js";
import { createExecutionContext, LocalContext } from "./runtime/execContext.js";
import { withRunContext } from "./runtime/runContext.js";

export interface OneShotRequest {
  product: ProductKey;
  task: JobType;
  target: string;
  issue: string;
  context?: string;
  /** Optional SSH connection — when present, probes run on the remote host. */
  connection?: {
    user: string;
    port?: number;
    identity?: string;
  };
  /**
   * Optional live-capture window in seconds. When set, the log probe streams
   * the macOS unified log for this long (waiting for the intermittent failure
   * to actually occur) instead of reading stale history.
   */
  captureWindowSec?: number;
}

export interface OneShotResult {
  report: WorkflowReport;
  rendered: string;
}

export async function runOneShot(req: OneShotRequest): Promise<OneShotResult> {
  const captureNote =
    req.captureWindowSec && req.captureWindowSec > 0
      ? ` · live-capturing logs for ${req.captureWindowSec}s (reproduce the issue now)`
      : "";
  const spinner = startSpinner(`Running ${req.task} workflow for ${productName(req.product)}…${captureNote}`);
  const startedAt = Date.now();
  try {
    const ctx = req.connection
      ? await createExecutionContext({
          target: req.target,
          user: req.connection.user,
          port: req.connection.port,
          identity: req.connection.identity
        })
      : new LocalContext();

    const report = await withRunContext(
      ctx,
      () =>
        runMastraAgent({
          product: req.product,
          task: req.task,
          input: {
            target: req.target,
            issue: req.issue,
            context: req.context,
            connection: req.connection
          }
        }),
      { captureWindowSec: req.captureWindowSec }
    );
    // Stamp the report with WHERE the probes actually ran so the rendered
    // output (text + markdown) can surface it.
    report.executionTarget = ctx.description;
    const ms = Date.now() - startedAt;
    spinner.stop(color.green(`✓ Done in ${(ms / 1000).toFixed(1)}s — confidence ${report.confidence.toFixed(2)}`));
    const rendered = renderReportText(report);
    return { report, rendered };
  } catch (err) {
    spinner.stop(color.red(`✗ Workflow failed: ${err instanceof Error ? err.message : String(err)}`));
    throw err;
  }
}

export function resolveProductOrThrow(raw: string): ProductKey {
  const product = normalizeProduct(raw);
  if (!product) {
    throw new Error(`Unsupported product '${raw}'.`);
  }
  return product;
}
