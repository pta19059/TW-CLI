import { AgentName, JobInput, JobType } from "../types.js";

export function inferIssueBuckets(input: JobInput): string[] {
  const text = `${input.issue} ${input.context ?? ""}`.toLowerCase();
  const buckets: string[] = [];

  if (/disconnect|latency|dns|vpn|packet|firewall|network|port/.test(text)) {
    buckets.push("connectivity");
  }
  if (/sso|auth|token|permission|policy|access|credential|login/.test(text)) {
    buckets.push("auth-policy");
  }
  if (/cpu|memory|service|agent stopped|update|version|crash|endpoint|device/.test(text)) {
    buckets.push("endpoint-health");
  }
  if (/log|error|exception|trace|stack|event/.test(text)) {
    buckets.push("log-intelligence");
  }

  if (buckets.length === 0) {
    buckets.push("generic");
  }

  return buckets;
}

export function selectAgents(task: JobType, buckets: string[]): AgentName[] {
  const base: AgentName[] = ["product-gatekeeper", "session-context", "diagnosis-planner"];

  const specialists: AgentName[] = [];
  if (buckets.includes("connectivity")) {
    specialists.push("connectivity");
  }
  if (buckets.includes("auth-policy")) {
    specialists.push("auth-policy");
  }
  if (buckets.includes("endpoint-health")) {
    specialists.push("endpoint-health");
  }
  if (buckets.includes("log-intelligence") || buckets.includes("generic") || task === "debug") {
    specialists.push("log-intelligence");
  }

  const dedup = Array.from(
    new Set<AgentName>([...base, ...specialists, "remediation", "confidence-escalation", "report"])
  );
  return dedup;
}
