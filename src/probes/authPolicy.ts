// Real TeamViewer Management Console API probe. Requires a personal/script
// access token in the TEAMVIEWER_API_TOKEN env var. Read-only calls only.
// The set of API paths checked is driven by the per-product profile (e.g.
// Tensor also checks /users + /managedgroups for policy/SSO propagation).
// Doc: https://webapi.teamviewer.com/api/v1

import { getProductProfile, type ProductDiagnosticProfile } from "../catalog/productProfiles.js";

const API_BASE = "https://webapi.teamviewer.com/api/v1";
const TIMEOUT_MS = 6000;

export interface DeviceSummary {
  name: string;
  online: boolean;
  id?: string;
}

export interface PolicyCheck {
  path: string;
  status: number;
  ok: boolean;
}

export interface AuthProbeReport {
  tokenPresent: boolean;
  pingOk?: boolean;
  pingStatus?: number;
  accountOk?: boolean;
  accountStatus?: number;
  accountEmail?: string;
  accountName?: string;
  companyName?: string;
  devicesCount?: number;
  /** Up to MAX_DEVICES managed devices visible to the token (name + online state). */
  devices?: DeviceSummary[];
  /** Product-specific Web API path checks (Tensor: users/managed groups, etc.). */
  policyChecks?: PolicyCheck[];
  /** Product the probe targeted (display name). */
  product?: string;
  diagnostics: string[];
}

const MAX_DEVICES = 25;

async function getJson(url: string, token?: string): Promise<{ status: number; body: any; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: token
        ? { Authorization: `Bearer ${token}`, Accept: "application/json" }
        : { Accept: "application/json" }
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* non-json */ }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runAuthPolicyProbe(
  profile: ProductDiagnosticProfile = getProductProfile("teamviewer-remote")
): Promise<AuthProbeReport> {
  const token = process.env.TEAMVIEWER_API_TOKEN;
  const diagnostics: string[] = [];

  if (!token) {
    diagnostics.push(
      "TEAMVIEWER_API_TOKEN not set. Set it (Bearer/script token from Management Console) to enable live auth/policy probes."
    );
    return { tokenPresent: false, diagnostics, product: profile.name };
  }

  // 1) unauthenticated ping — confirms WebAPI reachability
  const ping = await getJson(`${API_BASE}/ping`);
  const pingOk = ping.status === 200;
  if (!pingOk && ping.error) {
    diagnostics.push(`WebAPI unreachable: ${ping.error}`);
  } else if (!pingOk) {
    diagnostics.push(`WebAPI ping returned HTTP ${ping.status}`);
  }

  // 2) authenticated account lookup — validates token
  const account = await getJson(`${API_BASE}/account`, token);
  const accountOk = account.status === 200;
  let accountEmail: string | undefined;
  let accountName: string | undefined;
  let companyName: string | undefined;
  if (accountOk && account.body) {
    accountEmail = account.body.email ?? account.body.userid;
    accountName = account.body.name;
    companyName = account.body.company_name;
  } else if (account.status === 401 || account.status === 403) {
    diagnostics.push(`Token rejected by /account (HTTP ${account.status}). Verify TEAMVIEWER_API_TOKEN scopes.`);
  } else if (account.error) {
    diagnostics.push(`Account lookup error: ${account.error}`);
  } else {
    diagnostics.push(`Account lookup returned HTTP ${account.status}`);
  }

  // 3) managed devices (best-effort, never blocks the report). We surface the
  //    name + online state so a laptop-side run can "see" a remote endpoint
  //    (e.g. a cloud VM enrolled in the same TeamViewer account).
  let devicesCount: number | undefined;
  let devices: DeviceSummary[] | undefined;
  if (accountOk) {
    const devs = await getJson(`${API_BASE}/devices`, token);
    if (devs.status === 200 && Array.isArray(devs.body?.devices)) {
      const list = devs.body.devices as any[];
      devicesCount = list.length;
      devices = list.slice(0, MAX_DEVICES).map((d) => ({
        name: String(d?.alias ?? d?.description ?? d?.remotecontrol_id ?? "unknown"),
        online: String(d?.online_state ?? "").toLowerCase() === "online",
        id: d?.device_id !== undefined ? String(d.device_id) : undefined
      }));
    } else if (devs.status !== 200 && devs.status !== 0) {
      diagnostics.push(`/devices returned HTTP ${devs.status} (token may lack the Devices scope).`);
    }
  }

  // 4) product-specific path checks (e.g. Tensor policy/SSO surface: /users,
  //    /managedgroups). /account and /devices are already covered above, so we
  //    only probe the additional paths declared by the profile.
  let policyChecks: PolicyCheck[] | undefined;
  if (accountOk) {
    const extraPaths = profile.webApiPaths.filter((p) => p !== "/account" && p !== "/devices");
    if (extraPaths.length > 0) {
      policyChecks = [];
      for (const p of extraPaths) {
        const res = await getJson(`${API_BASE}${p}`, token);
        policyChecks.push({ path: p, status: res.status, ok: res.status === 200 });
        if (res.status !== 200 && res.status !== 0) {
          diagnostics.push(`${profile.name}: ${p} returned HTTP ${res.status} (token may lack the required scope).`);
        }
      }
    }
  }

  return {
    tokenPresent: true,
    pingOk,
    pingStatus: ping.status,
    accountOk,
    accountStatus: account.status,
    accountEmail,
    accountName,
    companyName,
    devicesCount,
    devices,
    policyChecks,
    product: profile.name,
    diagnostics
  };
}
