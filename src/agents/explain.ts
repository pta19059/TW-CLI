// Turns a structured WorkflowReport into a plain-language narrative — the
// "explain it like I'm on the phone with support" view. Deterministic so it
// works without the LLM; when Foundry Local is present the diagnosis it
// summarises is already richer.

import { ProductKey, WorkflowReport } from "../types.js";
import { productName } from "../catalog/teamviewerProducts.js";

export interface ExplainMeta {
  product: ProductKey;
  target: string;
  task: "debug" | "troubleshoot";
}

export function explainReport(report: WorkflowReport, meta: ExplainMeta): string {
  const out: string[] = [];
  const product = productName(meta.product);

  // Opening
  out.push(
    `I ran a ${meta.task} pass on ${product} for "${meta.target}". ${report.summary}`.trim()
  );
  out.push("");

  // Findings
  if (report.rootCauses.length === 0) {
    out.push("Good news: none of the probes flagged a likely root cause. The signals I collected look healthy.");
  } else {
    const top = report.rootCauses[0];
    out.push(
      `The most likely cause (confidence ${(top.score * 100).toFixed(0)}%) is: ${top.title}. ${top.rationale}`
    );
    if (report.rootCauses.length > 1) {
      const others = report.rootCauses.slice(1, 3).map((c) => c.title).join("; ");
      out.push(`Other possibilities worth keeping in mind: ${others}.`);
    }
  }
  out.push("");

  // What to do
  if (report.actions.length > 0) {
    out.push("Here is what I would do next:");
    report.actions.forEach((a, i) => {
      const cmd = a.command ? `  →  run: ${a.command}` : "";
      out.push(`  ${i + 1}. ${a.step} (risk: ${a.risk})${cmd}`);
    });
  } else {
    out.push("There is no corrective action to take right now.");
  }
  out.push("");

  // Confidence / escalation
  out.push(
    `Overall confidence in this diagnosis is ${(report.confidence * 100).toFixed(0)}%.` +
      (report.escalation.required
        ? ` I'd escalate this to a human: ${report.escalation.reason}`
        : ` This should be safe to handle without escalation.`)
  );

  return out.join("\n");
}
