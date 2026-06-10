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
  return {
    url,
    ok: false,
    error: (out || (ctx.os === "windows" ? "https probe failed or timed out" : "curl failed")).slice(0, 160),
    ms: Date.now() - t0
  };
}

// ───────────────────────── Batched Windows probes (one SSH+PowerShell per category) ─────────────────────────
//
// Why batch: every `ssh → powershell.exe` round-trip on a Windows target pays a
// 3–5 second cold-start *before* any network work happens. The per-endpoint
// model (one SSH call per DNS/TCP/HTTPS probe) fired 20+ of those concurrently,
// which both (a) blew the per-probe timeout during PowerShell startup and
// (b) created a process storm on the target → flaky false "unreachable" results.
// Batching pays the cold-start ONCE per category and runs the probes inside a
// single PowerShell process with generous, realistic timeouts.

function parseBestEffort(input: { host: string; port: number; bestEffort?: boolean }[]) {
  const map = new Map<string, boolean | undefined>();
  for (const p of input) map.set(`${p.host}:${p.port}`, p.bestEffort);
  return map;
}

async function remoteDnsResolveAllWindows(ctx: ExecutionContext, hosts: string[]): Promise<DnsResult[]> {
  const t0 = Date.now();
  if (hosts.length === 0) return [];
  const safe = hosts.map((h) => h.replace(/[^A-Za-z0-9._-]/g, ""));
  const arr = safe.map((h) => `'${h}'`).join(",");
  const cmd =
    `$ErrorActionPreference='SilentlyContinue';$targets=@(${arr});` +
    `foreach($h in $targets){try{` +
    `$ips=[System.Net.Dns]::GetHostAddresses($h)|Where-Object{$_.AddressFamily -eq 'InterNetwork'}|ForEach-Object{$_.IPAddressToString};` +
    `"__DNS__|$h|$([string]::Join(',',$ips))"}catch{"__DNS__|$h|"}}`;
  const r = await ctx.runShell(cmd, { timeoutMs: 30000 });
  const lines = ((r.stdout || "") + "\n" + (r.stderr || "")).split(/\r?\n/);
  const byHost = new Map<string, DnsResult>();
  for (const line of lines) {
    const m = line.match(/^__DNS__\|([^|]*)\|(.*)$/);
    if (!m) continue;
    const host = m[1].trim();
    const addrs = m[2].split(",").map((s) => s.trim()).filter((s) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s));
    byHost.set(host, addrs.length > 0
      ? { host, ok: true, addresses: addrs, ms: Date.now() - t0 }
      : { host, ok: false, error: "no A record", ms: Date.now() - t0 });
  }
  // Preserve input order; mark any host the script never reported as failed.
  return hosts.map((h) => {
    const safeH = h.replace(/[^A-Za-z0-9._-]/g, "");
    const found = byHost.get(safeH) ?? byHost.get(h);
    return found ? { ...found, host: h } : { host: h, ok: false, error: "no DNS response", ms: Date.now() - t0 };
  });
}

async function remoteTcpProbeAllWindows(
  ctx: ExecutionContext,
  pairs: { host: string; port: number; bestEffort?: boolean }[]
): Promise<TcpResult[]> {
  const t0 = Date.now();
  if (pairs.length === 0) return [];
  const bestEffort = parseBestEffort(pairs);
  const arr = pairs.map((p) => `'${p.host.replace(/[^A-Za-z0-9._-]/g, "")}:${p.port}'`).join(",");
  const cmd =
    `$ErrorActionPreference='SilentlyContinue';$pairs=@(${arr});` +
    `foreach($p in $pairs){$i=$p.LastIndexOf(':');$h=$p.Substring(0,$i);$pt=[int]$p.Substring($i+1);` +
    `$c=New-Object Net.Sockets.TcpClient;try{$a=$c.BeginConnect($h,$pt,$null,$null);` +
    `if($a.AsyncWaitHandle.WaitOne(3000)){$c.EndConnect($a);"__TCP__|$h|$pt|OK"}else{"__TCP__|$h|$pt|FAIL:connection timed out"}}` +
    `catch{"__TCP__|$h|$pt|FAIL:$($_.Exception.Message)"}finally{$c.Close()}}`;
  // 5s cold-start + up to 3s per unreachable endpoint; generous ceiling.
  const r = await ctx.runShell(cmd, { timeoutMs: Math.max(30000, pairs.length * 3500 + 8000) });
  const lines = ((r.stdout || "") + "\n" + (r.stderr || "")).split(/\r?\n/);
  const byKey = new Map<string, TcpResult>();
  for (const line of lines) {
    const m = line.match(/^__TCP__\|([^|]*)\|(\d+)\|(.*)$/);
    if (!m) continue;
    const host = m[1].trim();
    const port = parseInt(m[2], 10);
    const status = m[3].trim();
    const key = `${host}:${port}`;
    byKey.set(key, status === "OK"
      ? { host, port, ok: true, bestEffort: bestEffort.get(key), ms: Date.now() - t0 }
      : { host, port, ok: false, error: status.replace(/^FAIL:/, "").slice(0, 160) || "tcp probe failed", bestEffort: bestEffort.get(key), ms: Date.now() - t0 });
  }
  return pairs.map((p) => {
    const safeKey = `${p.host.replace(/[^A-Za-z0-9._-]/g, "")}:${p.port}`;
    const found = byKey.get(safeKey);
    return found
      ? { ...found, host: p.host }
      : { host: p.host, port: p.port, ok: false, error: "no TCP response", bestEffort: p.bestEffort, ms: Date.now() - t0 };
  });
}

async function remoteHttpsProbeAllWindows(ctx: ExecutionContext, urls: string[]): Promise<HttpResult[]> {
  const t0 = Date.now();
  if (urls.length === 0) return [];
  const safe = urls.map((u) => u.replace(/['"`$\\]/g, ""));
  const arr = safe.map((u) => `'${u}'`).join(",");
  // webapi.teamviewer.com legitimately takes ~7s end-to-end, so give each request
  // a 12s ceiling. Cold-start is paid once for the whole batch.
  const cmd =
    `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]'Tls12,Tls11,Tls';` +
    `$urls=@(${arr});foreach($u in $urls){try{` +
    `$r=[Net.HttpWebRequest]::Create($u);$r.Method='GET';$r.Timeout=12000;$r.AllowAutoRedirect=$false;` +
    `$resp=$r.GetResponse();$code=[int]$resp.StatusCode;$resp.Close();"__HTTPS__|$u|0|$code"}` +
    `catch [Net.WebException]{$we=$_.Exception;` +
    `if($we.Response){"__HTTPS__|$u|0|$([int]$we.Response.StatusCode)"}` +
    `elseif($we.Status -eq 'TrustFailure'){"__HTTPS__|$u|60|$($we.Message)"}` +
    `elseif($we.Status -eq 'SecureChannelFailure'){"__HTTPS__|$u|35|$($we.Message)"}` +
    `else{"__HTTPS__|$u|7|$($we.Message)"}}` +
    `catch{"__HTTPS__|$u|7|$($_.Exception.Message)"}}`;
  const r = await ctx.runShell(cmd, { timeoutMs: Math.max(45000, urls.length * 13000 + 8000) });
  const lines = ((r.stdout || "") + "\n" + (r.stderr || "")).split(/\r?\n/);
  const byUrl = new Map<string, HttpResult>();
  for (const line of lines) {
    const m = line.match(/^__HTTPS__\|([^|]*)\|(\d+)\|(.*)$/);
    if (!m) continue;
    const url = m[1].trim();
    const rc = parseInt(m[2], 10);
    const out = m[3].trim();
    byUrl.set(url, mapHttpsSentinel(url, rc, out, Date.now() - t0));
  }
  return urls.map((u, i) => {
    const found = byUrl.get(safe[i]) ?? byUrl.get(u);
    return found ? { ...found, url: u } : { url: u, ok: false, error: "no HTTPS response", ms: Date.now() - t0 };
  });
}

/** Shared interpretation of the __HTTPS__ rc/out sentinel (curl-equivalent codes). */
function mapHttpsSentinel(url: string, rc: number, out: string, ms: number): HttpResult {
  if (rc === 0) {
    const code = parseInt(out.slice(-3), 10);
    if (!isNaN(code) && code > 0) return { url, ok: code > 0 && code < 600, status: code, ms };
  }
  if (rc === 60 || rc === 35 || rc === 51) {
    return {
      url,
      ok: false,
      tlsValidationFailed: true,
      error: `TLS validation failed (code ${rc}) — outdated CA bundle / clock skew on host.`,
      ms
    };
  }
  return { url, ok: false, error: (out || "https probe failed or timed out").slice(0, 160), ms };
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
  // Windows SSH targets pay a 3–5s PowerShell cold-start per call, so batch all
  // probes of a category into ONE invocation instead of a 20-way concurrent storm.
  const useWinBatch = ctx.kind !== "local" && ctx.os === "windows";

  const dnsResolve = (h: string) => (ctx.kind === "local" ? localDnsResolve(h) : remoteDnsResolve(ctx, h));
  const tcpProbe = (h: string, p: number) => (ctx.kind === "local" ? localTcpProbe(h, p) : remoteTcpProbe(ctx, h, p));
  const httpsProbe = (u: string) => (ctx.kind === "local" ? localHttpsProbe(u, 6000) : remoteHttpsProbe(ctx, u, 6000));

  // 1) DNS for every host this product touches.
  const dnsResults = useWinBatch
    ? await remoteDnsResolveAllWindows(ctx, uniqueHosts)
    : await Promise.all(uniqueHosts.map(dnsResolve));
  const resolved = new Set(dnsResults.filter((r) => r.ok).map((r) => r.host));

  // 2) TCP for each endpoint/port that resolved (avoid amplifying DNS failures).
  const tcp5938: TcpResult[] = [];
  const tcpExtra: TcpResult[] = [];
  const wantPairs: { host: string; port: number; bestEffort?: boolean }[] = [];
  for (const ep of endpoints) {
    if (!resolved.has(ep.host)) continue;
    for (const port of ep.ports) wantPairs.push({ host: ep.host, port, bestEffort: ep.bestEffort });
  }
  const tcpResults: TcpResult[] = useWinBatch
    ? await remoteTcpProbeAllWindows(ctx, wantPairs)
    : await Promise.all(wantPairs.map((w) => tcpProbe(w.host, w.port).then((r) => ({ ...r, bestEffort: w.bestEffort }))));
  for (const r of tcpResults) {
    if (r.port === TV_PORT_PRIMARY) tcp5938.push(r);
    else tcpExtra.push(r);
  }

  // 3) Application-layer HTTPS checks for endpoints that expose one.
  const httpsTargets = endpoints.filter((e) => e.https);
  const httpsResults = useWinBatch
    ? (await remoteHttpsProbeAllWindows(ctx, httpsTargets.map((e) => e.https as string))).map((r, i) => ({
        ...r,
        bestEffort: httpsTargets[i].bestEffort
      }))
    : await Promise.all(
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
