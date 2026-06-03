import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FOUNDRY_ENDPOINT_FILE } from "../paths.js";

export interface FoundryLocalStatus {
  reachable: boolean;
  endpoint: string;
  modelId?: string;
  latencyMs?: number;
  error?: string;
}

export function isLoopbackEndpoint(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function normalizeModelId(raw: string): string {
  const slashIndex = raw.indexOf("/");
  return slashIndex === -1 ? raw : raw.slice(slashIndex + 1);
}

/**
 * Parse a loopback OpenAI base URL out of a `foundry service status` line.
 * The status line can include a path (e.g. ".../openai/status"); only the
 * origin is the real server base and the OpenAI-compatible API lives at
 * <origin>/v1, so we strip any path before appending.
 */
function parseEndpointFromStatus(output: string): string | undefined {
  const match = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/\S*)?/i);
  if (!match) return undefined;
  try {
    return `${new URL(match[0]).origin}/v1`;
  } catch {
    const base = match[0].replace(/\/+$/, "");
    return base.endsWith("/v1") ? base : `${base}/v1`;
  }
}

/**
 * Run `foundry service status` and return its stdout, or undefined if the CLI
 * cannot be invoked.
 *
 * `foundry` ships as a Windows "App Execution Alias" under
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`. That alias resolves fine from an
 * interactive terminal, but does NOT reliably resolve when the process is
 * spawned by the desktop-icon launcher (twc.exe -> node -> execSync). We
 * therefore try the bare command first (works in a terminal) and then fall
 * back to known absolute executable paths (works from the icon).
 */
function runFoundryStatus(): string | undefined {
  try {
    return execSync("foundry service status", { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // bare command not resolvable in this process context — try absolute paths
  }
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    path.join(local, "Microsoft", "WindowsApps", "foundry.exe"),
    path.join(local, "Programs", "foundry", "foundry.exe"),
    path.join(local, "Microsoft", "WinGet", "Links", "foundry.exe")
  ];
  for (const exe of candidates) {
    if (!existsSync(exe)) continue;
    try {
      return execFileSync(exe, ["service", "status"], { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function readEndpointCache(): string | undefined {
  try {
    const raw = readFileSync(FOUNDRY_ENDPOINT_FILE, "utf-8");
    const parsed = JSON.parse(raw) as { endpoint?: string };
    return typeof parsed.endpoint === "string" && parsed.endpoint ? parsed.endpoint : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist a known-good endpoint so launches that cannot resolve the `foundry`
 * CLI (e.g. the desktop icon) can still find the local server. Best-effort.
 */
export function cacheFoundryEndpoint(endpoint: string): void {
  try {
    mkdirSync(path.dirname(FOUNDRY_ENDPOINT_FILE), { recursive: true });
    writeFileSync(FOUNDRY_ENDPOINT_FILE, JSON.stringify({ endpoint, savedAt: new Date().toISOString() }, null, 2));
  } catch {
    // non-fatal: discovery still works while the CLI is resolvable
  }
}

/**
 * Discover Foundry Local endpoint.
 *
 * Order: explicit env var -> live `foundry service status` (PATH or absolute
 * exe) -> last-known-good cache file. The live status is preferred so a
 * restarted service (which picks a NEW dynamic port) is always tracked; the
 * cache only kicks in when the CLI is unreachable in the current process
 * context (the desktop-icon launch).
 */
export function discoverFoundryEndpoint(): string | undefined {
  const fromEnv = process.env.FOUNDRY_LOCAL_ENDPOINT ?? process.env.OPENAI_BASE_URL ?? process.env.AZURE_OPENAI_ENDPOINT;
  if (fromEnv) {
    return fromEnv;
  }
  const status = runFoundryStatus();
  if (status) {
    const endpoint = parseEndpointFromStatus(status);
    if (endpoint) {
      cacheFoundryEndpoint(endpoint);
      return endpoint;
    }
  }
  return readEndpointCache();
}

export async function probeFoundryLocal(endpoint: string, timeoutMs = 3000): Promise<FoundryLocalStatus> {
  if (!isLoopbackEndpoint(endpoint)) {
    return { reachable: false, endpoint, error: "Endpoint is not a loopback address" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const url = endpoint.replace(/\/+$/, "") + "/models";
    const res = await fetch(url, { signal: controller.signal });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { reachable: false, endpoint, latencyMs, error: `HTTP ${res.status}` };
    }
    const data = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
    const modelId = data?.data?.[0]?.id;
    return { reachable: true, endpoint, modelId, latencyMs };
  } catch (err) {
    return { reachable: false, endpoint, error: err instanceof Error ? err.message : "Unknown probe failure" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hard gate used before every agent/workflow run. Foundry Local is mandatory:
 * if no loopback endpoint is configured or the service is unreachable, this
 * throws an actionable error instead of allowing any heuristic fallback.
 */
export async function ensureFoundryLocalReady(timeoutMs = 4000): Promise<void> {
  const endpoint = discoverFoundryEndpoint();
  if (!endpoint) {
    throw new Error(
      "Foundry Local is required but no endpoint is configured. Start it with 'foundry service start' or set FOUNDRY_LOCAL_ENDPOINT. No fallback is available."
    );
  }
  if (!isLoopbackEndpoint(endpoint)) {
    throw new Error(
      `Foundry Local endpoint '${endpoint}' is not a loopback address. Only localhost/127.0.0.1/::1 are allowed.`
    );
  }
  const status = await probeFoundryLocal(endpoint, timeoutMs);
  if (!status.reachable) {
    throw new Error(
      `Foundry Local is not reachable at ${endpoint} (${status.error ?? "unknown error"}). Start it with 'foundry service start' and load a model — agents run only on Foundry Local, with no fallback.`
    );
  }
  // Remember this working endpoint so launches that cannot resolve the
  // `foundry` CLI (e.g. the desktop icon) can still reach the local server.
  cacheFoundryEndpoint(endpoint);
}
