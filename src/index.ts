#!/usr/bin/env node
import { bootstrap } from "./runtime/bootstrap.js";
bootstrap();

import { buildCli } from "./cli.js";
import { runRepl } from "./repl.js";
import { runOneShot, resolveProductOrThrow } from "./oneShot.js";
import { parseIntent } from "./agents/intent.js";
import { renderReportMarkdown } from "./agents/formatReport.js";
import { runWorkerJob } from "./workerCore.js";
import { JobType } from "./types.js";
import { resolveModelId } from "./mastra/modelCatalog.js";
import { setActiveModelId } from "./userConfig.js";
import { invalidateModelCache } from "./mastra/agents/index.js";

function applyModelFlag(argv: string[]): void {
  const raw = parseFlagValue(argv, ["--model"]);
  if (!raw) return;
  const id = resolveModelId(raw);
  if (!id) {
    console.error(`Unknown model '${raw}'. Run 'twc models list' for the catalog.`);
    process.exit(1);
  }
  setActiveModelId(id);
  invalidateModelCache();
}

function parseFlagValue(argv: string[], names: string[]): string | undefined {
  for (const name of names) {
    const i = argv.findIndex((a) => a === name);
    if (i !== -1) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.split("=").slice(1).join("=");
  }
  return undefined;
}

function hasFlag(argv: string[], names: string[]): boolean {
  return argv.some((a) => names.includes(a) || names.some((n) => a.startsWith(`${n}=`)));
}

const KNOWN_COMMANDS = new Set([
  "products",
  "agents",
  "debug",
  "troubleshoot",
  "jobs",
  "doctor",
  "config",
  "models",
  "explain",
  "help",
  "--help",
  "-h",
  "--version",
  "-V"
]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Worker dispatch (background job runner) — must run before any UI.
  if (argv.includes("--worker")) {
    const jobId = parseFlagValue(argv, ["--job-id"]);
    if (!jobId) throw new Error("Missing --job-id argument in worker mode");
    await runWorkerJob(jobId);
    return;
  }

  // One-shot mode: `twc -p "issue text" [--product X] [--target Y] [--task T] [--context C] [--markdown]`
  if (hasFlag(argv, ["-p", "--prompt"])) {
    const issue = parseFlagValue(argv, ["-p", "--prompt"]);
    if (!issue) {
      console.error("Usage: twc -p \"<issue>\" [--product <key>] [--target <value>] [--task troubleshoot|debug] [--context <text>] [--model <id>] [--markdown]");
      process.exitCode = 1;
      return;
    }
    applyModelFlag(argv);
    const intent = parseIntent(issue);
    const rawProduct = parseFlagValue(argv, ["--product"]) ?? intent.product ?? "teamviewer-remote";
    const target = parseFlagValue(argv, ["--target"]) ?? intent.target ?? "local-device";
    const taskRaw = (parseFlagValue(argv, ["--task"]) ?? "troubleshoot") as JobType;
    const context = parseFlagValue(argv, ["--context"]);
    const markdown = argv.includes("--markdown");

    try {
      const product = resolveProductOrThrow(rawProduct);
      const { report, rendered } = await runOneShot({
        product,
        task: taskRaw === "debug" ? "debug" : "troubleshoot",
        target,
        issue,
        context
      });
      console.log("");
      console.log(markdown ? renderReportMarkdown(report) : rendered);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  // Interactive REPL: `twc` with no args, or `twc chat`.
  if (argv.length === 0 || argv[0] === "chat") {
    await runRepl({
      product: parseFlagValue(argv, ["--product"]),
      target: parseFlagValue(argv, ["--target"]),
      task: parseFlagValue(argv, ["--task"]) as JobType | undefined
    });
    return;
  }

  // Fall back to Commander for all known subcommands.
  if (KNOWN_COMMANDS.has(argv[0])) {
    const cli = buildCli();
    await cli.parseAsync(process.argv);
    return;
  }

  // Unknown first token: treat the entire argv as a free-text prompt
  // (mirrors `copilot "do something"`).
  const issue = argv.filter((a) => !a.startsWith("--")).join(" ");
  applyModelFlag(argv);
  try {
    const intent = parseIntent(issue);
    const product = resolveProductOrThrow(parseFlagValue(argv, ["--product"]) ?? intent.product ?? "teamviewer-remote");
    const { rendered } = await runOneShot({
      product,
      task: "troubleshoot",
      target: parseFlagValue(argv, ["--target"]) ?? intent.target ?? "local-device",
      issue
    });
    console.log("");
    console.log(rendered);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

void main();
