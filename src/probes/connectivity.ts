// Real connectivity probes against TeamViewer endpoints. All read-only and
// timeout-bounded. Driven by a per-product profile so each TeamViewer product
// is checked against the endpoints IT actually depends on (the shared router
// backbone plus product-specific SaaS hosts).
//
// Execution model: every probe goes through an ExecutionContext.
//   • LocalContext → uses Node's `dns.resolve4` + `net.Socket` + `fetch` (fast,
//     no external tools required).
//   • SshContext   → emits commands matched to the *target* OS so reachability
//     is measured from the target's point of view: POSIX (`dig`/`getent`, `nc`,
//     `curl`) for Linux/macOS, and native PowerShell (`[Net.Dns]`, `TcpClient`,
//     `HttpWebRequest`) for Windows — exactly what you want when diagnosing
//     "why can't my Mac/PC reach the TeamViewer cloud?".

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
    ctx.os === "windows"
      ? `try { [System.Net.Dns]::GetHostAddresses('${safeHost}') | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.IPAddressToString } } catch { [Console]::Error.WriteLine($_.Exception.Message) }`
      : ctx.os === "macos"
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
  // Windows has neither nc nor a POSIX shell, so use a .NET TcpClient with an
  // async connect + WaitOne timeout. All branches converge on the same
  // __ok__/__fail__ sentinel the parser below expects.
  let probeCmd: string;
  if (ctx.os === "windows") {
    probeCmd =
      `$ErrorActionPreference='SilentlyContinue';$c=New-Object Net.Sockets.TcpClient;` +
      `try{$a=$c.BeginConnect('${safeHost}',${port},$null,$null);` +
      `if($a.AsyncWaitHandle.WaitOne(3000)){$c.EndConnect($a);'__ok__'}else{'connection timed out';'__fail__'}}` +
      `catch{$_.Exception.Message;'__fail__'}finally{$c.Close()}`;
  } else {
    const ncCmd =
      ctx.os === "macos"
        ? `/usr/bin/nc -z -G 3 '${safeHost}' ${port}`
        : `nc -z -w 3 '${safeHost}' ${port}`;
    probeCmd = `${ncCmd} 2>&1 && echo __ok__ || echo __fail__`;
  }
  const r = await ctx.runShell(probeCmd, { timeoutMs: timeoutMs + 1500 });
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
  // Windows lacks a reliable POSIX curl under the encoded-PowerShell wrapper, so
  // use HttpWebRequest and emit the SAME __TWC_RC__/__TWC_OUT__ sentinels the
  // POSIX branch produces. Map WebException states to curl-equivalent exit codes
  // (60 = trust failure, 35 = secure-channel failure) so the parser below treats
  // them identically across operating systems.
  let cmd: string;
  if (ctx.os === "windows") {
    const ms = sec * 1000;
    cmd =
      `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]'Tls12,Tls11,Tls';` +
      `try{$r=[Net.HttpWebRequest]::Create('${safe}');$r.Method='GET';$r.Timeout=${ms};$r.AllowAutoRedirect=$false;` +
      `$resp=$r.GetResponse();$code=[int]$resp.StatusCode;$resp.Close();"__TWC_RC__:0";"__TWC_OUT__:$code"}` +
      `catch [Net.WebException]{$we=$_.Exception;` +
      `if($we.Response){"__TWC_RC__:0";"__TWC_OUT__:$([int]$we.Response.StatusCode)"}` +
      `elseif($we.Status -eq 'TrustFailure'){"__TWC_RC__:60";"__TWC_OUT__:$($we.Message)"}` +
      `elseif($we.Status -eq 'SecureChannelFailure'){"__TWC_RC__:35";"__TWC_OUT__:$($we.Message)"}` +
      `else{"__TWC_RC__:7";"__TWC_OUT__:$($we.Message)"}}` +
      `catch{"__TWC_RC__:7";"__TWC_OUT__:$($_.Exception.Message)"}`;
  } else {
    cmd = `out=$(curl -sS -o /dev/null -w "%{http_code}" --max-time ${sec} '${safe}' 2>&1); rc=$?; printf "__TWC_RC__:%s\\n__TWC_OUT__:%s\\n" "$rc" "$out"`;
  }
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
    // Skip the curl re-probe on Windows (no POSIX curl under the encoded-PowerShell
    // wrapper) — the WebException already told us it's a trust failure.
    try {
      if (ctx.os === "windows") throw new Error("skip-curl-on-windows");
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
