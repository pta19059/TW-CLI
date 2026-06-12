import { WorkflowReport } from "../types.js";

export function renderReportText(report: WorkflowReport): string {
  const lines: string[] = [];
  const rule = "─".repeat(60);

  // ── Header ────────────────────────────────────────────────────────────
  lines.push(`Summary: ${report.summary}`);
  if (report.executionTarget) {
    lines.push(`Target:  ${report.executionTarget}`);
  }
  lines.push(`Confidence: ${report.confidence.toFixed(2)}  ·  Escalation: ${report.escalation.required ? "yes" : "no"}`);
  lines.push("");

  // ── Root Causes (the answer the user actually wants) ──────────────────
  lines.push(rule);
  lines.push("ROOT CAUSES");
  lines.push(rule);
  if (report.rootCauses.length === 0) {
    lines.push("- (none identified — probes did not find a definitive cause; see Actions for next steps)");
  } else {
    report.rootCauses.forEach((cause, i) => {
      lines.push(`${i + 1}. ${cause.title}  [score ${cause.score.toFixed(2)}]`);
      lines.push(`   ${cause.rationale}`);
    });
  }
  lines.push("");

  // ── Actions ───────────────────────────────────────────────────────────
  lines.push(rule);
  lines.push("RECOMMENDED ACTIONS");
  lines.push(rule);
  if (report.actions.length === 0) {
    lines.push("- (no concrete actions produced)");
  } else {
    report.actions.forEach((action, i) => {
      lines.push(`${i + 1}. ${action.step}`);
      lines.push(`   risk: ${action.risk}  ·  rollback: ${action.rollback}`);
    });
  }
  lines.push("");

  // ── Knowledge base (only on-topic, relevance-sorted) ──────────────────
  if (report.references && report.references.length > 0) {
    lines.push(rule);
    lines.push("KNOWLEDGE BASE (supporting articles)");
    lines.push(rule);
    for (const ref of report.references) {
      const label = ref.title ? ref.title : ref.source;
      lines.push(`- ${label}`);
      lines.push(`    ${ref.source}`);
    }
    lines.push("");
  }

  // ── Related articles (lower-confidence, on-topic KB pages) ────────────
  if (report.relatedReferences && report.relatedReferences.length > 0) {
    lines.push(rule);
    lines.push("RELATED ARTICLES (lower-confidence, may still help)");
    lines.push(rule);
    for (const ref of report.relatedReferences) {
      const label = ref.title ? ref.title : ref.source;
      lines.push(`- ${label}`);
      lines.push(`    ${ref.source}`);
    }
    lines.push("");
  }

  // ── Log sources consulted (cross-platform) ────────────────────────────
  if (report.logSources && report.logSources.length > 0) {
    lines.push(rule);
    lines.push(`LOG SOURCES CONSULTED${report.executionTarget ? ` (${report.executionTarget})` : ""}`);
    lines.push(rule);
    for (const ls of report.logSources) {
      lines.push(`- ${ls.source}`);
      if (ls.detail) lines.push(`    ${ls.detail}`);
    }
    lines.push("");
  }

  // ── Evidence (the raw probe findings) ─────────────────────────────────
  lines.push(rule);
  lines.push("EVIDENCE");
  lines.push(rule);
  for (const item of report.evidence) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  // ── Suggested commands ────────────────────────────────────────────────
  const commands = report.actions.map((a) => a.command).filter((c): c is string => !!c);
  if (commands.length > 0) {
    lines.push(rule);
    lines.push(`SUGGESTED COMMANDS (copy-paste, ${process.platform})`);
    lines.push(rule);
    for (const cmd of commands) lines.push(`  $ ${cmd}`);
    lines.push("");
  }

  // ── Exploratory leads — ONLY when no definitive root cause was found ───
  if (report.rootCauses.length === 0 && report.hypotheses.length > 0) {
    lines.push(rule);
    lines.push("EXPLORATORY LEADS (no definitive cause found — unverified)");
    lines.push(rule);
    for (const item of report.hypotheses) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  // ── Escalation footer ─────────────────────────────────────────────────
  lines.push(rule);
  lines.push(`Escalation required: ${report.escalation.required ? "yes" : "no"} — ${report.escalation.reason}`);

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
    lines.push(`**Target:** ${report.executionTarget}`);
  }
  lines.push("");
  lines.push(`> ${report.escalation.reason}`);
  lines.push("");

  // ── Root Causes ───────────────────────────────────────────────────────
  lines.push(`## Root Causes`);
  lines.push("");
  if (report.rootCauses.length === 0) {
    lines.push(`_None identified — probes did not find a definitive cause; see Actions for next steps._`);
  } else {
    lines.push(`| # | Cause | Score | Rationale |`);
    lines.push(`|---|-------|------:|-----------|`);
    report.rootCauses.forEach((c, i) => {
      lines.push(`| ${i + 1} | ${escapePipe(c.title)} | ${c.score.toFixed(2)} | ${escapePipe(c.rationale)} |`);
    });
  }
  lines.push("");

  // ── Actions ───────────────────────────────────────────────────────────
  lines.push(`## Recommended Actions`);
  lines.push("");
  if (report.actions.length === 0) {
    lines.push(`_No concrete actions produced._`);
  } else {
    lines.push(`| # | Step | Risk | Rollback |`);
    lines.push(`|---|------|------|----------|`);
    report.actions.forEach((a, i) => {
      lines.push(`| ${i + 1} | ${escapePipe(a.step)} | ${a.risk} | ${escapePipe(a.rollback)} |`);
    });
  }
  lines.push("");

  // ── Knowledge base ────────────────────────────────────────────────────
  if (report.references && report.references.length > 0) {
    lines.push(`## Knowledge Base`);
    lines.push("");
    lines.push(`| Article | Source |`);
    lines.push(`|---------|--------|`);
    for (const ref of report.references) {
      lines.push(`| ${escapePipe(ref.title ?? ref.source)} | ${ref.source} |`);
    }
    lines.push("");
  }

  // ── Related articles (lower-confidence, on-topic KB pages) ────────────
  if (report.relatedReferences && report.relatedReferences.length > 0) {
    lines.push(`## Related Articles`);
    lines.push("");
    lines.push(`| Article | Source |`);
    lines.push(`|---------|--------|`);
    for (const ref of report.relatedReferences) {
      lines.push(`| ${escapePipe(ref.title ?? ref.source)} | ${ref.source} |`);
    }
    lines.push("");
  }

  // ── Log sources consulted ─────────────────────────────────────────────
  if (report.logSources && report.logSources.length > 0) {
    lines.push(`## Log Sources Consulted${report.executionTarget ? ` (${escapePipe(report.executionTarget)})` : ""}`);
    lines.push("");
    lines.push(`| Source | Detail |`);
    lines.push(`|--------|--------|`);
    for (const ls of report.logSources) {
      lines.push(`| ${escapePipe(ls.source)} | ${ls.detail ? escapePipe(ls.detail) : ""} |`);
    }
    lines.push("");
  }

  // ── Evidence ──────────────────────────────────────────────────────────
  lines.push(`## Evidence`);
  for (const item of report.evidence) lines.push(`- ${item}`);
  lines.push("");

  // ── Suggested commands ────────────────────────────────────────────────
  const mdCommands = report.actions.map((a) => a.command).filter((c): c is string => !!c);
  if (mdCommands.length > 0) {
    lines.push(`## Suggested Commands (${process.platform})`);
    lines.push("");
    lines.push("```bash");
    for (const cmd of mdCommands) lines.push(cmd);
    lines.push("```");
    lines.push("");
  }

  // ── Exploratory leads — ONLY when no definitive root cause was found ───
  if (report.rootCauses.length === 0 && report.hypotheses.length > 0) {
    lines.push(`## Exploratory Leads`);
    lines.push("");
    lines.push(`_No definitive cause found — the following are unverified leads, not confirmed causes._`);
    lines.push("");
    for (const item of report.hypotheses) lines.push(`- ${item}`);
    lines.push("");
  }

  // ── Execution ─────────────────────────────────────────────────────────
  lines.push(`## Execution`);
  for (const e of report.execution) {
    lines.push(`- **${e.name}** — ${e.status} — ${e.note}`);
  }

  return lines.join("\n");
}

function escapePipe(input: string): string {
  return input.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

