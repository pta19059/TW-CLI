# Real Diagnostic Probes

Each of the 4 specialist agents is backed by an actual read-only OS / network probe — no canned
data. TeamViewer ships on Windows, Linux and macOS, and this CLI may run **wherever the agent is
installed** — on-prem or on any cloud (Oracle, Google, AWS, Azure). The cloud provider is
irrelevant; only the host OS matters, and every probe is first-class on all three.

| Specialist        | What it really does                                                                                              | Env vars                  |
|-------------------|------------------------------------------------------------------------------------------------------------------|---------------------------|
| connectivity      | DNS resolves `router{1,2,7}.teamviewer.com`, `master1`, `webapi`; TCP probe to port 5938; HTTPS GET to webapi (platform-agnostic, pure Node) | none                      |
| endpoint-health   | **Windows:** `Get-Service`/`Get-Process TeamViewer*`, `HKLM\SOFTWARE\TeamViewer` (Version, ClientID). **Linux:** `systemctl show teamviewerd`, `pgrep`, `teamviewer --info` (Version, ID). **macOS:** `launchctl list`, `pgrep`, `Info.plist` version | none                      |
| log-intelligence  | Reads tail (256 KB) of TeamViewer logs — Windows `%APPDATA%`/`%PROGRAMDATA%`, macOS `~/Library/Logs/TeamViewer`, Linux `/var/log/teamviewer` — and clusters repeating error/warning signatures | none                      |
| auth-policy       | If `TEAMVIEWER_API_TOKEN` is set: calls `webapi.teamviewer.com/api/v1/ping`, `/account`, `/devices` (platform-agnostic) | `TEAMVIEWER_API_TOKEN`    |

All probes have hard timeouts (3–6 s). Remediation steps are emitted in the host OS's native
form (`Start-Service` on Windows, `systemctl enable --now` on Linux, `launchctl` on macOS). The
LLM agents then enrich the deterministic baseline with extra hypotheses and re-ranking.

## Per-product diagnostic coverage

Every supported product has its own diagnostic **profile**
([src/catalog/productProfiles.ts](../src/catalog/productProfiles.ts)) that drives the
connectivity, endpoint-health, log and auth/policy probes. The four specialist agents read the
active product's profile, so the evidence, root causes and remediation are tailored to that
product instead of always assuming the core client.

Two delivery models are modeled honestly:

- **`local-agent`** — a process/service runs on the target host, so endpoint-health (services,
  processes, install detection) is meaningful.
- **`cloud-or-mobile`** — primarily delivered as a SaaS console and/or mobile/wearable app; there
  is usually *no* host agent, so a missing service is reported as **expected context**, not a
  fault. Diagnosis leans on connectivity + Web API reachability.

| Product | Delivery model | What the probes actually check |
| --- | --- | --- |
| **Remote** (`teamviewer-remote`) | local-agent | Core client: keepalive routers (`5938`/`443`), `master`/`login`/`webapi`, services (`TeamViewer`), processes, install/version, optional Web API account |
| **Tensor** (`teamviewer-tensor`) | local-agent | Everything in Remote **plus** the policy/SSO Web API surface (`/account`, `/devices`, `/users`, `/managedgroups`) reported as `policyChecks` |
| **Remote Management** (`teamviewer-remote-management`) | local-agent | Core client **plus** the monitoring agent (`TeamViewerMonitoring`/`ITbrain` services) and `webmonitoring.teamviewer.com` reachability |
| **DEX** (`teamviewer-dex`) | local-agent | `1E Client` services/processes and `dex.teamviewer.com` reachability (best-effort host — verify per tenant) |
| **Frontline** (`teamviewer-frontline`) | cloud-or-mobile | Connectivity + `frontline.teamviewer.com` (best-effort) + Web API; missing host agent treated as expected |
| **Assist AR** (`teamviewer-assist-ar`) | cloud-or-mobile | Connectivity + `assist-ar.teamviewer.com` (best-effort) + Web API; missing host agent treated as expected |

**Honesty notes:** endpoints marked *best-effort* (`frontline.`, `assist-ar.`,
`dex.teamviewer.com`, monitoring hosts) are region/tenant-dependent — when one is unreachable
TWC CLI surfaces it as **informational**, never as a false-positive root cause. The exact
hostnames should be confirmed against your tenant/region before production use. Each product's
baseline buckets are seeded by `productBaselineBuckets()`
([src/agents/routing.ts](../src/agents/routing.ts)) so the right probes always run even if the
issue text is vague.
