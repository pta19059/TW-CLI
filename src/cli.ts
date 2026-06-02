import { Command } from "commander";
import { nanoid } from "nanoid";
import { existsSync, readFileSync } from "node:fs";
import { TEAMVIEWER_PRODUCTS, normalizeProduct, productName } from "./catalog/teamviewerProducts.js";
import { addJob, getJob, getJobLogPath, listJobs, updateJob } from "./jobs/jobStore.js";
import { startDetachedWorker } from "./jobs/dispatch.js";
import { AgentJob, JobType, ProductKey } from "./types.js";
import { AGENT_PROFILES } from "./agents/profiles.js";
import { inferIssueBuckets, selectAgents } from "./agents/routing.js";
import { renderReportMarkdown } from "./agents/formatReport.js";
import { explainReport } from "./agents/explain.js";
import { discoverFoundryEndpoint, probeFoundryLocal } from "./mastra/foundryLocal.js";
import { MODEL_CATALOG, findEntry, resolveModelId } from "./mastra/modelCatalog.js";
import { getActiveModelId, setActiveModelId, setLastJobId, getLastJobId } from "./userConfig.js";
import { invalidateModelCache } from "./mastra/agents/index.js";
import { killProcessTree } from "./jobs/killTree.js";
import { getCliVersion } from "./version.js";
import {
  OFFICIAL_DOCS,
  answerFromKnowledge,
  localIndexInfo,
  reindexOfficialDocs,
  syncOfficialDocs
} from "./knowledge/teamviewerDocs.js";

function resolveProduct(raw: string): ProductKey {
  const product = normalizeProduct(raw);
  if (!product) {
    const accepted = TEAMVIEWER_PRODUCTS.map((p) => p.key).join(", ");
    throw new Error(`Unsupported product '${raw}'. Accepted TeamViewer products: ${accepted}`);
  }
  return product;
}

function printJobDetails(job: AgentJob): void {
  console.log(`Job: ${job.id}`);
  console.log(`Type: ${job.type}`);
  console.log(`Product: ${productName(job.product)}`);
  console.log(`Status: ${job.status}`);
  console.log(`Updated: ${job.updatedAt}`);

  if (job.report) {
    console.log("");
    console.log(`Summary: ${job.report.summary}`);
    console.log(`Confidence: ${job.report.confidence.toFixed(2)}`);
    console.log(`Escalation: ${job.report.escalation.required ? "yes" : "no"} (${job.report.escalation.reason})`);

    console.log("");
    console.log("Top root causes:");
    for (const cause of job.report.rootCauses.slice(0, 3)) {
      console.log(`- ${cause.title} (${cause.score.toFixed(2)}): ${cause.rationale}`);
    }

    console.log("");
    console.log("Actions:");
    for (const action of job.report.actions) {
      console.log(`- ${action.step} | risk=${action.risk} | rollback=${action.rollback}`);
    }
  } else if (job.output) {
    console.log("");
    console.log(job.output);
  }

  if (job.error) {
    console.log("");
    console.log(`Error: ${job.error}`);
  }
}

/** Poll the job store until the job reaches a terminal status (or timeout). */
async function waitForJob(jobId: string, timeoutMs = 180_000): Promise<AgentJob | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJob(jobId);
    if (job && (job.status === "completed" || job.status === "failed" || job.status === "cancelled")) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return getJob(jobId);
}

function resolveJobId(jobId?: string): string | undefined {
  return jobId ?? getLastJobId();
}

function enqueue(
  type: JobType,
  rawProduct: string,
  options: { target: string; issue: string; context?: string; wait?: boolean }
): void {
  const product = resolveProduct(rawProduct);
  const now = new Date().toISOString();

  const job: AgentJob = {
    id: nanoid(10),
    product,
    type,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    input: {
      target: options.target,
      issue: options.issue,
      context: options.context
    }
  };

  addJob(job);
  setLastJobId(job.id);
  startDetachedWorker(job.id);

  if (options.wait) {
    console.log(`Queued ${type} job ${job.id} for ${productName(product)}. Waiting for it to finish...`);
    void waitForJob(job.id).then((finished) => {
      console.log("");
      if (finished) {
        printJobDetails(finished);
      } else {
        console.log(`Still running. Inspect later with 'twc jobs show ${job.id}'.`);
      }
    });
    return;
  }

  console.log(`Queued ${type} job ${job.id} for ${productName(product)}.`);
  console.log(`Saved as last job. Run 'twc jobs show' (no id) to view the output once ready.`);
}


export function buildCli(): Command {
  const program = new Command();

  program
    .name("twc")
    .description("TeamViewer-focused CLI with background Mastra agents")
    .version(getCliVersion());

  const products = program.command("products").description("Product catalog operations");

  products.command("list").description("List supported TeamViewer products").action(() => {
    for (const product of TEAMVIEWER_PRODUCTS) {
      console.log(`${product.key} -> ${product.name} [${product.category}]`);
    }
  });

  const agents = program.command("agents").description("Inspect agent orchestration");

  agents.command("list").description("List available Mastra agent roles").action(() => {
    for (const agent of AGENT_PROFILES) {
      console.log(`${agent.name} -> ${agent.responsibility}`);
    }
  });

  agents
    .command("plan")
    .requiredOption("--task <task>", "Task type: debug or troubleshoot")
    .requiredOption("--issue <issue>", "Issue statement")
    .option("--context <context>", "Optional extra context")
    .description("Preview which agents will run for a given problem")
    .action((options: { task: string; issue: string; context?: string }) => {
      const task = normalizeTask(options.task);
      const buckets = inferIssueBuckets({
        target: "preview",
        issue: options.issue,
        context: options.context
      });
      const selected = selectAgents(task, buckets);

      console.log(`Issue buckets: ${buckets.join(", ")}`);
      console.log(`Selected agents: ${selected.join(", ")}`);
    });

  program
    .command("debug <product>")
    .requiredOption("--target <target>", "Target device/session/endpoint")
    .requiredOption("--issue <issue>", "Debug issue summary")
    .option("--context <context>", "Extra context for the agent")
    .option("--wait", "Wait for the job to finish and print the output directly")
    .description("Start a background debugging task with Mastra agents")
    .action((product, options: { target: string; issue: string; context?: string; wait?: boolean }) => {
      enqueue("debug", product, options);
    });

  program
    .command("troubleshoot <product>")
    .requiredOption("--target <target>", "Target device/session/endpoint")
    .requiredOption("--issue <issue>", "Troubleshooting issue summary")
    .option("--context <context>", "Extra context for the agent")
    .option("--wait", "Wait for the job to finish and print the output directly")
    .description("Start a background troubleshooting task with Mastra agents")
    .action((product, options: { target: string; issue: string; context?: string; wait?: boolean }) => {
      enqueue("troubleshoot", product, options);
    });

  const jobs = program.command("jobs").description("Inspect background tasks");

  jobs
    .command("list")
    .option("--limit <limit>", "Maximum number of jobs", "20")
    .description("List recent jobs")
    .action((options: { limit: string }) => {
      const limit = Number.parseInt(options.limit, 10);
      for (const job of listJobs(limit)) {
        console.log(`${job.id} | ${job.type} | ${job.status} | ${productName(job.product)} | ${job.updatedAt}`);
      }
    });

  jobs
    .command("show [jobId]")
    .option("--json", "Print full raw job JSON")
    .option("--markdown", "Print report as Markdown")
    .description("Show one job with output/error (defaults to the last queued job)")
    .action((jobIdArg: string | undefined, options: { json?: boolean; markdown?: boolean }) => {
      const jobId = resolveJobId(jobIdArg);
      if (!jobId) {
        console.error("No job id given and no last job saved yet. Run a debug/troubleshoot job first.");
        process.exitCode = 1;
        return;
      }
      const job = getJob(jobId);
      if (!job) {
        console.error(`Job not found: ${jobId}`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(job, null, 2));
        return;
      }

      if (options.markdown) {
        if (!job.report) {
          console.error("Report not available for this job yet");
          process.exitCode = 1;
          return;
        }
        console.log(renderReportMarkdown(job.report));
        return;
      }

      printJobDetails(job);
    });

  jobs
    .command("logs [jobId]")
    .option("--tail <lines>", "Print only the last N lines", "200")
    .description("Print stdout/stderr captured for a job (defaults to the last queued job)")
    .action((jobIdArg: string | undefined, options: { tail: string }) => {
      const jobId = resolveJobId(jobIdArg);
      if (!jobId) {
        console.error("No job id given and no last job saved yet. Run a debug/troubleshoot job first.");
        process.exitCode = 1;
        return;
      }
      const job = getJob(jobId);
      if (!job) {
        console.error(`Job not found: ${jobId}`);
        process.exitCode = 1;
        return;
      }
      const logPath = getJobLogPath(jobId);
      if (!existsSync(logPath)) {
        console.error(`No log file for job ${jobId} at ${logPath}`);
        process.exitCode = 1;
        return;
      }
      const tail = Math.max(1, Number.parseInt(options.tail, 10) || 200);
      const lines = readFileSync(logPath, "utf-8").split(/\r?\n/);
      const slice = lines.slice(-tail);
      console.log(slice.join("\n"));
    });

  jobs
    .command("cancel <jobId>")
    .description("Cancel a running job by killing its worker process")
    .action((jobId: string) => {
      const job = getJob(jobId);
      if (!job) {
        console.error(`Job not found: ${jobId}`);
        process.exitCode = 1;
        return;
      }
      if (job.status !== "running" && job.status !== "queued") {
        console.log(`Job ${jobId} is in status '${job.status}', nothing to cancel.`);
        return;
      }
      if (typeof job.pid === "number") {
        const res = killProcessTree(job.pid);
        if (!res.ok) {
          console.warn(`Worker pid ${job.pid} could not be killed: ${res.error}`);
        }
      }
      updateJob(jobId, {
        status: "cancelled",
        error: "Cancelled by user",
        completedAt: new Date().toISOString()
      });
      console.log(`Job ${jobId} marked as cancelled.`);
    });

  const docs = program.command("docs").description("Query the official TeamViewer documentation knowledge layer");

  docs
    .command("ask <question>")
    .description("Answer a TeamViewer question from verified facts and the local doc index")
    .option("--live", "Refresh the most relevant official page (via Jina) before answering", false)
    .action(async (question: string, options: { live?: boolean }) => {
      const result = await answerFromKnowledge(question, { live: Boolean(options.live) });
      console.log(result.answer);
      if (result.citations.length > 0) {
        console.log("\nSources:");
        for (const c of result.citations) console.log(`  - ${c}`);
      }
      console.log(`\nConfident: ${result.confident ? "yes" : "no"}`);
      if (!localIndexInfo().built) {
        console.log("\nTip: run 'twc docs reindex' to build the local documentation index.");
      }
    });

  docs
    .command("sources")
    .description("List the official TeamViewer documentation sources the agents can read")
    .action(() => {
      for (const doc of OFFICIAL_DOCS) {
        console.log(`${doc.id.padEnd(24)} ${doc.title}`);
        console.log(`${" ".repeat(24)} ${doc.url}`);
      }
    });

  docs
    .command("sync")
    .description("Pre-fetch and cache every official documentation source for offline use")
    .action(async () => {
      console.log("Syncing official TeamViewer documentation...");
      const results = await syncOfficialDocs();
      for (const r of results) {
        console.log(`  ${r.ok ? "OK " : "ERR"} ${r.id.padEnd(24)} ${r.detail}`);
      }
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) {
        console.log(`\n${failed} source(s) could not be fetched (network/host restrictions). Verified facts remain available offline.`);
      }
    });

  docs
    .command("reindex")
    .description("Rebuild the local documentation index from official sources (via Jina), with embeddings when Foundry Local is available")
    .action(async () => {
      console.log("Rebuilding local documentation index (fetching via Jina Reader)...");
      const results = await reindexOfficialDocs();
      for (const r of results) {
        console.log(`  ${r.ok ? "OK " : "ERR"} ${r.id.padEnd(24)} ${r.detail}`);
      }
      const info = localIndexInfo();
      const failed = results.filter((r) => !r.ok).length;
      console.log(
        `\nIndex: ${info.chunks} chunks, ${info.embeddings} embedded` +
          (info.model ? ` (model: ${info.model})` : " (keyword-only — Foundry Local embedding model not found)")
      );
      if (failed > 0) {
        console.log(`${failed} source(s) failed. Verified facts remain available offline.`);
      }
    });

  docs
    .command("index")
    .description("Show the status of the local documentation index")
    .action(() => {
      const info = localIndexInfo();
      if (!info.built) {
        console.log("No local index yet. Run 'twc docs reindex' to build it.");
        return;
      }
      console.log(`Built:      ${info.builtAt}`);
      console.log(`Chunks:     ${info.chunks}`);
      console.log(`Embedded:   ${info.embeddings}${info.model ? ` (model: ${info.model})` : ""}`);
      console.log(`Retrieval:  ${info.embeddings > 0 ? "hybrid (keyword + semantic)" : "keyword-only"}`);
    });

  program
    .command("explain <jobId>")
    .description("Explain a completed job's report in plain language")
    .action((jobId: string) => {
      const job = getJob(jobId);
      if (!job) {
        console.error(`Job not found: ${jobId}`);
        process.exitCode = 1;
        return;
      }
      if (!job.report) {
        console.error(`Job ${jobId} has no report yet (status: ${job.status}).`);
        process.exitCode = 1;
        return;
      }
      console.log(explainReport(job.report, { product: job.product, target: job.input.target, task: job.type }));
    });

  program
    .command("doctor")
    .description("Diagnose Foundry Local runtime, env vars and data directories")
    .action(async () => {
      const endpoint = discoverFoundryEndpoint();
      const model = getActiveModelId();
      const apiKey = process.env.FOUNDRY_LOCAL_API_KEY ?? process.env.OPENAI_API_KEY;

      console.log("== TWC Doctor ==");
      console.log(`FOUNDRY_LOCAL_ENDPOINT: ${endpoint ?? "(missing)"}`);
      console.log(`Active model:           ${model ?? "(missing — run 'twc models use <id>')"}`);
      console.log(`FOUNDRY_LOCAL_API_KEY:  ${apiKey ? "(set)" : "(missing, will default to placeholder)"}`);
      console.log(`MASTRA_AGENT_ENDPOINT:  ${process.env.MASTRA_AGENT_ENDPOINT ?? "(unset — good)"}`);

      if (!endpoint) {
        console.log("Result: NOT READY — set FOUNDRY_LOCAL_ENDPOINT or start 'foundry service start'.");
        process.exitCode = 1;
        return;
      }

      const probe = await probeFoundryLocal(endpoint);
      if (!probe.reachable) {
        console.log(`Probe: FAILED (${probe.error ?? "unknown"})`);
        process.exitCode = 1;
        return;
      }
      console.log(`Probe: OK (${probe.latencyMs} ms) — first model from /models: ${probe.modelId ?? "n/a"}`);
      if (!model) {
        console.log("Result: PARTIAL — endpoint reachable but no active model. Run 'twc models use <id-or-alias>'.");
        process.exitCode = 1;
        return;
      }
      console.log("Result: READY");
    });

  program
    .command("config")
    .description("Inspect current TWC configuration")
    .action(() => {
      const entries: Array<[string, string]> = [
        ["FOUNDRY_LOCAL_ENDPOINT", process.env.FOUNDRY_LOCAL_ENDPOINT ?? ""],
        ["FOUNDRY_LOCAL_MODEL", process.env.FOUNDRY_LOCAL_MODEL ?? ""],
        ["FOUNDRY_LOCAL_API_KEY", process.env.FOUNDRY_LOCAL_API_KEY ? "***set***" : ""],
        ["OPENAI_BASE_URL", process.env.OPENAI_BASE_URL ?? ""],
        ["OPENAI_API_KEY", process.env.OPENAI_API_KEY ? "***set***" : ""],
        ["MASTRA_AGENT_ENDPOINT", process.env.MASTRA_AGENT_ENDPOINT ?? "(unset)"]
      ];
      for (const [k, v] of entries) {
        console.log(`${k} = ${v || "(unset)"}`);
      }
    });

  const models = program.command("models").description("Manage Foundry Local models exposed to the workflow");

  models
    .command("list")
    .description("Show curated catalog of Foundry Local models and the active one")
    .action(() => {
      const active = getActiveModelId();
      console.log("Active: " + (active ?? "(none)"));
      console.log("");
      for (const m of MODEL_CATALOG) {
        const marker = m.id === active ? "*" : " ";
        console.log(`${marker} ${m.alias.padEnd(22)} ${m.accelerator.padEnd(3)}  ${m.id}`);
        console.log(`    ${m.family} \u2014 ${m.description}`);
      }
      console.log("");
      console.log("Install on the host: foundry model run <id>");
      console.log("Switch active:       twc models use <id-or-alias>");
    });

  models
    .command("current")
    .description("Print the currently active model id")
    .action(() => {
      const active = getActiveModelId();
      console.log(active ?? "(none)");
    });

  models
    .command("use <idOrAlias>")
    .description("Set the active Foundry Local model (persisted in .twc-data/config.json)")
    .action((input: string) => {
      const id = resolveModelId(input);
      if (!id) {
        console.error(`Unknown model '${input}'. Run 'twc models list' to see the catalog.`);
        process.exitCode = 1;
        return;
      }
      setActiveModelId(id);
      invalidateModelCache();
      const entry = findEntry(id);
      console.log(`Active model set to ${id}` + (entry ? ` (${entry.alias}, ${entry.accelerator})` : ""));
    });

  models
    .command("unset")
    .description("Clear the persisted active model")
    .action(() => {
      setActiveModelId(undefined);
      invalidateModelCache();
      console.log("Active model cleared.");
    });

  return program;
}

function normalizeTask(task: string): JobType {
  if (task === "debug" || task === "troubleshoot") {
    return task;
  }

  throw new Error(`Unsupported task '${task}'. Use debug or troubleshoot.`);
}
