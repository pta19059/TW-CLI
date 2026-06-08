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

/** Run `fn` with `ctx` available to any code via getCurrentContext(). */
export function withRunContext<T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * Return the active ExecutionContext, or a fresh LocalContext if no run is
 * in progress (e.g. unit tests, ad-hoc CLI calls). Never throws.
 */
export function getCurrentContext(): ExecutionContext {
  return storage.getStore() ?? new LocalContext();
}
