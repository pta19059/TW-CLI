// Real connectivity probes against TeamViewer endpoints. All read-only and
// timeout-bounded. Driven by a per-product profile so each TeamViewer product
// is checked against the endpoints IT actually depends on (the shared router
// backbone plus product-specific SaaS hosts).

import dns from "node:dns/promises";
import net from "node:net";
import { getProductProfile, type ProbeEndpoint, type ProductDiagnosticProfile } from "../catalog/productProfiles.js";

const TV_PORT_PRIMARY = 5938;
const PROBE_TIMEOUT_MS = 3000;

export interface DnsResult {
  host: string;
  ok: boolean;
  addresses?: string[];
  error?: string;
  ms?: number;
}

export interface TcpResult {
  host: string;
  port: number;
  ok: boolean;
  error?: string;
  ms?: number;
  /** Tenant/region-dependent endpoint: a failure is informational, not a fault. */
  bestEffort?: boolean;
}

export interface HttpResult {
  url: string;
  ok: boolean;
  status?: number;
  ms?: number;
  error?: string;
  bestEffort?: boolean;
}

export interface ConnectivityReport {
  dns: DnsResult[];
  tcp5938: TcpResult[];
  https: HttpResult;
  // ── product-aware additions (optional, backward compatible) ──
  /** Product the probe targeted (display name). */
  product?: string;
  /** TCP reachability for non-5938 product ports (e.g. 443 to SaaS hosts). */
  tcpExtra?: TcpResult[];
  /** Application-layer HTTPS checks for product-specific endpoints. */
  httpsExtra?: HttpResult[];
}

async function resolveHost(host: string): Promise<DnsResult> {
  const t0 = Date.now();
  try {
    const addrs = await dns.resolve4(host);
    return { host, ok: true, addresses: addrs, ms: Date.now() - t0 };
  } catch (err) {
    return { host, ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  }
}

/** Public DNS A-record probe (used by `twc probe` CLI). */
export async function probeDnsHost(host: string): Promise<DnsResult> {
  return resolveHost(host);
}

/** Public TCP connect probe (used by `twc probe` CLI). */
export async function probeTcpHost(host: string, port: number, timeoutMs?: number): Promise<TcpResult> {
  return tcpProbe(host, port, timeoutMs);
}

function tcpProbe(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<TcpResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (result: TcpResult) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish({ host, port, ok: true, ms: Date.now() - t0 }));
    sock.once("timeout", () => finish({ host, port, ok: false, error: "timeout", ms: Date.now() - t0 }));
    sock.once("error", (err) => finish({ host, port, ok: false, error: err.message, ms: Date.now() - t0 }));
    try {
      sock.connect(port, host);
    } catch (err) {
      finish({ host, port, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function httpsProbe(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<HttpResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    return { url, ok: res.status > 0, status: res.status, ms: Date.now() - t0 };
  } catch (err) {
    return { url, ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run connectivity probes for a product. When no profile is given the legacy
 * core-client backbone is used, preserving prior behaviour.
 */
export async function runConnectivityProbe(
  profile: ProductDiagnosticProfile = getProductProfile("teamviewer-remote")
): Promise<ConnectivityReport> {
  const endpoints: ProbeEndpoint[] = profile.endpoints;
  const uniqueHosts = [...new Set(endpoints.map((e) => e.host))];

  // 1) DNS for every host this product touches.
  const dnsResults = await Promise.all(uniqueHosts.map(resolveHost));
  const resolved = new Set(dnsResults.filter((r) => r.ok).map((r) => r.host));

  // 2) TCP for each endpoint/port that resolved (avoid amplifying DNS failures).
  const tcp5938: TcpResult[] = [];
  const tcpExtra: TcpResult[] = [];
  const tcpJobs: Promise<void>[] = [];
  for (const ep of endpoints) {
    if (!resolved.has(ep.host)) continue;
    for (const port of ep.ports) {
      tcpJobs.push(
        tcpProbe(ep.host, port).then((r) => {
          const tagged = { ...r, bestEffort: ep.bestEffort };
          if (port === TV_PORT_PRIMARY) tcp5938.push(tagged);
          else tcpExtra.push(tagged);
        })
      );
    }
  }
  await Promise.all(tcpJobs);

  // 3) Application-layer HTTPS checks for endpoints that expose one.
  const httpsTargets = endpoints.filter((e) => e.https);
  const httpsResults = await Promise.all(
    httpsTargets.map((e) =>
      httpsProbe(e.https as string, 6000).then((r) => ({ ...r, bestEffort: e.bestEffort }))
    )
  );

  // Keep `https` pointing at the Web API ping for backward-compatible evidence.
  const primary =
    httpsResults.find((r) => r.url.includes("webapi.teamviewer.com")) ??
    httpsResults[0] ?? {
      url: "https://webapi.teamviewer.com/api/v1/ping",
      ok: false,
      error: "no HTTPS endpoint resolved"
    };

  return {
    dns: dnsResults,
    tcp5938,
    https: primary,
    product: profile.name,
    tcpExtra,
    httpsExtra: httpsResults
  };
}
