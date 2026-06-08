// ────────────────────────────────────────────────────────────────────────────
// Stderr noise filter (native onnxruntime warnings)
//
// onnxruntime-node prints a few harmless one-time lines to stderr on first load
// (e.g. "Error in cpuinfo: Unknown chip model name 'Snapdragon...'" on ARM64).
// These are written by native C code directly to file descriptor 2, so they
// cannot be intercepted from JavaScript in-process. To hide them we re-run the
// affected commands (`docs ask|reindex|index`, which load the local embedder) as
// a child process and filter ITS stderr stream — stdout/stdin are inherited so
// colours, results and interactivity are unaffected.
// ────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";

const NOISE =
  /cpuinfo|Windows on Arm SoC|arm[\\/]windows[\\/]init\.c|dtype not specified for|Please add new Windows/i;

/**
 * Commands that load the local ONNX embedder and therefore emit native
 * stderr noise. Includes:
 * - `docs ask|reindex|index` (direct embedder use)
 * - one-shot prompt mode (`twc -p "..."` / `twc --prompt "..."`) — the
 *   troubleshoot workflow calls retrieveKnowledgeHits() per specialist
 * - `troubleshoot` / `debug` subcommands (same workflow)
 * - the "unknown first token = free-text issue" path, which also routes
 *   into runOneShot
 *
 * NOT included: `--worker` (worker child, must not re-wrap), the bare REPL
 * (`twc` / `twc chat`, interactive stdin doesn't survive the pipe wrap
 * cleanly), and pure-metadata commands (`products list`, `jobs list`).
 */
function loadsEmbedder(argv: string[]): boolean {
  if (argv.includes("--worker")) return false;
  // One-shot mode: any -p / --prompt invocation.
  if (argv.some((a) => a === "-p" || a === "--prompt")) return true;
  // Explicit docs subcommands that load the embedder.
  if (argv[0] === "docs" && ["ask", "reindex", "index"].includes(argv[1])) return true;
  // troubleshoot / debug subcommands run the full workflow.
  if (argv[0] === "troubleshoot" || argv[0] === "debug") return true;
  return false;
}

/**
 * If this invocation will load the embedder and is not already the filtered
 * child, re-exec the same command in a child whose stderr is filtered. Returns
 * true when it took over (the caller must return immediately).
 */
export async function maybeFilterNativeStderr(argv: string[]): Promise<boolean> {
  if (process.env.TWC_STDERR_FILTERED === "1") return false;
  if (!loadsEmbedder(argv)) return false;

  const child = spawn(process.execPath, process.argv.slice(1), {
    env: { ...process.env, TWC_STDERR_FILTERED: "1" },
    stdio: ["inherit", "inherit", "pipe"]
  });

  let buffer = "";
  const flush = (final: boolean) => {
    const parts = buffer.split(/\r?\n/);
    buffer = final ? "" : parts.pop() ?? "";
    for (const line of parts) {
      if (line.length === 0 || NOISE.test(line)) continue;
      process.stderr.write(line + "\n");
    }
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    buffer += chunk;
    flush(false);
  });

  await new Promise<void>((resolve) => {
    child.on("close", (code) => {
      if (buffer) flush(true);
      process.exitCode = code ?? 0;
      resolve();
    });
    child.on("error", (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      resolve();
    });
  });
  return true;
}
