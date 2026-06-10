// Per-product diagnostic profiles.
//
// Each TeamViewer product reaches a different part of the platform and ships a
// different on-device footprint. This catalog turns the product whitelist into
// REAL, product-specific diagnostics: every probe (connectivity, endpoint
// health, logs, auth/policy) is driven by the profile of the product under
// investigation instead of always inspecting the generic core client.
//
// Honesty notes:
//  - Hostnames marked `bestEffort` are derived from public TeamViewer naming and
//    may differ per tenant/region. The probe treats an unreachable best-effort
//    endpoint as INFORMATIONAL (not a hard root cause) so we never emit false
//    positives. Verify exact endpoints against the customer's tenant.
//  - For cloud-/mobile-delivered products (Frontline, Assist AR) the absence of a
//    local agent is EXPECTED and reported as context, not a fault.

import os from "node:os";
import path from "node:path";
import { ProductKey } from "../types.js";

export interface ProbeEndpoint {
  host: string;
  /** TCP ports to test for raw reachability. */
  ports: number[];
  /** Optional HTTPS URL to GET for an application-layer reachability signal. */
  https?: string;
  purpose: string;
  /** Tenant/region-dependent host; failures are informational, not root causes. */
  bestEffort?: boolean;
}

export interface PlatformNames {
  win32: string[];
  linux: string[];
  darwin: string[];
}

export type DeliveryModel =
  | "local-agent" // installs a background service/process on the host (Remote, Tensor, RMM, DEX)
  | "cloud-or-mobile"; // primarily SaaS + mobile/wearable; host agent optional (Frontline, Assist AR)

export interface ProductDiagnosticProfile {
  key: ProductKey;
  name: string;
  deliveryModel: DeliveryModel;
  /** Network endpoints that THIS product depends on (shared backbone + product-specific). */
  endpoints: ProbeEndpoint[];
  /** Service names to look up, per platform. */
  services: PlatformNames;
  /** Process name patterns to look up, per platform. */
  processes: PlatformNames;
  /** Regex matching this product's log file names. */
  logFilePattern: RegExp;
  /** Web API v1 paths (relative) that are meaningful for this product. */
  webApiPaths: string[];
  notes: string;
}

// ── Shared TeamViewer backbone (used by every product) ──────────────────────
// Ports verified against the official KB "Which ports are used by TeamViewer?"
// (TCP/UDP 5938 primary → TCP 443 → TCP 80). NOTE: TeamViewer does NOT publish a
// fixed hostname list — all server IPs resolve via PTR to *.teamviewer.com — so the
// specific hostnames below are best-effort/illustrative and should be confirmed per
// tenant/region. webapi.teamviewer.com is the documented Web API base.
const ROUTER_HOSTS: ProbeEndpoint[] = [
  { host: "router1.teamviewer.com", ports: [5938, 443, 80], purpose: "Session router (keepalive backbone)", bestEffort: true },
  { host: "router2.teamviewer.com", ports: [5938, 443, 80], purpose: "Session router (failover)", bestEffort: true },
  { host: "router7.teamviewer.com", ports: [5938, 443, 80], purpose: "Session router (failover)", bestEffort: true }
];
const MASTER_HOST: ProbeEndpoint = {
  host: "master1.teamviewer.com",
  ports: [443],
  https: "https://master1.teamviewer.com/",
  purpose: "Master server (initial assignment)",
  bestEffort: true
};
const LOGIN_HOST: ProbeEndpoint = {
  host: "login.teamviewer.com",
  ports: [443],
  https: "https://login.teamviewer.com/api/v1/ping",
  purpose: "Account login / SSO front door"
};
const WEBAPI_HOST: ProbeEndpoint = {
  host: "webapi.teamviewer.com",
  ports: [443],
  https: "https://webapi.teamviewer.com/api/v1/ping",
  purpose: "Management Console Web API"
};

const BACKBONE: ProbeEndpoint[] = [...ROUTER_HOSTS, MASTER_HOST, LOGIN_HOST, WEBAPI_HOST];

// Core desktop client footprint (TeamViewer Remote / Tensor share the engine).
const CORE_SERVICES: PlatformNames = {
  win32: ["TeamViewer", "TeamViewer_Service"],
  linux: ["teamviewerd"],
  darwin: ["com.teamviewer.teamviewerd", "com.teamviewer.service"]
};
const CORE_PROCESSES: PlatformNames = {
  win32: ["TeamViewer", "TeamViewer_Service", "tv_w32", "tv_x64"],
  linux: ["teamviewerd", "TeamViewer"],
  darwin: ["TeamViewer", "TeamViewer_Service"]
};

export const PRODUCT_PROFILES: Record<ProductKey, ProductDiagnosticProfile> = {
  "teamviewer-remote": {
    key: "teamviewer-remote",
    name: "TeamViewer Remote",
    deliveryModel: "local-agent",
    endpoints: [...BACKBONE],
    services: CORE_SERVICES,
    processes: CORE_PROCESSES,
    // Matches TeamViewer15_Logfile.log / TeamViewer15_Hooks.log AND TVNetwork.log
    // (the connection/keepalive network log — the most relevant for "drops").
    logFilePattern: /^(teamviewer|tvnetwork).*\.log$/i,
    webApiPaths: ["/account", "/devices"],
    notes: "Core remote-access client. Depends on the router backbone (TCP 5938, 443 fallback)."
  },

  "teamviewer-tensor": {
    key: "teamviewer-tensor",
    name: "TeamViewer Tensor",
    deliveryModel: "local-agent",
    endpoints: [
      ...BACKBONE,
      {
        host: "sso.teamviewer.com",
        ports: [443],
        https: "https://sso.teamviewer.com/",
        purpose: "Tensor SSO / Conditional Access",
        bestEffort: true
      }
    ],
    services: CORE_SERVICES,
    processes: CORE_PROCESSES,
    logFilePattern: /^(teamviewer|tvnetwork).*\.log$/i,
    // Tensor adds enterprise mgmt: users, managed groups, policies (conditional access).
    // Paths verified against the official Web API v1 OpenAPI spec.
    webApiPaths: ["/account", "/devices", "/users", "/managed/groups"],
    notes: "Enterprise (Tensor) builds on the core client and adds SSO, Conditional Access and policy management."
  },

  "teamviewer-frontline": {
    key: "teamviewer-frontline",
    name: "TeamViewer Frontline",
    deliveryModel: "cloud-or-mobile",
    endpoints: [
      LOGIN_HOST,
      WEBAPI_HOST,
      {
        host: "frontline.teamviewer.com",
        ports: [443],
        https: "https://frontline.teamviewer.com/",
        purpose: "Frontline Command Center (SaaS console)",
        bestEffort: true
      }
    ],
    // On a PC there may be a Frontline Workplace connector; usually none on servers.
    services: { win32: ["TeamViewer Frontline"], linux: [], darwin: [] },
    processes: { win32: ["Frontline", "TeamViewerFrontline"], linux: [], darwin: [] },
    logFilePattern: /(frontline|xassist|xpick|xmake|xinspect).*\.log$/i,
    webApiPaths: ["/account"],
    notes: "AR workflow suite delivered via the Frontline Command Center (SaaS) plus wearable/mobile apps. A host agent is optional."
  },

  "teamviewer-assist-ar": {
    key: "teamviewer-assist-ar",
    name: "TeamViewer Assist AR",
    deliveryModel: "cloud-or-mobile",
    endpoints: [
      ...ROUTER_HOSTS,
      LOGIN_HOST,
      WEBAPI_HOST,
      {
        host: "assist-ar.teamviewer.com",
        ports: [443],
        https: "https://assist-ar.teamviewer.com/",
        purpose: "Assist AR session service",
        bestEffort: true
      }
    ],
    // Supporter uses the desktop/web client; customer uses the mobile app.
    services: { win32: ["TeamViewer", "TeamViewer_Service"], linux: [], darwin: [] },
    processes: { win32: ["TeamViewer"], linux: [], darwin: ["TeamViewer"] },
    logFilePattern: /^(teamviewer|tvnetwork|assist[-_]?ar|pilot).*\.log$/i,
    webApiPaths: ["/account"],
    notes: "AR remote support (formerly Pilot). Uses the session backbone; the field side is the mobile app, the supporter side the desktop/web client."
  },

  "teamviewer-remote-management": {
    key: "teamviewer-remote-management",
    name: "TeamViewer Remote Management",
    deliveryModel: "local-agent",
    endpoints: [
      ...BACKBONE,
      {
        host: "webmonitoring.teamviewer.com",
        ports: [443],
        https: "https://webmonitoring.teamviewer.com/",
        purpose: "Monitoring / asset / endpoint protection data ingest",
        bestEffort: true
      }
    ],
    // Remote Management ships a monitoring agent (historically branded ITbrain).
    services: {
      win32: ["TeamViewer", "TeamViewer_Service", "TeamViewerMonitoring", "ITbrain"],
      linux: ["teamviewerd"],
      darwin: ["com.teamviewer.teamviewerd"]
    },
    processes: {
      win32: ["TeamViewer_Monitoring", "TeamViewer.RemoteManagement", "ITbrain", "TeamViewer"],
      linux: ["teamviewerd"],
      darwin: ["TeamViewer"]
    },
    logFilePattern: /^(teamviewer|tvnetwork|monitoring|itbrain|remotemanagement).*\.log$/i,
    webApiPaths: ["/account", "/devices"],
    notes: "RMM suite (Monitoring, Asset Management, Endpoint Protection, Patch, Backup). Adds a monitoring agent and a data-ingest endpoint."
  },

  "teamviewer-dex": {
    key: "teamviewer-dex",
    name: "TeamViewer DEX",
    deliveryModel: "local-agent",
    endpoints: [
      LOGIN_HOST,
      WEBAPI_HOST,
      {
        host: "dex.teamviewer.com",
        ports: [443],
        https: "https://dex.teamviewer.com/",
        purpose: "Digital Employee Experience cloud (1E platform)",
        bestEffort: true
      }
    ],
    // DEX is built on the 1E platform; the host runs the 1E Client agent.
    services: { win32: ["1E Client", "1E.Client"], linux: ["1eclient"], darwin: [] },
    processes: { win32: ["1E.Client"], linux: ["1eclient"], darwin: [] },
    logFilePattern: /(1e|dex).*\.log$/i,
    webApiPaths: ["/account"],
    notes: "Digital Employee Experience (1E platform). The host runs the 1E Client agent reporting to the DEX cloud."
  }
};

export function getProductProfile(key: ProductKey): ProductDiagnosticProfile {
  return PRODUCT_PROFILES[key] ?? PRODUCT_PROFILES["teamviewer-remote"];
}

/** Resolve candidate log directories for a product on the current platform. */
export function productLogDirs(_key: ProductKey, platform: NodeJS.Platform): string[] {
  const dirs: string[] = [];
  if (platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    const programData = process.env.PROGRAMDATA ?? "C:\\ProgramData";
    dirs.push(
      path.join(appData, "TeamViewer"),
      path.join(programData, "TeamViewer", "Logs"),
      path.join(programData, "TeamViewer"),
      path.join(programData, "1E", "Client"),
      "C:\\Program Files\\TeamViewer",
      "C:\\Program Files (x86)\\TeamViewer"
    );
  } else if (platform === "darwin") {
    dirs.push(path.join(os.homedir(), "Library", "Logs", "TeamViewer"));
  } else {
    dirs.push(
      "/var/log/teamviewer",
      "/opt/1E/Client",
      path.join(os.homedir(), ".local", "share", "teamviewer")
    );
  }
  return dirs;
}
