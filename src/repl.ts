// Interactive REPL inspired by GitHub Copilot CLI: greeting banner,
// slash commands, natural-language input → runs the troubleshoot workflow
// synchronously with a spinner.

import readline from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { TEAMVIEWER_PRODUCTS, normalizeProduct, productName } from "./catalog/teamviewerProducts.js";
import { AGENT_PROFILES } from "./agents/profiles.js";
import { getJob, getJobLogPath, listJobs, updateJob } from "./jobs/jobStore.js";
import { renderReportText } from "./agents/formatReport.js";
import { explainReport } from "./agents/explain.js";
import { parseIntent } from "./agents/intent.js";
import { discoverFoundryEndpoint, probeFoundryLocal } from "./mastra/foundryLocal.js";
import { MODEL_CATALOG, findEntry, resolveModelId } from "./mastra/modelCatalog.js";
import { getActiveModelId, setActiveModelId } from "./userConfig.js";
import { invalidateModelCache } from "./mastra/agents/index.js";
import { runOneShot } from "./oneShot.js";
import { answerFromKnowledge } from "./knowledge/teamviewerDocs.js";
import { JobType, ProductKey } from "./types.js";
import { banner, color } from "./ui.js";
import { killProcessTree } from "./jobs/killTree.js";
import { HISTORY_FILE, ensureDataDir } from "./paths.js";

interface ReplState {
  product?: ProductKey;
  target: string;
  task: JobType;
  context?: string;
}

const HELP_LINES = [
  `${color.bold("Free text")}            describe an issue → runs the workflow`,
  `${color.bold("/product <key>")}       set the active TeamViewer product`,
  `${color.bold("/target <value>")}      set the target (default: local-device)`,
  `${color.bold("/task <debug|troubleshoot>")}  switch task type (default: troubleshoot)`,
  `${color.bold("/context <text>")}      attach extra context to the next prompt`,
  `${color.bold("/products")}            list supported TeamViewer products`,
  `${color.bold("/agents")}              list Mastra agent roles`,
  `${color.bold("/jobs [N]")}            list recent background jobs`,
  `${color.bold("/show <jobId>")}        show one job report`,
  `${color.bold("/explain <jobId>")}     explain a job report in plain language`,
  `${color.bold("/logs <jobId> [N]")}    print last N lines of a job log`,
  `${color.bold("/cancel <jobId>")}      cancel a running job`,
  `${color.bold("/doctor")}              check Foundry Local runtime`,
  `${color.bold("/docs <question>")}     ask the official-docs knowledge layer`,
  `${color.bold("/model [id]")}          show active model, or switch (alias or full id)`,
  `${color.bold("/models")}              list curated model catalog`,
  `${color.bold("/clear")}               clear the screen`,
  `${color.bold("/help")}                show this help`,
  `${color.bold("/exit, /quit")}         leave the session (Ctrl+C also works)`
];

function showHelp(): void {
  console.log(color.bold("\nAvailable commands:"));
  for (const line of HELP_LINES) console.log(`  ${line}`);
  console.log("");
}

function statusLine(state: ReplState): string {
  const product = state.product ? productName(state.product) : color.yellow("not set");
  const ctx = state.context ? color.dim(` ctx="${state.context.slice(0, 30)}${state.context.length > 30 ? "…" : ""}"`) : "";
  return color.dim(`[${state.task} · ${product} · target=${state.target}]${ctx}`);
}

function greet(state: ReplState): void {
  const endpoint = discoverFoundryEndpoint() ?? "(not detected)";
  const model = process.env.FOUNDRY_LOCAL_MODEL ?? process.env.MASTRA_MODEL ?? "(unset)";
  console.log(
    banner([
      color.bold("TWC") + color.dim("  TeamViewer Copilot CLI"),
      color.dim("Model:    ") + model,
      color.dim("Endpoint: ") + endpoint,
      color.dim("Type ") + color.cyan("/help") + color.dim(" to see commands, or describe an issue.")
    ])
  );
  console.log(statusLine(state));
  console.log("");
}

function clearScreen(): void {
  process.stdout.write("\u001b[2J\u001b[0;0H");
}

function listProductsCmd(): void {
  for (const p of TEAMVIEWER_PRODUCTS) {
    console.log(`  ${color.cyan(p.key.padEnd(30))} ${p.name} ${color.dim("[" + p.category + "]")}`);
  }
}

function listAgentsCmd(): void {
  for (const a of AGENT_PROFILES) {
    console.log(`  ${color.cyan(a.name.padEnd(24))} ${a.responsibility}`);
  }
}

function listJobsCmd(limit: number): void {
  const rows = listJobs(limit);
  if (rows.length === 0) {
    console.log(color.dim("  (no jobs yet)"));
    return;
  }
  for (const job of rows) {
    const statusColor =
      job.status === "completed" ? color.green :
      job.status === "failed" ? color.red :
      job.status === "cancelled" ? color.yellow :
      color.cyan;
    console.log(
      `  ${color.dim(job.id)}  ${statusColor(job.status.padEnd(10))} ${job.type.padEnd(12)} ${productName(job.product)}  ${color.dim(job.updatedAt)}`
    );
  }
}

function showJobCmd(jobId: string): void {
  const job = getJob(jobId);
  if (!job) {
    console.log(color.red(`  Job not found: ${jobId}`));
    return;
  }
  console.log(`  ${color.bold("Job")}     ${job.id}`);
  console.log(`  ${color.bold("Status")}  ${job.status}`);
  console.log(`  ${color.bold("Product")} ${productName(job.product)}`);
  if (job.report) {
    console.log("");
    console.log(renderReportText(job.report));
  } else if (job.output) {
    console.log("");
    console.log(job.output);
  }
  if (job.error) console.log(color.red(`  Error: ${job.error}`));
}

function explainCmd(jobId: string): void {
  const job = getJob(jobId);
  if (!job) {
    console.log(color.red(`  Job not found: ${jobId}`));
    return;
  }
  if (!job.report) {
    console.log(color.yellow(`  Job ${jobId} has no report yet (status: ${job.status}).`));
    return;
  }
  console.log("");
  console.log(explainReport(job.report, { product: job.product, target: job.input.target, task: job.type }));
}

function logsCmd(jobId: string, tail: number): void {
  const job = getJob(jobId);
  if (!job) {
    console.log(color.red(`  Job not found: ${jobId}`));
    return;
  }
  const logPath = getJobLogPath(jobId);
  if (!existsSync(logPath)) {
    console.log(color.yellow(`  No log file at ${logPath}`));
    return;
  }
  const lines = readFileSync(logPath, "utf-8").split(/\r?\n/);
  console.log(lines.slice(-tail).join("\n"));
}

function cancelCmd(jobId: string): void {
  const job = getJob(jobId);
  if (!job) {
    console.log(color.red(`  Job not found: ${jobId}`));
    return;
  }
  if (job.status !== "running" && job.status !== "queued") {
    console.log(color.yellow(`  Job ${jobId} is '${job.status}', nothing to cancel.`));
    return;
  }
  if (typeof job.pid === "number") {
    const res = killProcessTree(job.pid);
    if (!res.ok) console.log(color.yellow(`  Could not kill pid ${job.pid}: ${res.error}`));
  }
  updateJob(jobId, { status: "cancelled", error: "Cancelled by user", completedAt: new Date().toISOString() });
  console.log(color.green(`  Cancelled ${jobId}.`));
}

async function doctorCmd(): Promise<void> {
  const endpoint = discoverFoundryEndpoint();
  console.log(`  Endpoint: ${endpoint ?? color.red("(missing)")}`);
  console.log(`  Model:    ${process.env.FOUNDRY_LOCAL_MODEL ?? color.yellow("(unset)")}`);
  if (!endpoint) {
    console.log(color.red("  NOT READY — set FOUNDRY_LOCAL_ENDPOINT or run 'foundry service start'."));
    return;
  }
  const probe = await probeFoundryLocal(endpoint);
  if (!probe.reachable) {
    console.log(color.red(`  Probe failed: ${probe.error}`));
    return;
  }
  console.log(color.green(`  READY — ${probe.latencyMs} ms, first model: ${probe.modelId ?? "n/a"}`));
}

function showModelCmd(): void {
  console.log(`  Endpoint: ${discoverFoundryEndpoint() ?? color.red("(missing)")}`);
  const active = getActiveModelId();
  if (!active) {
    console.log(`  Model:    ${color.yellow("(none)")} — use /model <alias>`);
    return;
  }
  const entry = findEntry(active);
  console.log(`  Model:    ${active}` + (entry ? color.dim(`  [${entry.alias} · ${entry.accelerator}]`) : ""));
}

function listModelsCmd(): void {
  const active = getActiveModelId();
  for (const m of MODEL_CATALOG) {
    const marker = m.id === active ? color.green("*") : " ";
    console.log(`  ${marker} ${color.cyan(m.alias.padEnd(22))} ${m.accelerator.padEnd(3)}  ${color.dim(m.id)}`);
    console.log(`      ${m.family} — ${m.description}`);
  }
}

function useModelCmd(input: string): void {
  const id = resolveModelId(input);
  if (!id) {
    console.log(color.red(`  Unknown model '${input}'. Try /models.`));
    return;
  }
  setActiveModelId(id);
  invalidateModelCache();
  const entry = findEntry(id);
  console.log(color.green(`  Active model: ${id}`) + (entry ? color.dim(` (${entry.alias})`) : ""));
}

async function ensureProduct(state: ReplState, rl: readline.Interface): Promise<ProductKey | undefined> {
  if (state.product) return state.product;
  console.log(color.yellow("  No active product. Supported keys:"));
  listProductsCmd();
  const answer = await ask(rl, color.cyan("  product> "));
  const product = normalizeProduct(answer.trim());
  if (!product) {
    console.log(color.red(`  Unsupported product '${answer.trim()}'.`));
    return undefined;
  }
  state.product = product;
  console.log(color.green(`  Active product set to ${productName(product)}.`));
  return product;
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer)));
}

async function handleSlash(line: string, state: ReplState, rl: readline.Interface): Promise<boolean> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "help": showHelp(); return true;
    case "exit":
    case "quit": return false;
    case "clear": clearScreen(); return true;
    case "products": listProductsCmd(); return true;
    case "agents": listAgentsCmd(); return true;
    case "jobs": listJobsCmd(Number.parseInt(arg, 10) || 10); return true;
    case "show": if (!arg) console.log(color.red("  usage: /show <jobId>")); else showJobCmd(arg); return true;
    case "explain": if (!arg) console.log(color.red("  usage: /explain <jobId>")); else explainCmd(arg); return true;
    case "logs": {
      const [id, n] = arg.split(/\s+/);
      if (!id) { console.log(color.red("  usage: /logs <jobId> [N]")); return true; }
      logsCmd(id, Number.parseInt(n, 10) || 80);
      return true;
    }
    case "cancel": if (!arg) console.log(color.red("  usage: /cancel <jobId>")); else cancelCmd(arg); return true;
    case "doctor": await doctorCmd(); return true;
    case "docs": {
      if (!arg) { console.log(color.red("  usage: /docs <question>")); return true; }
      const result = await answerFromKnowledge(arg, { live: false });
      console.log(result.answer);
      if (result.citations.length > 0) {
        console.log(color.dim(`  sources: ${result.citations.join(", ")}`));
      }
      return true;
    }
    case "model":
      if (arg) useModelCmd(arg);
      else showModelCmd();
      return true;
    case "models": listModelsCmd(); return true;
    case "product": {
      if (!arg) { console.log(color.dim(`  current: ${state.product ?? "(none)"}`)); return true; }
      const product = normalizeProduct(arg);
      if (!product) { console.log(color.red(`  Unsupported product '${arg}'.`)); return true; }
      state.product = product;
      console.log(color.green(`  Active product set to ${productName(product)}.`));
      return true;
    }
    case "target": {
      if (!arg) { console.log(color.dim(`  current: ${state.target}`)); return true; }
      state.target = arg;
      console.log(color.green(`  Target set to '${state.target}'.`));
      return true;
    }
    case "task": {
      if (arg !== "debug" && arg !== "troubleshoot") {
        console.log(color.red("  usage: /task <debug|troubleshoot>"));
        return true;
      }
      state.task = arg;
      console.log(color.green(`  Task set to '${state.task}'.`));
      return true;
    }
    case "context": {
      state.context = arg || undefined;
      console.log(color.green(arg ? `  Context attached.` : `  Context cleared.`));
      return true;
    }
    default:
      console.log(color.red(`  Unknown command '/${cmd}'. Type /help.`));
      return true;
  }
}

export interface ReplOptions {
  product?: string;
  target?: string;
  task?: JobType;
}

export async function runRepl(options: ReplOptions = {}): Promise<void> {
  const state: ReplState = {
    product: options.product ? normalizeProduct(options.product) ?? undefined : undefined,
    target: options.target ?? "local-device",
    task: options.task ?? "troubleshoot"
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  // Load persisted history (most recent last, as readline expects most-recent-first).
  ensureDataDir();
  if (existsSync(HISTORY_FILE)) {
    try {
      const past = readFileSync(HISTORY_FILE, "utf-8").split(/\r?\n/).filter(Boolean);
      // readline's history is most-recent first; file is append-order.
      (rl as unknown as { history: string[] }).history = past.slice(-500).reverse();
    } catch { /* ignore */ }
  }
  const appendHistory = (entry: string) => {
    try { appendFileSync(HISTORY_FILE, entry + "\n", "utf-8"); } catch { /* ignore */ }
  };

  greet(state);

  let alive = true;
  rl.on("SIGINT", () => { alive = false; rl.close(); });

  while (alive) {
    const promptLabel = color.magenta("twc") + color.dim(" › ");
    const line = (await ask(rl, promptLabel)).trim();
    if (!line) continue;
    appendHistory(line);

    if (line.startsWith("/")) {
      try {
        const keepRunning = await handleSlash(line, state, rl);
        if (!keepRunning) break;
      } catch (err) {
        console.log(color.red(`  ${err instanceof Error ? err.message : String(err)}`));
      }
      console.log(statusLine(state));
      continue;
    }

    // Be forgiving of the `twc` prefix habit: a bare leading `twc` token is
    // the command name from the banner, never part of a real issue sentence.
    const nlLine = line.replace(/^twc\s+/i, "");

    // Natural-language intent: infer product/target from the sentence so the
    // user can just describe the problem (Tia-style) without setting flags.
    const intent = parseIntent(nlLine);
    if (!state.product && intent.product) {
      state.product = intent.product;
      console.log(color.dim(`  (detected product: ${productName(intent.product)})`));
    }
    if (intent.target && state.target === "local-device") {
      state.target = intent.target;
      console.log(color.dim(`  (detected target: ${intent.target})`));
    }

    const product = await ensureProduct(state, rl);
    if (!product) continue;

    try {
      const { rendered } = await runOneShot({
        product,
        task: state.task,
        target: state.target,
        issue: nlLine,
        context: state.context
      });
      console.log("");
      console.log(rendered);
      console.log("");
      // Auto-clear one-off context once consumed.
      state.context = undefined;
    } catch (err) {
      console.log(color.red(`  ${err instanceof Error ? err.message : String(err)}`));
    }
    console.log(statusLine(state));
  }

  rl.close();
  console.log(color.dim("\nGoodbye."));
}
