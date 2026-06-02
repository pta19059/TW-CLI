# TWC CLI (TeamViewer Command Line)

![TWC CLI interactive shell](docs/assets/banner.png)

Interactive CLI focused on TeamViewer products, with `debug` and `troubleshoot` tasks executed in the background by a Mastra agent backend.

The CLI offers several ways to work:

- `twc` with no arguments → interactive REPL with banner, model/endpoint info, slash commands.
- `twc -p "<issue>"` → one-shot synchronous run with spinner.
- `twc "<free text>"` → treated as a free-text troubleshoot prompt.
- All existing subcommands (`products`, `agents`, `debug`, `troubleshoot`, `jobs`, `doctor`, `config`, `docs`) still work unchanged.

## Command cheat sheet

The `twc` prefix is optional inside the interactive shell. Run `twc --help` or `twc <command> --help` for full option details.

| Command | What it does |
|---|---|
| `twc` | Open the interactive REPL (banner + slash commands) |
| `twc chat [--product <key>]` | Open the REPL with a preset product |
| `twc "<free text>"` | Troubleshoot from a natural-language sentence (auto-detects product/target) |
| `twc -p "<issue>" [--product <key>] [--target <v>] [--task <t>] [--context <c>] [--model <id>] [--markdown]` | One-shot synchronous run |
| `twc products list` | List the whitelisted TeamViewer products |
| `twc agents list` | List the Mastra agent roles |
| `twc agents plan --task <t> --issue "<text>"` | Show which agents would be selected (dry run) |
| `twc debug <product> --target <v> --issue "<text>" [--context <c>] [--wait]` | Run a background **debug** job (`--wait` prints the output directly) |
| `twc troubleshoot <product> --target <v> --issue "<text>" [--context <c>] [--wait]` | Run a background **troubleshoot** job (`--wait` prints the output directly) |
| `twc jobs list [--limit N]` | List recent background jobs |
| `twc jobs show [jobId] [--json\|--markdown]` | Show a job report (no id = last queued job) |
| `twc jobs logs [jobId] [--tail N]` | Tail a job's worker log (no id = last queued job) |
| `twc jobs cancel <jobId>` | Kill a running or queued job |
| `twc explain <jobId>` | Turn a job report into a plain-language narrative |
| `twc docs ask "<question>" [--live]` | Answer a TeamViewer question from official docs |
| `twc docs sources` | List the official documentation sources |
| `twc docs sync` | Pre-fetch & cache all official docs for offline use |
| `twc models list\|use <id>\|current\|unset` | Manage the active Foundry Local model |
| `twc doctor` | Diagnose Foundry Local runtime, env vars and data dirs |
| `twc config` | Print the resolved configuration |

### Worked examples (real values)

Copy-paste these to see exactly how a command is structured:

```powershell
# Natural language — product (Tensor) and target (vm-twc-demo) are auto-detected:
twc "tensor session drops on vm-twc-demo after 5 minutes"

# One-shot troubleshoot, fully explicit, Markdown report for a ticket:
twc -p "Session drops after 5 minutes" --product teamviewer-remote --target endpoint-001 --context "VPN on, intermittent packet loss" --markdown

# Background troubleshoot job for Tensor policy rollout:
twc troubleshoot teamviewer-tensor --target tenant-acme --issue "Policy rollout not applied" --context "EU region, 1200 devices"

# Same, but wait and print the output directly (no need to copy the job id):
twc debug teamviewer-remote --target endpoint-001 --issue "Cannot connect to remote device" --context "Behind corporate proxy" --wait

# The last queued job is remembered, so you can inspect it later WITHOUT the id:
twc jobs show            # shows the last job
twc jobs show --markdown # last job as a Markdown report
twc jobs logs --tail 100 # tail the last job's worker log

# ...or target a specific job by id from the list:
twc jobs list --limit 5
twc jobs show 8fK2aQ9xLp --markdown
twc jobs logs 8fK2aQ9xLp --tail 100

# Ask the official docs and explain a finished report in plain language:
twc docs ask "which ports does teamviewer use"
twc explain 8fK2aQ9xLp

# Pick a different on-device model, then run with it:
twc models use deepseek-r1-7b
twc -p "Web API token rejected" --product teamviewer-tensor
```

> `8fK2aQ9xLp` is just an example job id — use the id printed by `twc jobs list`
> or returned when you queue a `debug` / `troubleshoot` job.

## Goal

- Allow operations only on whitelisted TeamViewer products.
- Launch non-blocking agent tasks (detached worker per command).
- Return structured reports: hypotheses, evidence, root-cause scoring, remediation, confidence, escalation.

## TWC CLI vs TeamViewerPS

[TeamViewerPS](https://github.com/teamviewer/TeamViewerPS) is the official PowerShell
module from TeamViewer. It is an **administration / automation** wrapper around the
TeamViewer Web API (user management, user groups, roles, managed groups, policy
management, SSO, Computers & Contacts) plus a few local utility cmdlets
(`Get-TeamViewerId`, `Get-TeamViewerVersion`, `Get-TeamViewerInstallationType`).

TWC CLI solves a **different problem**: AI-assisted, local-first **diagnostics and
root-cause troubleshooting**. The two are complementary rather than competing — but
for troubleshooting workflows, TWC CLI offers concrete advantages:

| Dimension | TeamViewerPS | **TWC CLI (this project)** |
| --- | --- | --- |
| Primary purpose | Administer/provision accounts via Web API | **Diagnose & troubleshoot** TeamViewer issues |
| Intelligence | None — returns raw API objects | **Local LLM + 5 Mastra agents**: hypotheses, root-cause scoring, remediation, confidence, escalation |
| Output | PowerShell objects | **Structured Markdown reports** (evidence-anchored) |
| Real diagnostic probes | No | **Yes** — connectivity (DNS/TCP `5938`/HTTPS), endpoint health (services/registry/processes), auth-policy, log clustering |
| Network dependency | Requires TeamViewer **Web API token** + cloud calls | **Works offline** for most probes; inference is **loopback-only** (no cloud, no telemetry) |
| Privacy | Sends data to TeamViewer cloud API | **100% on-device** LLM (Foundry Local, NPU-accelerated); built-in **secret/PII redaction** ([src/jobs/redact.ts](src/jobs/redact.ts)) |
| Execution model | Synchronous cmdlets | **Non-blocking job model** — detached worker per command, job store, per-job logs, retention |
| UX | Cmdlets only | **Modern terminal UX**: REPL + one-shot + free-text + slash commands |
| Guardrails | API permissions | **Product whitelist**, sanitized prompts, strict **no-fallback Foundry Local** policy |
| Model choice | n/a | **Swappable curated catalog** (`twc models use …`), NPU/CPU builds, reasoning models (DeepSeek-R1, Phi-4) |
| Runtime | PowerShell 5.1 / 7 | Node ESM + cross-platform **single-file .NET launcher** (`twc`) |

**Key advantages of TWC CLI**

1. **Root-cause analysis, not raw data.** TeamViewerPS hands you API objects; TWC CLI runs
   parallel specialist agents over real probe evidence and produces ranked hypotheses,
   remediation steps, a confidence score, and an escalation decision.
2. **Local-first & private by design.** All LLM inference is forced to a loopback Foundry
   Local endpoint (`localhost`/`127.0.0.1`/`::1`) with **no fallback** to remote providers —
   nothing leaves the machine, and most probes need no API token at all.
3. **Diagnostics TeamViewerPS simply doesn't have.** Connectivity, endpoint health, auth/policy
   and log-intelligence probes are purpose-built for *"why isn't TeamViewer working?"* — a
   scenario TeamViewerPS does not address.
4. **Operational ergonomics.** Detached background jobs, persisted logs, structured reports,
   and an interactive REPL make it usable both interactively and in automation.
5. **Security hardening.** Built-in redaction of emails/IPs/JWTs/tokens/`password=` pairs,
   input sanitization, and a product whitelist.

**When to use TeamViewerPS instead:** for *managing* a TeamViewer account — creating users,
assigning policies/roles, configuring SSO, syncing Computers & Contacts. TWC CLI does **not**
provision or mutate account state. A natural workflow is: **TeamViewerPS to administer**, then
**TWC CLI to diagnose** when something breaks.

## Supported TeamViewer Products (Whitelist)

- TeamViewer Remote (`teamviewer-remote`)
- TeamViewer Tensor (`teamviewer-tensor`)
- TeamViewer Frontline (`teamviewer-frontline`)
- TeamViewer Assist AR (`teamviewer-assist-ar`)
- TeamViewer Remote Management (`teamviewer-remote-management`)
- TeamViewer DEX (`teamviewer-dex`)

The whitelist is defined in [src/catalog/teamviewerProducts.ts](src/catalog/teamviewerProducts.ts) and should be revalidated against official TeamViewer sources before production release.

### Per-product diagnostic coverage

Every product is no longer just a *whitelist string*: it has its own diagnostic
**profile** ([src/catalog/productProfiles.ts](src/catalog/productProfiles.ts)) that
drives the connectivity, endpoint-health, log and auth/policy probes. The four
specialist agents read the active product's profile, so the evidence, root causes and
remediation are tailored to that product instead of always assuming the core client.

Two delivery models are modeled honestly:

- **`local-agent`** — a process/service runs on the target host, so endpoint-health
  (services, processes, install detection) is meaningful.
- **`cloud-or-mobile`** — primarily delivered as a SaaS console and/or mobile/wearable
  app; there is usually *no* host agent, so a missing service is reported as **expected
  context**, not a fault. Diagnosis leans on connectivity + Web API reachability.

| Product | Delivery model | What the probes actually check |
| --- | --- | --- |
| **Remote** (`teamviewer-remote`) | local-agent | Core client: keepalive routers (`5938`/`443`), `master`/`login`/`webapi`, services (`TeamViewer`), processes, install/version, optional Web API account |
| **Tensor** (`teamviewer-tensor`) | local-agent | Everything in Remote **plus** the policy/SSO Web API surface (`/account`, `/devices`, `/users`, `/managedgroups`) reported as `policyChecks` |
| **Remote Management** (`teamviewer-remote-management`) | local-agent | Core client **plus** the monitoring agent (`TeamViewerMonitoring`/`ITbrain` services) and `webmonitoring.teamviewer.com` reachability |
| **DEX** (`teamviewer-dex`) | local-agent | `1E Client` services/processes and `dex.teamviewer.com` reachability (best-effort host — verify per tenant) |
| **Frontline** (`teamviewer-frontline`) | cloud-or-mobile | Connectivity + `frontline.teamviewer.com` (best-effort) + Web API; missing host agent treated as expected |
| **Assist AR** (`teamviewer-assist-ar`) | cloud-or-mobile | Connectivity + `assist-ar.teamviewer.com` (best-effort) + Web API; missing host agent treated as expected |

**Honesty notes:** endpoints marked *best-effort* (`frontline.`, `assist-ar.`,
`dex.teamviewer.com`, monitoring hosts) are region/tenant-dependent — when one is
unreachable TWC CLI surfaces it as **informational**, never as a false-positive root
cause. The exact hostnames should be confirmed against your tenant/region before
production use. Each product's baseline buckets are seeded by
`productBaselineBuckets()` ([src/agents/routing.ts](src/agents/routing.ts)) so the
right probes always run even if the issue text is vague.

## Architecture

Mastra is the **core orchestrator** of this project. Every job flows through a multi-step Mastra workflow that calls real Mastra agents in parallel against a local LLM (Foundry Local).

1. CLI process (`twc`): command parsing, product validation, job enqueue.
2. Job store (`.twc-data/jobs.json`): atomic writes + retention (last 200 jobs).
3. Per-job logs (`.twc-data/logs/<jobId>.log`): stdout/stderr of the detached worker.
4. Detached worker (`dist/worker.js`): background task execution with pid tracking.
5. Mastra adapter (`src/agents/mastraAdapter.ts`): refuses remote endpoints, delegates entirely to the local runtime.
6. Mastra runtime (`src/mastra/`): `Mastra` instance with 5 `Agent`s, 4 `createTool` specialists, one multi-step `createWorkflow`.
7. Foundry Local discovery (`src/mastra/foundryLocal.ts`): endpoint discovery + `/models` probe.

Workflow steps (Mastra-native):

```
[input] → classify-and-plan (gateway LLM)
        → parallel:
            specialist-connectivity     (connectivityAgent + tool)
            specialist-auth-policy      (authPolicyAgent + tool)
            specialist-endpoint-health  (endpointHealthAgent + tool)
            specialist-log-intelligence (logIntelligenceAgent + tool)
        → aggregate-report (gateway LLM rerank + summary)
        → [WorkflowReport]
```

Each specialist step:

- Runs a deterministic baseline tool (resilient to LLM failure).
- Calls its Mastra Agent with a sanitized prompt and a narrow JSON contract.
- Merges baseline + LLM enrichment (hypotheses, root causes, actions).
- Skips itself if its bucket is not triggered.

All LLM I/O goes through `generateStructured()`, a tolerant JSON parser with retries and typed fallback, so a misbehaving local model never crashes the workflow.

## Implemented Agents

Logical agent roles (declared in [src/agents/profiles.ts](src/agents/profiles.ts), used by `twc agents list`, `twc agents plan` and the workflow `execution` log):

- product-gatekeeper
- session-context
- diagnosis-planner
- connectivity
- auth-policy
- endpoint-health
- log-intelligence
- remediation
- confidence-escalation
- report

Real Mastra `Agent` instances (declared in [src/mastra/agents/index.ts](src/mastra/agents/index.ts)):

- `tw-gateway-agent` — classifies issues, reranks root causes, writes the executive summary.
- `tw-connectivity-agent` — uses `connectivityTool`.
- `tw-auth-policy-agent` — uses `authPolicyTool`.
- `tw-endpoint-health-agent` — uses `endpointHealthTool`.
- `tw-log-intelligence-agent` — uses `logIntelligenceTool`.

Tools are defined in [src/mastra/tools/specialistTools.ts](src/mastra/tools/specialistTools.ts). The four `run*Analysis` functions also act as deterministic baselines used by the specialist workflow steps.

Useful commands:

```bash
twc agents list
twc agents plan --task troubleshoot --issue "Policy not applied" --context "SSO enabled"
```

## Runtime Flow

1. `twc troubleshoot teamviewer-remote ...`
2. whitelist product validation
3. job creation (`queued`), pid tracked, log file opened
4. detached worker spawn (stdio redirected to `.twc-data/logs/<id>.log`)
5. worker moves job to `running`, sets `startedAt`
6. Mastra workflow runs: classify → parallel specialists → aggregate
7. worker saves structured report + text + `completedAt`
8. job transitions to `completed` / `failed` / `cancelled`
9. inspect with `twc jobs show <jobId>` (text, `--json`, or `--markdown`)

## Real Diagnostic Probes

Each of the 4 specialists is backed by an actual read-only OS / network probe — no canned data.
TeamViewer ships on Windows, Linux and macOS, and this CLI may run **wherever the agent is
installed** — on-prem or on any cloud (Oracle, Google, AWS, Azure). The cloud provider is
irrelevant; only the host OS matters, and every probe is first-class on all three:

| Specialist        | What it really does                                                                                              | Env vars                  |
|-------------------|------------------------------------------------------------------------------------------------------------------|---------------------------|
| connectivity      | DNS resolves `router{1,2,7}.teamviewer.com`, `master1`, `webapi`; TCP probe to port 5938; HTTPS GET to webapi (platform-agnostic, pure Node) | none                      |
| endpoint-health   | **Windows:** `Get-Service`/`Get-Process TeamViewer*`, `HKLM\SOFTWARE\TeamViewer` (Version, ClientID). **Linux:** `systemctl show teamviewerd`, `pgrep`, `teamviewer --info` (Version, ID). **macOS:** `launchctl list`, `pgrep`, `Info.plist` version | none                      |
| log-intelligence  | Reads tail (256 KB) of TeamViewer logs — Windows `%APPDATA%`/`%PROGRAMDATA%`, macOS `~/Library/Logs/TeamViewer`, Linux `/var/log/teamviewer` — and clusters repeating error/warning signatures | none                      |
| auth-policy       | If `TEAMVIEWER_API_TOKEN` is set: calls `webapi.teamviewer.com/api/v1/ping`, `/account`, `/devices` (platform-agnostic) | `TEAMVIEWER_API_TOKEN`    |

All probes have hard timeouts (3–6 s). Remediation steps are emitted in the host OS's native
form (`Start-Service` on Windows, `systemctl enable --now` on Linux, `launchctl` on macOS).
The LLM agents then enrich the deterministic baseline with extra hypotheses and re-ranking.

## Knowledge & official docs

The agents are grounded against TeamViewer's **official documentation** so they answer
accurately instead of hallucinating, and stay honest when they don't know.

Two layers (`src/knowledge/teamviewerDocs.ts`):

1. **Verified facts** — a curated, offline set of facts confirmed against the official KB and
   the Web API v1 spec (primary port 5938 → fallback 443 → 80; Web API base
   `https://webapi.teamviewer.com/api/v1` and its documented endpoints; the fact that
   TeamViewer publishes no fixed server IP/hostname list; DEX = 1E Client; per-product delivery
   models). These ground every specialist prompt and are always available with no network.
2. **Official docs (read on demand)** — the agents can fetch real TeamViewer doc pages directly
   (`twc docs ... --live`), strip them to text and cache them under `~/.twc/knowledge` for
   instant, offline reuse. Fetches are restricted to a `*.teamviewer.com` host allowlist (SSRF
   guard); there is **no archive/Wayback fallback** — docs come straight from the source.
3. **Live web search (`--live`)** — because teamviewer.com rejects direct fetches behind its
   WAF (TLS handshake failure), `--live` also runs a live search via the **Brave Search API**,
   **restricted to official `*.teamviewer.com` hosts** (no local cache). The result titles,
   snippets and URLs ground the answer and are cited as sources — so even pages that can't be
   fetched directly still yield a grounded, sourced answer. Set a free Brave key in the
   `BRAVE_API_KEY` environment variable (get one at https://brave.com/search/api/); without it
   `--live` degrades cleanly to the offline verified facts.

Every specialist agent and the gateway agent get a `tw-official-docs` tool. When a model is
unsure it calls the tool; if the answer isn't grounded the tool returns `confident: false` and
the agent points the user to the cited official URL rather than guessing.

```powershell
twc docs ask "which ports does teamviewer use"      # answer from verified facts + docs
twc docs ask "how does Tensor SSO work" --live        # read the official page first
twc docs sources                                       # list the official doc URLs
twc docs sync                                          # pre-fetch & cache all docs for offline use
```

## Azure Demo (laptop ↔ remote VM)

This is a short, **reproducible** demo. The reproduction scripts live in
[demo/azure](demo/azure) so you can replay it even without the original Azure
account — just supply your own subscription and TeamViewer tokens.

### Architecture

```
┌─────────────────────────┐        TeamViewer WebAPI        ┌──────────────────────────┐
│  Your laptop            │  ───────────────────────────▶  │  Azure VM (Ubuntu 22.04) │
│  twc CLI (this repo)    │   GET /account, GET /devices    │  TeamViewer Host daemon  │
│  TEAMVIEWER_API_TOKEN   │  ◀───────────────────────────  │  enrolled via assignment │
└─────────────────────────┘    sees VM by name + state      └──────────────────────────┘
```

The CLI is **not** installed on the VM. It runs on your laptop and observes the
remote VM through the TeamViewer account: the VM enrolls as a managed device,
and the `auth-policy` specialist lists it by name and online/offline state.
The `connectivity` specialist independently validates reachability of the
TeamViewer network endpoints from the laptop.

### Prerequisites

- A TeamViewer account.
- A **WebAPI script token** (Management Console → *Edit profile → Apps →
  Create script token*) with the **Account: read** and **Device groups /
  Computers & Contacts: read** scopes. Use it as `TEAMVIEWER_API_TOKEN`.
- An **assignment token** (Management Console → *Design & Deploy* or the
  *Assignment* tool) to enroll the VM into your account.
- Azure CLI logged in: `az login` (the demo uses resource group `TW` in
  `swedencentral` by default — change with script parameters).

### 1 — Deploy the remote VM (one command)

```powershell
cd demo/azure
./Deploy-TeamViewerDemo.ps1 -AssignmentToken "<assignment-token>"
```

This creates an Ubuntu `Standard_B2s` VM in RG `TW`, installs TeamViewer Host
headless via [cloud-init](demo/azure/cloud-init.yaml), enables `teamviewerd`,
and enrolls the device (alias `vm-twc-demo`). Enrollment completes ~2–3 min
after boot.

### 2 — Run the demo from your laptop

```powershell
cd "c:\TW CLI"
npm install; npm run build

$env:TEAMVIEWER_API_TOKEN = "<webapi-script-token>"

# Connectivity health from the laptop:
node dist/index.js doctor

# Full diagnosis that "sees" the remote VM by name:
node dist/index.js troubleshoot "VM unreachable" --product "TeamViewer Remote" --target vm-twc-demo
```

### Expected output

- **auth-policy**: `Authenticated as <you>`, `Managed devices: vm-twc-demo
  (online), …`, and `Target 'vm-twc-demo' matches managed device 'vm-twc-demo'
  — online`. If the VM is powered off, it instead reports it **offline** and
  raises a root cause + remediation.
- **connectivity**: resolves and reaches `router*.teamviewer.com` / `webapi`
  on TCP 5938 / 443.
- The aggregate report (`twc jobs show <jobId> --markdown`) merges these into a
  ranked root-cause + action list.

> The Foundry Local LLM layer is optional. Without it the deterministic
> probe-driven baseline still runs and produces the report.

### Cleanup

```powershell
az group delete --name TW --yes --no-wait
```


## Setup

```bash
npm install
npm run build
cp .env.example .env   # then edit endpoint/model/token as needed
```

The CLI auto-loads `.env` from the current directory, `~/.twc/.env`, the install
directory, or `$TWC_HOME/.env`, so a global install still finds its config.

## Running From PowerShell

Global command (if you want to run it from terminal):

```powershell
npm run build
npm run link:global
twc --help
twc products list
```

Windows `.exe` executable:

```powershell
npm install
npm run build:exe
.\bin\twc.exe --help
.\bin\twc.exe products list
```

Note: `twc.exe` is a native Windows launcher and requires Node.js to be installed on the machine.
If you run it outside the project root, set `TWC_HOME` to the project path (for example `C:\TW CLI`).

Icon mode (double-click):

- Double-click `bin\\twc.exe`.
- If no arguments are passed, a persistent console opens with prompt `twc>` (it does not close immediately).
- On startup, a stylized TeamViewer name is shown with a startup animation.
- Type CLI commands (`products list`, `jobs list`, etc.) or `exit` to close.

To create a desktop icon:

```powershell
.\create-desktop-shortcut.ps1
```

To run it as a command from any folder, add `C:\TW CLI\bin` to the Windows `PATH`.

## Main Commands

### Interactive REPL

```powershell
twc                          # opens the REPL
twc chat --product teamviewer-remote   # opens the REPL with a preset product
```

Inside the REPL:

| Command | Purpose |
|---|---|
| `<free text>` | describe an issue, runs the workflow synchronously |
| `/product <key>` | set the active TeamViewer product |
| `/target <value>` | set the target (default `local-device`) |
| `/task <debug\|troubleshoot>` | switch task type |
| `/context <text>` | attach one-shot extra context |
| `/products` | list whitelist |
| `/agents` | list Mastra agent roles |
| `/jobs [N]` | list recent background jobs |
| `/show <jobId>` | render a job report |
| `/explain <jobId>` | explain a job report in plain language |
| `/logs <jobId> [N]` | tail a job log |
| `/cancel <jobId>` | kill a running job |
| `/doctor` | Foundry Local health check |
| `/docs <question>` | ask the official-docs knowledge layer |
| `/model` | show endpoint + model |
| `/clear`, `/help`, `/exit` | screen / help / leave |

### Natural-language input (Tia-style, but in the terminal)

You don't have to set flags. Just describe the problem and the CLI infers the
**product** and **target** from your sentence; in the REPL it asks a clarifying
question only when the product is still ambiguous.

```powershell
# product (tensor) and target (vm-twc-demo) are auto-detected from the text:
twc "tensor cannot reach device vm-twc-demo"

# inside the REPL, just type:
twc › remote management monitoring agent stopped on web-prod-01
  (detected product: TeamViewer Remote Management)
  (detected target: web-prod-01)
```

Detection is deterministic (no LLM required); explicit `--product` / `--target`
always override it.

### Plain-language explanation

Turn any completed job's structured report into a phone-support-style narrative:

```powershell
twc explain <jobId>      # or  /explain <jobId>  inside the REPL
```

### Copy-paste remediation

When a fix maps to an OS-native command (e.g. a stopped service), the report
includes a ready-to-run **Suggested commands** block tailored to the host OS
(`Start-Service` on Windows, `systemctl enable --now` on Linux, `launchctl` on
macOS).

### One-shot mode

```powershell
twc -p "Session drops after 5 minutes" --product teamviewer-remote --target endpoint-001
twc -p "Policy not applied" --product teamviewer-tensor --markdown
```

### Subcommand mode

List products:

```bash
twc products list
```

Run debug in background:

```bash
twc debug teamviewer-remote \
  --target "endpoint-001" \
  --issue "Session drops after 5 minutes" \
  --context "VPN enabled, intermittent packet loss"
```

Run troubleshoot in background:

```bash
twc troubleshoot teamviewer-tensor \
  --target "tenant-acme" \
  --issue "Policy rollout not applied"
```

List jobs:

```bash
twc jobs list
```

Job details (human view):

```bash
twc jobs show <jobId>
```

Job details (raw JSON):

```bash
twc jobs show <jobId> --json
```

Job details (Markdown, ready to paste into a ticket):

```bash
twc jobs show <jobId> --markdown
```

Per-job worker logs:

```bash
twc jobs logs <jobId> --tail 200
```

Cancel a running or queued job:

```bash
twc jobs cancel <jobId>
```

Diagnose runtime + env:

```bash
twc doctor
```

Inspect current configuration:

```bash
twc config
```

Query the official-docs knowledge layer:

```bash
twc docs ask "which ports does teamviewer use"     # verified facts + cached docs
twc docs ask "how does Tensor SSO work" --live      # read the official page first
twc docs sources                                     # list official doc URLs
twc docs sync                                        # pre-fetch & cache for offline use
```

### Selecting an LLM model

A curated catalog of Foundry Local models is available — switch at any time, no rebuild needed:

```bash
twc models list                         # show catalog + currently active
twc models use deepseek-r1-7b           # accept alias or full Foundry id
twc models use qwen2.5-7b-instruct-generic-gpu:1
twc models current                      # print active id
twc models unset                        # clear persisted choice (falls back to env)
```

Inside the REPL:

```
twc › /models           # list catalog
twc › /model            # show active
twc › /model deepseek-r1-7b
```

One-shot override (does not persist if you also call `models unset` after):

```bash
twc -p "Session drops" --product teamviewer-remote --model deepseek-r1-7b
```

Priority: persisted choice (`models use` / `/model`) > `FOUNDRY_LOCAL_MODEL` env var. To install a model on the host: `foundry model run <id>`.

Run unit tests:

```bash
npm test
```

## Foundry Local-Only LLM Configuration

This project is configured for **local-only LLM execution**.

- Remote endpoints are disabled (`MASTRA_AGENT_ENDPOINT` must NOT be set).
- Heuristic fallback is disabled.
- Model config is **resolved lazily**: non-LLM commands (`products list`, `jobs list`, `doctor`, `config`) work even if Foundry Local is offline.
- Foundry Local endpoint is **auto-discovered** via `foundry service status` when `FOUNDRY_LOCAL_ENDPOINT` is not set.
- All LLM prompts are sanitized (control chars, role markers, length cap) to mitigate prompt injection.

Recommended environment variables:

```powershell
$env:FOUNDRY_LOCAL_ENDPOINT = "http://127.0.0.1:58991/v1"
$env:FOUNDRY_LOCAL_MODEL = "deepseek-r1-distill-qwen-7b-qnn-npu:2"
$env:FOUNDRY_LOCAL_API_KEY = "local-dev-key"
```

Use `twc doctor` to verify the runtime is reachable and the model is loaded.

Important constraints:

1. `MASTRA_AGENT_ENDPOINT` must not be set.
2. Local endpoint must be loopback-only (`localhost`, `127.0.0.1`, or `::1`).
3. If any of the required local settings are missing, the CLI exits with configuration errors.

## Implementation Based On Official Mastra Examples

This solution follows official patterns in Mastra docs/repo:

- Agents using `new Agent(...)` registered in `new Mastra(...)`
- Typed tools with `createTool(...)`
- Typed workflow with `createStep(...)`, `createWorkflow(...)`, `.commit()`
- Workflow execution with `createRun()` + `run.start()`

References used:

- https://mastra.ai/guides/getting-started/quickstart
- https://mastra.ai/docs/agents/overview
- https://mastra.ai/docs/workflows/overview
- https://github.com/mastra-ai/mastra (examples/templates: agent, agent-builder, weather-agent)

## Project Structure

```text
src/
  agents/
    formatReport.ts        # text + Markdown report renderers
    mastraAdapter.ts       # entry point used by the worker (local-only)
    profiles.ts            # logical agent role catalogue
    routing.ts             # issue bucket inference + agent selection
  catalog/
    teamviewerProducts.ts  # whitelist
  jobs/
    dispatch.ts            # detached worker spawn + per-job log redirect
    jobStore.ts            # atomic JSON store + retention + log paths
  mastra/
    agents/
      index.ts             # Mastra Agent definitions + lazy model resolver
    tools/
      specialistTools.ts   # createTool + deterministic baseline functions
    util/
      llmJson.ts           # tolerant JSON extractor + generateStructured()
      sanitize.ts           # prompt input sanitization
    workflows/
      teamviewerTroubleshootWorkflow.ts  # classify → parallel specialists → aggregate
    foundryLocal.ts        # endpoint discovery + /models probe + loopback guard
    index.ts               # Mastra instance (agents + workflow + logger)
    runtime.ts             # createRun + run.start wrapper
  cli.ts                   # commander definitions (subcommand mode)
  index.ts                 # bin entry (REPL / one-shot / commander dispatch / worker)
  oneShot.ts               # synchronous workflow runner with spinner
  paths.ts                 # .twc-data + logs paths
  repl.ts                  # interactive REPL + slash commands
  types.ts                 # shared types (AgentJob, WorkflowReport, …)
  ui.ts                    # ANSI colors + spinner + banner helpers
  worker.ts                # standalone worker entry (dev mode)
  workerCore.ts            # shared worker job execution
tests/
  routing.test.ts
  sanitizeAndJson.test.ts
  workflowHelpers.test.ts
docs/
  mastra-agent-prompts.md
launcher/                  # .NET single-file Windows launcher (twc.exe)
bin/                       # build output: twc.exe (+ twc.cmd / twc.ps1 shims)
dist/                      # tsc output (ESM, used at runtime)
dist-cjs/                  # optional CJS output (legacy)
.twc-data/
  jobs.json                # job store (last 200 jobs)
  logs/<jobId>.log         # per-job stdout/stderr
vitest.config.ts
tsconfig.json
package.json
```

## Recommended Hardening

- Encrypt sensitive data in `.twc-data`.
- Add retry/backoff + circuit breaker around `gatewayAgent.generate` (today only the JSON parser retries).
- OpenTelemetry tracing for job execution.
- RBAC for operator role.
- CLI package signing and distribution checksums.
- Migrate `.twc-data/jobs.json` to SQLite or JSONL when the operator volume grows.

## Production Hardening (already shipped)

| Concern | Mitigation |
|---|---|
| Background jobs never start when CLI runs outside repo root | Worker entrypoint resolved relative to the module (`import.meta.url`), not `process.cwd()` ([src/jobs/dispatch.ts](src/jobs/dispatch.ts)) |
| Split-brain data store across working dirs | Deterministic, cwd-independent dir: `TWC_HOME` > `~/.twc` > legacy `./.twc-data` (only if no `~/.twc` yet) ([src/paths.ts](src/paths.ts)) |
| Hanging LLM call | `Promise.race` workflow timeout (default 120 s, override `TWC_WORKFLOW_TIMEOUT_MS`) |
| Two CLIs writing jobs.json | Cross-process `mkdir` lock with 5 s timeout + stale-lock recovery |
| Orphaned worker on cancel (Windows) | `taskkill /PID … /T /F` via [src/jobs/killTree.ts](src/jobs/killTree.ts) |
| Accidental PII / secrets on disk | Email / IPv4 / JWT / bearer-token / `password=` / `api_key=` redaction in [src/jobs/redact.ts](src/jobs/redact.ts), applied at `addJob()` |
| Crash silently swallowed | Global `uncaughtException` / `unhandledRejection` handlers with stable exit code 70 |
| `.env` not found after global install | Autoload from CWD, `~/.twc/.env`, install dir and `TWC_HOME` ([src/runtime/bootstrap.ts](src/runtime/bootstrap.ts)); process env always wins. See [.env.example](.env.example) |
| `doctor` reports NOT READY despite configured model | `twc doctor` now reads the active model from config (`twc models use`), not just `FOUNDRY_LOCAL_MODEL` |
| Probe failure crashes a specialist branch | Baseline probe call is wrapped; errors become evidence, the branch still completes |
| Version drift | `--version` reads `package.json` at runtime |
| REPL ergonomics | Persisted history across sessions (`~/.twc/history`, last 500 entries) |
| Wrong-model picked at runtime | Explicit `models use` / `/model` wins over `FOUNDRY_LOCAL_MODEL` env |
