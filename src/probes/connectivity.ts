// Real connectivity probes against TeamViewer endpoints. All read-only and
// timeout-bounded. Driven by a per-product profile so each TeamViewer product
// is checked against the endpoints IT actually depends on (the shared router
// backbone plus product-specific SaaS hosts).
//
// Execution model: every probe goes through an ExecutionContext.
//   • LocalContext → uses Node's `dns.resolve4` + `net.Socket` + `fetch` (fast,
//     no external tools required).
//   • SshContext   → emits POSIX commands (`dig`, `nc`, `curl`) so reachability
//     is measured from the *target's* point of view — exactly what you want
//     when diagnosing "why can't my Mac reach the TeamViewer cloud?".

import dns from "node:dns/promises";
import net from "node:net";
import { getProductProfile, type ProbeEndpoint, type ProductDiagnosticProfile } from "../catalog/productProfiles.js";
import { LocalContext, type ExecutionContext } from "../runtime/execContext.js";

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
  /** True when the server is reachable but TLS validation failed (cert/CA/clock).
   *  HTTPS itself is up at the network layer — NOT a firewall/connectivity issue. */
  tlsValidationFailed?: boolean;
}

export interface ConnectivityReport {
  dns: DnsResult[];
  tcp5938: TcpResult[];
  https: HttpResult;
  product?: string;
  tcpExtra?: TcpResult[];
  httpsExtra?: HttpResult[];
  /** Description of where the probe ran ("local" or "ssh user@host"). */
  executionTarget?: string;
}

// ───────────────────────── Local probes (Node primitives) ─────────────────────────

async function localDnsResolve(host: string): Promise<DnsResult> {
  const t0 = Date.now();
  try {
    const addrs = await dns.resolve4(host);
    return { host, ok: true, addresses: addrs, ms: Date.now() - t0 };
  } catch (err) {
    return { host, ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  }
}

function localTcpProbe(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<TcpResult> {
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

async function localHttpsProbe(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<HttpResult> {
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

// ───────────────────────── Remote probes (shell commands over ctx) ─────────────────────────

async function remoteDnsResolve(ctx: ExecutionContext, host: string): Promise<DnsResult> {
  const t0 = Date.now();
  // Prefer `getent hosts` (linux) / `dig` / `host` / Apple `dscacheutil` —
  // fall back through them so the probe works on bare images without dig.
  const safeHost = host.replace(/[^A-Za-z0-9._-]/g, "");
  const cmd =
    ctx.os === "macos"
      ? `dscacheutil -q host -a name '${safeHost}' 2>/dev/null | awk '/^ip_address:/ {print $2}'`
      : `getent hosts '${safeHost}' 2>/dev/null | awk '{print $1}' || dig +short '${safeHost}' A 2>/dev/null`;
  const r = await ctx.runShell(cmd, { timeoutMs: 5000 });
  const addrs = (r.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s));
  if (addrs.length === 0) {
    return { host, ok: false, error: (r.stderr || "no A record").trim().slice(0, 200), ms: Date.now() - t0 };
  }
  return { host, ok: true, addresses: addrs, ms: Date.now() - t0 };
}

async function remoteTcpProbe(ctx: ExecutionContext, host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<TcpResult> {
  const t0 = Date.now();
  const safeHost = host.replace(/[^A-Za-z0-9._-]/g, "");
  // On macOS `nc -G N` sets connect timeout. On Linux netcat-openbsd uses `-w N`.
  // Try both, pick whichever the host has. `2>&1` so the error message is captured.
  const ncCmd =
    ctx.os === "macos"
      ? `/usr/bin/nc -z -G 3 '${safeHost}' ${port}`
      : `nc -z -w 3 '${safeHost}' ${port}`;
  const r = await ctx.runShell(`${ncCmd} 2>&1 && echo __ok__ || echo __fail__`, { timeoutMs: timeoutMs + 1500 });
  const out = (r.stdout || "").trim();
  if (out.endsWith("__ok__")) {
    return { host, port, ok: true, ms: Date.now() - t0 };
  }
  return {
    host,
    port,
    ok: false,
    error: out.replace(/__fail__$/, "").trim().split("\n").pop()?.slice(0, 160) || "tcp probe failed",
    ms: Date.now() - t0
  };
}

async function remoteHttpsProbe(ctx: ExecutionContext, url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<HttpResult> {
  const t0 = Date.now();
  const safe = url.replace(/['"`$\\]/g, "");
  // Run curl with explicit exit-code capture so we can tell apart:
  //   exit 0     → got an HTTP code (handle as before)
  //   exit 60/35 → TLS validation failed (cert/CA/clock) — server IS reachable
  //   anything else → real connectivity failure (DNS, timeout, refused)
  // Bundling stdout+stderr behind a sentinel keeps the parse robust across shells.
  const sec = Math.ceil(timeoutMs / 1000);
  const cmd = `out=$(curl -sS -o /dev/null -w "%{http_code}" --max-time ${sec} '${safe}' 2>&1); rc=$?; printf "__TWC_RC__:%s\\n__TWC_OUT__:%s\\n" "$rc" "$out"`;
  const r = await ctx.runShell(cmd, { timeoutMs: timeoutMs + 1500 });
  const combined = (r.stdout || "") + (r.stderr || "");
  const rcMatch = combined.match(/__TWC_RC__:(\d+)/);
  const outMatch = combined.match(/__TWC_OUT__:([\s\S]*)$/);
  const rc = rcMatch ? parseInt(rcMatch[1], 10) : NaN;
  const out = (outMatch ? outMatch[1] : combined).trim();
  if (rc === 0) {
    const code = parseInt(out.slice(-3), 10);
    if (!isNaN(code) && code > 0) {
      return { url, ok: code > 0 && code < 600, status: code, ms: Date.now() - t0 };
    }
  }
  // curl(60) = SSL_PEER_CERTIFICATE; curl(35) = SSL_CONNECT_ERROR; curl(51) = peer cert mismatch.
  if (rc === 60 || rc === 35 || rc === 51) {
    // Confirm with -k: if the server returns ANY HTTP code, it's purely a TLS
    // verification problem (server reachable, cert chain not trusted). The user
    // gets a clear, actionable message instead of a scary "failed".
    try {
      const insecure = await ctx.runShell(
        `curl -ksS -o /dev/null -w "%{http_code}" --max-time ${sec} '${safe}' 2>&1 || echo 000`,
        { timeoutMs: timeoutMs + 1500 }
      );
      const codeK = parseInt((insecure.stdout || "").trim().slice(-3), 10);
      if (!isNaN(codeK) && codeK > 0) {
        return {
          url,
          ok: false,
          status: codeK,
          tlsValidationFailed: true,
          error: `TLS validation failed (server reachable, HTTP ${codeK} with -k). Likely outdated CA bundle on this host (macOS Monterey ships with an old root store).`,
          ms: Date.now() - t0
        };
      }
    } catch { /* fall through to plain failure */ }
    return {
      url,
      ok: false,
      tlsValidationFailed: true,
      error: `TLS validation failed (curl exit ${rc}) — outdated CA bundle / clock skew on host.`,
      ms: Date.now() - t0
    };
  }
  return { url, ok: false, error: (out || "curl failed").slice(0, 160), ms: Date.now() - t0 };
}

// ───────────────────────── Public single-shot probes (used by `twc probe`) ─────────────────────────

export async function probeDnsHost(host: string, ctx: ExecutionContext = new LocalContext()): Promise<DnsResult> {
  return ctx.kind === "local" ? localDnsResolve(host) : remoteDnsResolve(ctx, host);
}

export async function probeTcpHost(host: string, port: number, timeoutMs?: number, ctx: ExecutionContext = new LocalContext()): Promise<TcpResult> {
  return ctx.kind === "local" ? localTcpProbe(host, port, timeoutMs) : remoteTcpProbe(ctx, host, port, timeoutMs);
}

// ───────────────────────── Full product-aware probe ─────────────────────────

export async function runConnectivityProbe(
  profile: ProductDiagnosticProfile = getProductProfile("teamviewer-remote"),
  ctx: ExecutionContext = new LocalContext()
): Promise<ConnectivityReport> {
  const endpoints: ProbeEndpoint[] = profile.endpoints;
  const uniqueHosts = [...new Set(endpoints.map((e) => e.host))];

  const dnsResolve = (h: string) => (ctx.kind === "local" ? localDnsResolve(h) : remoteDnsResolve(ctx, h));
  const tcpProbe = (h: string, p: number) => (ctx.kind === "local" ? localTcpProbe(h, p) : remoteTcpProbe(ctx, h, p));
  const httpsProbe = (u: string) => (ctx.kind === "local" ? localHttpsProbe(u, 6000) : remoteHttpsProbe(ctx, u, 6000));

  // 1) DNS for every host this product touches.
  const dnsResults = await Promise.all(uniqueHosts.map(dnsResolve));
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
    httpsTargets.map((e) => httpsProbe(e.https as string).then((r) => ({ ...r, bestEffort: e.bestEffort })))
  );

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
    httpsExtra: httpsResults,
    executionTarget: ctx.description
  };
}
