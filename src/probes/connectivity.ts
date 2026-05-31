// Real connectivity probes against TeamViewer endpoints. All read-only and
// timeout-bounded. Used by the `connectivity` specialist to produce evidence
// based on the actual state of the host running the CLI.

import dns from "node:dns/promises";
import net from "node:net";

const TV_HOSTS = [
  "router1.teamviewer.com",
  "router2.teamviewer.com",
  "router7.teamviewer.com",
  "master1.teamviewer.com",
  "webapi.teamviewer.com"
];

const TV_PORT_PRIMARY = 5938;
const TV_PORT_HTTPS = 443;
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
}

export interface HttpResult {
  url: string;
  ok: boolean;
  status?: number;
  ms?: number;
  error?: string;
}

export interface ConnectivityReport {
  dns: DnsResult[];
  tcp5938: TcpResult[];
  https: HttpResult;
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

export async function runConnectivityProbe(): Promise<ConnectivityReport> {
  const dnsResults = await Promise.all(TV_HOSTS.map(resolveHost));
  // Only TCP-probe the routers that resolved (avoid amplifying DNS failures).
  const routerHosts = dnsResults
    .filter((r) => r.ok && r.host.startsWith("router"))
    .map((r) => r.host);
  const tcp5938 = await Promise.all(routerHosts.map((h) => tcpProbe(h, TV_PORT_PRIMARY)));
  const https = await httpsProbe("https://webapi.teamviewer.com/api/v1/ping", 6000);
  return { dns: dnsResults, tcp5938, https };
}
