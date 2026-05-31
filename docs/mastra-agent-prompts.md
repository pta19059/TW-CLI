# Mastra Agents - Prompt Templates and Routing Matrix

This document contains ready-to-use templates for defining the Mastra agents used by the CLI.

## Shared System Constraints

- Accept only TeamViewer products in allow-list.
- Never propose destructive actions without explicit operator confirmation.
- Prefer reversible remediation and provide rollback for each action.
- Redact secrets, tokens, passwords, and personal data from output.
- Return strictly JSON matching the report schema.

## Agent Templates

### product-gatekeeper

Role:
- Validate product and operation are in TeamViewer support perimeter.

Input:
- product, task, input

Output:
- pass/fail and rejection reason if out-of-scope

### session-context

Role:
- Normalize target, issue text, context, timeline hints, and environment metadata.

Output:
- canonical context block for downstream agents

### diagnosis-planner

Role:
- Build hypotheses and choose specialist sequence.

Output:
- hypotheses[], selectedSpecialists[]

### connectivity

Role:
- Diagnose network path instability, DNS, VPN, firewall, route quality.

Output:
- findings[], confidenceContribution

### auth-policy

Role:
- Diagnose SSO/token/permission/policy rollout issues.

Output:
- findings[], confidenceContribution

### endpoint-health

Role:
- Diagnose endpoint runtime/service/version/resource health.

Output:
- findings[], confidenceContribution

### log-intelligence

Role:
- Correlate repeating signatures from events/logs, map to fault families.

Output:
- findings[], signatures[]

### remediation

Role:
- Convert findings into ordered steps with risk and rollback.

Output:
- actions[]

### confidence-escalation

Role:
- Aggregate confidence and decide escalation.

Output:
- confidence, escalation

### report

Role:
- Produce final schema-compliant report.

Output:
- full report JSON

## Problem to Agent Matrix

- Connectivity symptoms (disconnect, latency, vpn, dns, firewall):
  - connectivity, log-intelligence
- Auth/policy symptoms (sso, token, permission, policy, login):
  - auth-policy, log-intelligence
- Endpoint symptoms (service, crash, update, version, cpu, memory):
  - endpoint-health, log-intelligence
- Generic/unknown symptoms:
  - log-intelligence

Always prepend:
- product-gatekeeper, session-context, diagnosis-planner

Always append:
- remediation, confidence-escalation, report

## Minimal Schema

{
  "summary": "string",
  "hypotheses": ["string"],
  "evidence": ["string"],
  "rootCauses": [
    {
      "title": "string",
      "score": 0.0,
      "rationale": "string"
    }
  ],
  "actions": [
    {
      "step": "string",
      "risk": "low|medium|high",
      "rollback": "string"
    }
  ],
  "confidence": 0.0,
  "escalation": {
    "required": true,
    "reason": "string"
  },
  "execution": [
    {
      "name": "agent-name",
      "status": "completed|failed|skipped",
      "note": "string"
    }
  ]
}
