import { WorkflowReport, ProductKey, JobType, JobInput } from "../types.js";
import { mastra } from "./index.js";
import { ensureFoundryLocalReady } from "./foundryLocal.js";

interface RuntimeRequest {
  product: ProductKey;
  task: JobType;
  input: JobInput;
}

export async function runMastraLocalRuntime(request: RuntimeRequest): Promise<WorkflowReport> {
  // Hard requirement: every agent runs on Foundry Local. If it is not reachable
  // we fail fast with an actionable error instead of degrading to heuristics.
  await ensureFoundryLocalReady();

  const workflow = mastra.getWorkflow("teamviewerTroubleshootWorkflow");
  const run = await workflow.createRun();

  const result = await run.start({
    inputData: {
      product: request.product,
      task: request.task,
      target: request.input.target,
      issue: request.input.issue,
      context: request.input.context
    }
  });

  if (result.status !== "success") {
    if (result.status === "failed") {
      throw new Error(`Mastra workflow failed: ${result.error.message}`);
    }
    throw new Error(`Mastra workflow did not complete successfully: ${result.status}`);
  }

  return result.result as WorkflowReport;
}
