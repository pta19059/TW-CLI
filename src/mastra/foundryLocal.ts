import { execSync } from "node:child_process";

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
 * Discover Foundry Local endpoint via `foundry service status`.
 * Falls back to the configured FOUNDRY_LOCAL_ENDPOINT.
 */
export function discoverFoundryEndpoint(): string | undefined {
  const fromEnv = process.env.FOUNDRY_LOCAL_ENDPOINT ?? process.env.OPENAI_BASE_URL ?? process.env.AZURE_OPENAI_ENDPOINT;
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const output = execSync("foundry service status", { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const match = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/\S*)?/i);
    if (match) {
      const base = match[0].replace(/\/+$/, "");
      return base.endsWith("/v1") ? base : `${base}/v1`;
    }
  } catch {
    // Foundry CLI not present or service down
  }
  return undefined;
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
}
