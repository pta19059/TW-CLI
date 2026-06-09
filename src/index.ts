#!/usr/bin/env node
import { bootstrap } from "./runtime/bootstrap.js";
bootstrap();

import type { Command } from "commander";
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
import { maybeFilterNativeStderr } from "./runtime/stderrFilter.js";

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

/**
 * Read --user/--port/--key from argv and assemble the optional connection
 * block consumed by runOneShot/createExecutionContext. Returns undefined when
 * --user is missing so probes default to local execution.
 */
function parseConnectionFlags(argv: string[]): { user: string; port?: number; identity?: string } | undefined {
  const user = parseFlagValue(argv, ["--user"]);
  if (!user) return undefined;
  const portRaw = parseFlagValue(argv, ["--port"]);
  let port: number | undefined;
  if (portRaw !== undefined) {
    const n = Number(portRaw);
    if (!Number.isFinite(n) || n < 1 || n > 65535) {
      console.error(`Invalid --port: ${portRaw}`);
      process.exit(2);
    }
    port = n;
  }
  const identity = parseFlagValue(argv, ["--key"]);
  return { user, port, identity };
}

/**
 * Read --capture <minutes> and return the live-capture window in SECONDS.
 * Accepts an integer or decimal number of minutes (e.g. `--capture 2` or
 * `--capture 0.5`). Returns undefined when the flag is absent. Exits 2 on an
 * invalid value so the user gets immediate feedback rather than a silent no-op.
 */
function parseCaptureFlag(argv: string[]): number | undefined {
  const raw = parseFlagValue(argv, ["--capture"]);
  if (raw === undefined) return undefined;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 60) {
    console.error(`Invalid --capture (expected minutes, 0 < n <= 60): ${raw}`);
    process.exit(2);
  }
  return Math.round(minutes * 60);
}

// The set of recognised first tokens is derived from Commander itself so we
// never have to hand-maintain this list when adding a new command. Anything
// not registered as a Commander command falls through to the natural-language
// troubleshoot path (mirrors `copilot "do something"`).
const FALLBACK_FLAGS = new Set(["help", "--help", "-h", "--version", "-V"]);

function isKnownCommand(token: string, cli: Command): boolean {
  if (FALLBACK_FLAGS.has(token)) return true;
  for (const cmd of cli.commands) {
    if (cmd.name() === token) return true;
    const aliases = cmd.aliases?.() ?? [];
    if (aliases.includes(token)) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Worker dispatch (background job runner) — must run before any UI.
  if (argv.includes("--worker")) {
    const jobId = parseFlagValue(argv, ["--job-id"]);
    if (!jobId) throw new Error("Missing --job-id argument in worker mode");
    await runWorkerJob(jobId);
    return;
  }

  // Embedder commands emit harmless native onnxruntime warnings on stderr; run
  // them in a child with a filtered stderr stream so the output stays clean.
  if (await maybeFilterNativeStderr(argv)) return;

  // One-shot mode: `twc -p "issue text" [--product X] [--target Y] [--task T] [--context C] [--markdown] [--user U [--port N] [--key path]] [--capture <minutes>]`
  if (hasFlag(argv, ["-p", "--prompt"])) {
    const issue = parseFlagValue(argv, ["-p", "--prompt"]);
    if (!issue) {
      console.error("Usage: twc -p \"<issue>\" [--product <key>] [--target <value>] [--task troubleshoot|debug] [--context <text>] [--model <id>] [--markdown] [--user <ssh-user> [--port N] [--key <path>]] [--capture <minutes>]");
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
    const connection = parseConnectionFlags(argv);
    const captureWindowSec = parseCaptureFlag(argv);

    try {
      const product = resolveProductOrThrow(rawProduct);
      const { report, rendered } = await runOneShot({
        product,
        task: taskRaw === "debug" ? "debug" : "troubleshoot",
        target,
        issue,
        context,
        connection,
        captureWindowSec
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

  // Fall back to Commander for all known subcommands (list is derived from
  // the Commander tree itself — see isKnownCommand above).
  const cli = buildCli();
  if (isKnownCommand(argv[0], cli)) {
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
      issue,
      connection: parseConnectionFlags(argv),
      captureWindowSec: parseCaptureFlag(argv)
    });
    console.log("");
    console.log(rendered);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

void main();
