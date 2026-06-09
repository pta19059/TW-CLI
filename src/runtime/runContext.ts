// Per-run execution context store.
//
// The Mastra workflow tools are called without a way to pass extra arguments
// (they only receive the agent-prompt input). To let every probe pick up the
// right ExecutionContext (local vs SSH-remote) without threading it through
// every signature, we stash the active context in an AsyncLocalStorage for
// the duration of a single workflow run.
//
// Usage:
//   await withRunContext(ctx, async () => { await runMastraAgent(...); });
//   const ctx = getCurrentContext();    // anywhere inside the run

import { AsyncLocalStorage } from "node:async_hooks";
import { LocalContext, type ExecutionContext } from "./execContext.js";

const storage = new AsyncLocalStorage<ExecutionContext>();

/**
 * Optional per-run options that travel alongside the ExecutionContext for the
 * duration of a single workflow run. Kept in a SEPARATE store so the existing
 * getCurrentContext() signature (which returns just the ExecutionContext) is
 * unchanged — probes that need these opt in via getRunOptions().
 */
export interface RunOptions {
  /**
   * When set, the log probe captures a LIVE log stream for this many seconds
   * (waiting for an intermittent failure to actually occur) instead of reading
   * the last-24h history. The single biggest reliability win for sporadic
   * "drops every few minutes" symptoms — diagnose the real event, not the past.
   */
  captureWindowSec?: number;
}

const optionsStorage = new AsyncLocalStorage<RunOptions>();

/**
 * Run `fn` with `ctx` available to any code via getCurrentContext(). Optional
 * run options (e.g. live-capture window) are exposed via getRunOptions().
 */
export function withRunContext<T>(
  ctx: ExecutionContext,
  fn: () => Promise<T>,
  options: RunOptions = {}
): Promise<T> {
  return storage.run(ctx, () => optionsStorage.run(options, fn));
}

/**
 * Return the active ExecutionContext, or a fresh LocalContext if no run is
 * in progress (e.g. unit tests, ad-hoc CLI calls). Never throws.
 */
export function getCurrentContext(): ExecutionContext {
  return storage.getStore() ?? new LocalContext();
}

/** Return the active run options, or an empty object outside a run. Never throws. */
export function getRunOptions(): RunOptions {
  return optionsStorage.getStore() ?? {};
}
