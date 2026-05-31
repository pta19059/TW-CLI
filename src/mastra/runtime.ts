import { WorkflowReport, ProductKey, JobType, JobInput } from "../types.js";
import { mastra } from "./index.js";

interface RuntimeRequest {
  product: ProductKey;
  task: JobType;
  input: JobInput;
}

export async function runMastraLocalRuntime(request: RuntimeRequest): Promise<WorkflowReport> {
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
