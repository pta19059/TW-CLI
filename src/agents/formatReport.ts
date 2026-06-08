import { WorkflowReport } from "../types.js";

export function renderReportText(report: WorkflowReport): string {
  const lines: string[] = [];

  lines.push(`Summary: ${report.summary}`);
  if (report.executionTarget) {
    lines.push(`Execution: ${report.executionTarget}`);
  }
  lines.push("");

  lines.push("Hypotheses:");
  for (const item of report.hypotheses) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  lines.push("Evidence:");
  for (const item of report.evidence) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  lines.push("Root Causes:");
  for (const cause of report.rootCauses) {
    lines.push(`- ${cause.title} (score ${cause.score.toFixed(2)}): ${cause.rationale}`);
  }
  lines.push("");

  lines.push("Actions:");
  for (const action of report.actions) {
    lines.push(`- ${action.step} | risk=${action.risk} | rollback=${action.rollback}`);
  }
  lines.push("");

  const commands = report.actions.map((a) => a.command).filter((c): c is string => !!c);
  if (commands.length > 0) {
    lines.push(`Suggested commands (copy-paste, ${process.platform}):`);
    for (const cmd of commands) lines.push(`  $ ${cmd}`);
    lines.push("");
  }

  lines.push(`Confidence: ${report.confidence.toFixed(2)}`);
  lines.push(`Escalation required: ${report.escalation.required ? "yes" : "no"}`);
  lines.push(`Escalation reason: ${report.escalation.reason}`);

  return lines.join("\n");
}

export function renderReportMarkdown(report: WorkflowReport): string {
  const lines: string[] = [];
  lines.push(`# Troubleshooting Report`);
  lines.push("");
  lines.push(`**Summary:** ${report.summary}`);
  lines.push("");
  lines.push(`**Confidence:** ${report.confidence.toFixed(2)} · **Escalation:** ${report.escalation.required ? "yes" : "no"}`);
  if (report.executionTarget) {
    lines.push(`**Execution:** ${report.executionTarget}`);
  }
  lines.push("");
  lines.push(`> ${report.escalation.reason}`);
  lines.push("");

  lines.push(`## Hypotheses`);
  for (const item of report.hypotheses) lines.push(`- ${item}`);
  lines.push("");

  lines.push(`## Evidence`);
  for (const item of report.evidence) lines.push(`- ${item}`);
  lines.push("");

  lines.push(`## Root Causes`);
  lines.push("");
  lines.push(`| # | Cause | Score | Rationale |`);
  lines.push(`|---|-------|------:|-----------|`);
  report.rootCauses.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${escapePipe(c.title)} | ${c.score.toFixed(2)} | ${escapePipe(c.rationale)} |`);
  });
  lines.push("");

  lines.push(`## Actions`);
  lines.push("");
  lines.push(`| Step | Risk | Rollback |`);
  lines.push(`|------|------|----------|`);
  for (const a of report.actions) {
    lines.push(`| ${escapePipe(a.step)} | ${a.risk} | ${escapePipe(a.rollback)} |`);
  }
  lines.push("");

  const mdCommands = report.actions.map((a) => a.command).filter((c): c is string => !!c);
  if (mdCommands.length > 0) {
    lines.push(`## Suggested Commands (${process.platform})`);
    lines.push("");
    lines.push("```bash");
    for (const cmd of mdCommands) lines.push(cmd);
    lines.push("```");
    lines.push("");
  }

  lines.push(`## Execution`);
  for (const e of report.execution) {
    lines.push(`- **${e.name}** — ${e.status} — ${e.note}`);
  }

  return lines.join("\n");
}

function escapePipe(input: string): string {
  return input.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
