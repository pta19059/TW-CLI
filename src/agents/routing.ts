import { AgentName, JobInput, JobType, ProductKey } from "../types.js";
import { getProductProfile } from "../catalog/productProfiles.js";

/**
 * Buckets that should always run for a product regardless of the issue text, so
 * every product gets a real baseline: connectivity for all, plus the local-agent
 * health check for products that install one, or the Web API/auth surface for
 * cloud-/mobile-delivered products.
 */
export function productBaselineBuckets(product?: string): string[] {
  if (!product) return [];
  const profile = getProductProfile(product as ProductKey);
  const buckets = ["connectivity"];
  if (profile.deliveryModel === "local-agent") buckets.push("endpoint-health");
  else buckets.push("auth-policy");
  return buckets;
}

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
