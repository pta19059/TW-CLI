import { describe, expect, it } from "vitest";
import {
  PRODUCT_PROFILES,
  getProductProfile,
  productLogDirs
} from "../src/catalog/productProfiles.js";
import { productBaselineBuckets } from "../src/agents/routing.js";
import {
  fromAuth,
  fromConnectivity,
  fromEndpointHealth
} from "../src/mastra/tools/specialistTools.js";
import type { ConnectivityReport } from "../src/probes/connectivity.js";
import type { EndpointHealthReport } from "../src/probes/endpointHealth.js";
import type { AuthProbeReport } from "../src/probes/authPolicy.js";

describe("product profiles catalog", () => {
  it("defines a profile for every whitelisted product key", () => {
    const keys = Object.keys(PRODUCT_PROFILES);
    expect(keys).toContain("teamviewer-remote");
    expect(keys).toContain("teamviewer-tensor");
    expect(keys).toContain("teamviewer-frontline");
    expect(keys).toContain("teamviewer-assist-ar");
    expect(keys).toContain("teamviewer-remote-management");
    expect(keys).toContain("teamviewer-dex");
  });

  it("each profile carries endpoints, names and an api surface", () => {
    for (const profile of Object.values(PRODUCT_PROFILES)) {
      expect(profile.endpoints.length).toBeGreaterThan(0);
      expect(profile.webApiPaths.length).toBeGreaterThan(0);
      expect(profile.logFilePattern).toBeInstanceOf(RegExp);
    }
  });

  it("Tensor adds the policy/SSO api surface on top of the core client", () => {
    const tensor = getProductProfile("teamviewer-tensor");
    expect(tensor.webApiPaths).toContain("/users");
    expect(tensor.webApiPaths).toContain("/managedgroups");
    expect(tensor.deliveryModel).toBe("local-agent");
  });

  it("Frontline and Assist AR are cloud/mobile delivered", () => {
    expect(getProductProfile("teamviewer-frontline").deliveryModel).toBe("cloud-or-mobile");
    expect(getProductProfile("teamviewer-assist-ar").deliveryModel).toBe("cloud-or-mobile");
  });

  it("falls back to the core client for an unknown key", () => {
    const p = getProductProfile("not-a-real-product" as never);
    expect(p.key).toBe("teamviewer-remote");
  });

  it("resolves platform-specific log directories", () => {
    expect(productLogDirs("teamviewer-remote", "linux")).toContain("/var/log/teamviewer");
    expect(productLogDirs("teamviewer-dex", "linux")).toContain("/opt/1E/Client");
  });
});

describe("productBaselineBuckets", () => {
  it("local-agent products always get connectivity + endpoint-health", () => {
    expect(productBaselineBuckets("teamviewer-remote")).toEqual(["connectivity", "endpoint-health"]);
    expect(productBaselineBuckets("teamviewer-remote-management")).toEqual(["connectivity", "endpoint-health"]);
  });

  it("cloud/mobile products always get connectivity + auth-policy", () => {
    expect(productBaselineBuckets("teamviewer-frontline")).toEqual(["connectivity", "auth-policy"]);
    expect(productBaselineBuckets("teamviewer-assist-ar")).toEqual(["connectivity", "auth-policy"]);
  });

  it("returns nothing when no product is supplied", () => {
    expect(productBaselineBuckets(undefined)).toEqual([]);
  });
});

describe("fromConnectivity product-aware rendering", () => {
  it("flags a blocked product endpoint (non-best-effort) as a root cause", () => {
    const report: ConnectivityReport = {
      dns: [{ host: "webmonitoring.teamviewer.com", ok: true, addresses: ["1.2.3.4"], ms: 5 }],
      tcp5938: [],
      https: { url: "https://webapi.teamviewer.com/api/v1/ping", ok: true, status: 200, ms: 100 },
      product: "TeamViewer Remote Management",
      tcpExtra: [
        { host: "webapi.teamviewer.com", port: 443, ok: true, ms: 20 },
        { host: "internal-proxy.teamviewer.com", port: 443, ok: false, error: "timeout", ms: 3000 }
      ],
      httpsExtra: []
    };
    const out = fromConnectivity(report, "host");
    expect(out.rootCauses.some((r) => r.title.includes("endpoint unreachable"))).toBe(true);
  });

  it("treats a best-effort endpoint failure as informational, not a root cause", () => {
    const report: ConnectivityReport = {
      dns: [{ host: "frontline.teamviewer.com", ok: true, addresses: ["1.2.3.4"], ms: 5 }],
      tcp5938: [],
      https: { url: "https://webapi.teamviewer.com/api/v1/ping", ok: true, status: 200, ms: 100 },
      product: "TeamViewer Frontline",
      tcpExtra: [
        { host: "frontline.teamviewer.com", port: 443, ok: false, error: "timeout", ms: 3000, bestEffort: true }
      ],
      httpsExtra: []
    };
    const out = fromConnectivity(report, "host");
    expect(out.rootCauses).toHaveLength(0);
    expect(out.evidence.join(" ")).toContain("tenant/region-dependent");
  });
});

describe("fromEndpointHealth delivery-model awareness", () => {
  it("does NOT flag 'not installed' for a cloud/mobile product with no agent", () => {
    const report: EndpointHealthReport = {
      platform: "win32",
      osRelease: "10.0.22631",
      hostname: "host",
      freeMemMb: 2048,
      totalMemMb: 8192,
      uptimeSec: 3600,
      services: [],
      processes: [],
      installedVersion: undefined,
      clientId: undefined,
      diagnostics: [],
      product: "TeamViewer Frontline",
      deliveryModel: "cloud-or-mobile"
    };
    const out = fromEndpointHealth(report, "host");
    expect(out.rootCauses.map((r) => r.title)).not.toContain(
      "TeamViewer not installed / not detectable on target"
    );
    expect(out.evidence.join(" ")).toContain("no host agent");
  });

  it("still flags 'not installed' for a local-agent product with no agent", () => {
    const report: EndpointHealthReport = {
      platform: "win32",
      osRelease: "10.0.22631",
      hostname: "host",
      freeMemMb: 2048,
      totalMemMb: 8192,
      uptimeSec: 3600,
      services: [],
      processes: [],
      installedVersion: undefined,
      clientId: undefined,
      diagnostics: [],
      product: "TeamViewer Remote",
      deliveryModel: "local-agent"
    };
    const out = fromEndpointHealth(report, "host");
    expect(out.rootCauses.map((r) => r.title)).toContain(
      "TeamViewer not installed / not detectable on target"
    );
  });
});

describe("fromAuth policy-check rendering", () => {
  it("flags an inaccessible product-specific Web API path", () => {
    const report: AuthProbeReport = {
      tokenPresent: true,
      pingOk: true,
      pingStatus: 200,
      accountOk: true,
      accountStatus: 200,
      accountName: "Admin",
      product: "TeamViewer Tensor",
      policyChecks: [
        { path: "/users", status: 200, ok: true },
        { path: "/managedgroups", status: 403, ok: false }
      ],
      diagnostics: []
    };
    const out = fromAuth(report, "host");
    expect(out.rootCauses.some((r) => r.title === "Web API /managedgroups not accessible")).toBe(true);
    expect(out.evidence.join(" ")).toContain("policy/API surface");
  });
});
