import { JobInput, JobType, ProductKey, WorkflowReport } from "../types.js";
import { runMastraLocalRuntime } from "../mastra/runtime.js";

interface AgentRequest {
  product: ProductKey;
  task: JobType;
  input: JobInput;
}

const DEFAULT_WORKFLOW_TIMEOUT_MS = 120_000;

function resolveTimeoutMs(): number {
  const raw = process.env.TWC_WORKFLOW_TIMEOUT_MS;
  if (!raw) return DEFAULT_WORKFLOW_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 1000 ? parsed : DEFAULT_WORKFLOW_TIMEOUT_MS;
}

export async function runMastraAgent(request: AgentRequest): Promise<WorkflowReport> {
  if (process.env.MASTRA_AGENT_ENDPOINT) {
    throw new Error(
      "Remote Mastra endpoint is disabled. Remove MASTRA_AGENT_ENDPOINT and use Foundry Local runtime only."
    );
  }

  const timeoutMs = resolveTimeoutMs();
  return await Promise.race([
    runMastraLocalRuntime(request),
    new Promise<WorkflowReport>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Workflow timed out after ${(timeoutMs / 1000).toFixed(0)}s (TWC_WORKFLOW_TIMEOUT_MS)`)),
        timeoutMs
      ).unref()
    )
  ]);
}
