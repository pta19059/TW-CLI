import { AgentName } from "../types.js";

export interface AgentProfile {
  name: AgentName;
  responsibility: string;
}

export const AGENT_PROFILES: AgentProfile[] = [
  {
    name: "product-gatekeeper",
    responsibility: "Enforce TeamViewer-only product policy and reject out-of-scope requests"
  },
  {
    name: "session-context",
    responsibility: "Normalize target, issue, environment context, and issue timeline"
  },
  {
    name: "diagnosis-planner",
    responsibility: "Build diagnostic hypotheses and identify specialist agents"
  },
  {
    name: "connectivity",
    responsibility: "Analyze network reachability, DNS, VPN, packet loss, and firewall symptoms"
  },
  {
    name: "auth-policy",
    responsibility: "Analyze authentication, SSO, token, permissions, and policy rollout"
  },
  {
    name: "endpoint-health",
    responsibility: "Analyze endpoint readiness, service state, resources, and version compatibility"
  },
  {
    name: "log-intelligence",
    responsibility: "Extract error signatures and correlate repeating patterns from logs"
  },
  {
    name: "remediation",
    responsibility: "Generate actionable remediation plan with risk and rollback"
  },
  {
    name: "confidence-escalation",
    responsibility: "Compute confidence score and determine L3 escalation requirement"
  },
  {
    name: "report",
    responsibility: "Generate final human-readable report artifact"
  }
];
