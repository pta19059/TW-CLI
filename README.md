# TWC CLI (TeamViewer Command Line)

![TWC CLI interactive shell](docs/assets/banner.png)

**Local-first, AI-assisted CLI for diagnosing and troubleshooting TeamViewer.**
Five Mastra agents run on Foundry Local (on-device, no cloud) against real probe evidence —
connectivity, endpoint health, logs, auth/policy — and produce ranked root causes, remediation
steps, a confidence score and an escalation decision. Answers about TeamViewer features are
grounded against the official Knowledge Base via a local hybrid RAG index.

## Highlights

- **Local & private by design** — every LLM call is loopback-only Foundry Local. No telemetry,
  no cloud, no fallback.
- **Real probes, not canned data** — DNS / TCP `5938` / HTTPS, services & processes (Win/Linux/macOS),
  log clustering, optional TeamViewer Web API checks.
- **Grounded answers** — `docs ask` retrieves from a local LanceDB index of the official KB and
  verifies every sentence by embedding similarity.
- **Non-blocking jobs** — every `debug`/`troubleshoot` runs as a detached worker with persisted
  logs, structured reports and a cancellable PID tree.
- **Modern terminal UX** — REPL + one-shot + free-text natural language; slash commands;
  Markdown reports ready to paste into a ticket.

## Quick start

```powershell
npm install
npm run build

# Pick (or install) a local model — see "Selecting an LLM model" below
foundry model run qwen2.5-1.5b-instruct-generic-cpu:4
twc models use qwen2.5-1.5b-cpu

# Try it:
twc                                                # interactive REPL
twc "tensor session drops on vm-twc-demo"          # free-text troubleshoot
twc docs ask "which ports does teamviewer use"     # grounded answer from local KB
twc doctor                                         # verify Foundry Local is reachable
```

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
| `twc debug <product> --target <v> --issue "<text>" [--context <c>] [--wait]` | Run a background **debug** job |
| `twc troubleshoot <product> --target <v> --issue "<text>" [--context <c>] [--wait]` | Run a background **troubleshoot** job |
| `twc probe <target> [--port N] [--timeout ms] [--no-dns]` | Raw DNS + TCP connect probe (default port 5938 = TeamViewer daemon). No LLM. |
| `twc jobs list [--limit N]` | List recent background jobs |
| `twc jobs show [jobId] [--json\|--markdown]` | Show a job report (no id = last queued job) |
| `twc jobs logs [jobId] [--tail N]` | Tail a job's worker log (no id = last queued job) |
| `twc jobs cancel <jobId>` | Kill a running or queued job |
| `twc explain <jobId>` | Turn a job report into a plain-language narrative |
| `twc docs ask "<question>"` | Answer a TeamViewer question from official docs |
| `twc docs reindex` | Crawl the entire TeamViewer KB and rebuild the local index |
| `twc docs refresh` | Incrementally add only KB pages not already indexed |
| `twc docs index` | Show local index status (chunks, embeddings, model) |
| `twc docs map [--rebuild]` | Build/show the KB URL map used for live lookups |
| `twc docs sources` | List the official documentation sources |
| `twc docs sync` | Pre-fetch & cache all official docs for offline use |
| `twc models list\|use <id>\|current\|unset` | Manage the active Foundry Local model |
| `twc doctor` | Diagnose Foundry Local runtime, env vars and data dirs |
| `twc config` | Print the resolved configuration |

### Worked examples

```powershell
# Natural language — product (Tensor) and target (vm-twc-demo) are auto-detected:
twc "tensor session drops on vm-twc-demo after 5 minutes"

# One-shot troubleshoot, Markdown report for a ticket:
twc -p "Session drops after 5 minutes" --product teamviewer-remote --target endpoint-001 --markdown

# Background troubleshoot job, wait and print the result inline:
twc troubleshoot teamviewer-tensor --target tenant-acme --issue "Policy rollout not applied" --wait

# Inspect the last job without remembering its id:
twc jobs show               # last job
twc jobs show --markdown    # last job as Markdown
twc jobs logs --tail 100    # tail the last job's worker log

# Ask the local docs and explain a finished report:
twc docs ask "which ports does teamviewer use"
twc explain <jobId>
```

## Supported TeamViewer products

- TeamViewer Remote (`teamviewer-remote`)
- TeamViewer Tensor (`teamviewer-tensor`)
- TeamViewer Frontline (`teamviewer-frontline`)
- TeamViewer Assist AR (`teamviewer-assist-ar`)
- TeamViewer Remote Management (`teamviewer-remote-management`)
- TeamViewer DEX (`teamviewer-dex`)

The whitelist is defined in [src/catalog/teamviewerProducts.ts](src/catalog/teamviewerProducts.ts).
Each product has its own diagnostic profile (delivery model, probe targets, expected hosts) —
see [docs/PROBES.md](docs/PROBES.md) for the full per-product probe coverage table.

## TWC CLI vs TeamViewerPS

[TeamViewerPS](https://github.com/teamviewer/TeamViewerPS) is the official PowerShell module
from TeamViewer. It is an **administration / automation** wrapper around the TeamViewer Web API
(user management, policies, SSO, Computers & Contacts) plus a few local utility cmdlets.

TWC CLI solves a **different problem**: AI-assisted, local-first **diagnostics and root-cause
troubleshooting**. The two are complementary.

| Dimension | TeamViewerPS | **TWC CLI (this project)** |
| --- | --- | --- |
| Primary purpose | Administer/provision accounts via Web API | **Diagnose & troubleshoot** TeamViewer issues |
| Intelligence | None — returns raw API objects | **Local LLM + 5 Mastra agents** with ranked root causes |
| Output | PowerShell objects | **Structured Markdown reports** (evidence-anchored) |
| Real diagnostic probes | No | **Yes** — connectivity, endpoint health, auth/policy, log clustering |
| Network dependency | Requires TeamViewer Web API token + cloud calls | **Works offline** for most probes; inference is **loopback-only** |
| Privacy | Sends data to TeamViewer cloud API | **100% on-device** LLM + built-in secret/PII redaction |
| Execution model | Synchronous cmdlets | **Non-blocking job model** with detached workers and per-job logs |
| UX | Cmdlets only | **REPL + one-shot + free-text + slash commands** |

**When to use TeamViewerPS instead:** for *managing* a TeamViewer account — creating users,
assigning policies/roles, configuring SSO, syncing Computers & Contacts. TWC CLI does **not**
provision or mutate account state. A natural workflow is: **TeamViewerPS to administer**, then
**TWC CLI to diagnose** when something breaks.

## Knowledge & official docs

The agents are grounded against TeamViewer's **official documentation** so they answer
accurately instead of hallucinating. A local hybrid RAG index (LanceDB + on-device ONNX
embeddings) is built once via `twc docs reindex` and is then queried fully offline. `docs ask`
runs on Foundry Local with **per-sentence grounding verification** — unsupported sentences are
dropped and only the chunks that grounded a sentence appear in `Sources:`.

See **[docs/KNOWLEDGE.md](docs/KNOWLEDGE.md)** for the full pipeline (Jina ingestion, hybrid
retrieval, just-in-time fallback, grounding, tuning env vars).

## Architecture

Mastra is the **core orchestrator**. Every job flows through a multi-step Mastra workflow that
calls real Mastra agents in parallel against Foundry Local:

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

Each specialist step runs a deterministic baseline probe first (resilient to LLM failure), then
calls its Mastra Agent with a sanitized prompt and a narrow JSON contract, and merges the two.

For the full architecture (component diagram, no-fallback policy, runtime flow) see
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Azure demo

A reproducible end-to-end demo where the CLI runs on your laptop and diagnoses a TeamViewer
Host daemon running on an Azure Ubuntu VM. One PowerShell script provisions the VM, installs
TeamViewer headless via cloud-init, and enrolls it. See **[docs/AZURE-DEMO.md](docs/AZURE-DEMO.md)**.

## Setup

```bash
npm install
npm run build
cp .env.example .env   # then edit endpoint/model/token as needed
```

The CLI auto-loads `.env` from the current directory, `~/.twc/.env`, the install directory, or
`$TWC_HOME/.env`, so a global install still finds its config.

## Running from PowerShell

```powershell
# Global command (link the built CLI as `twc` on your PATH):
npm run build
npm run link:global
twc --help

# Windows .exe launcher (native, requires Node.js installed on the machine):
npm run build:exe
.\bin\twc.exe --help
```

If you run `twc.exe` outside the project root, set `TWC_HOME` to the project path (for example
`C:\TW CLI`).

**Icon mode (double-click):** double-clicking `bin\twc.exe` with no arguments opens a persistent
console with a `twc>` prompt and the TeamViewer startup animation. To create a desktop icon:

```powershell
.\create-desktop-shortcut.ps1
```

To run `twc` as a plain command from any folder, add `C:\TW CLI\bin` to the Windows `PATH`.

## Interactive REPL

Open the REPL with `twc` (or `twc chat --product <key>` to preset a product). Inside the REPL:

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
| `/model [id]` | show or switch the active model |
| `/models` | list the curated model catalog |
| `/clear`, `/help`, `/exit` | screen / help / leave |

### Natural-language input

You don't have to set flags. Describe the problem and the CLI infers the **product** and
**target** from your sentence (deterministic — no LLM required). Explicit `--product` /
`--target` always override the detection.

```powershell
twc "tensor cannot reach device vm-twc-demo"
# (detected product: TeamViewer Tensor; detected target: vm-twc-demo)
```

### Plain-language explanation

Turn any completed job's structured report into a phone-support-style narrative:

```powershell
twc explain <jobId>      # or  /explain <jobId>  inside the REPL
```

### Copy-paste remediation

When a fix maps to an OS-native command (e.g. a stopped service), the report includes a
ready-to-run **Suggested commands** block tailored to the host OS (`Start-Service` on Windows,
`systemctl enable --now` on Linux, `launchctl` on macOS).

## Selecting an LLM model

A curated catalog of Foundry Local models is available — switch at any time, no rebuild needed:

```powershell
twc models list                              # show catalog + currently active
twc models use qwen2.5-0.5b-cpu              # accept alias or full Foundry id
twc models use qwen2.5-7b-instruct-generic-gpu:1
twc models current                           # print active id
twc models unset                             # clear persisted choice (falls back to env)
```

Inside the REPL:

```
twc › /models
twc › /model
twc › /model qwen2.5-1.5b-cpu
```

One-shot override:

```powershell
twc -p "Session drops" --product teamviewer-remote --model qwen2.5-1.5b-cpu
```

Priority: persisted choice (`models use` / `/model`) > `FOUNDRY_LOCAL_MODEL` env var. To install
a model on the host: `foundry model run <id>`.

> **NPU note (Snapdragon / Copilot+ PCs):** on some Arm64 hosts the QNN/NPU execution provider
> stalls and `*-qnn-npu` chat models can hang indefinitely. If `docs ask` appears stuck, switch
> to a **CPU build** — `twc models use qwen2.5-0.5b-cpu` (tiny, ~2s/answer) or
> `twc models use qwen2.5-1.5b-cpu` (higher quality). CPU builds are NPU-independent and steady.

## Foundry Local-only LLM configuration

This project is configured for **local-only LLM execution**. Foundry Local is **free** and
runs entirely on your machine.

- Remote endpoints are disabled (`MASTRA_AGENT_ENDPOINT` must NOT be set).
- The Foundry Local endpoint must be loopback-only (`localhost`, `127.0.0.1`, or `::1`).
- The endpoint is **auto-discovered** via `foundry service status` when `FOUNDRY_LOCAL_ENDPOINT`
  is not set, so the dynamic port just works.
- Model config is **resolved lazily**: non-LLM commands (`products list`, `jobs list`, `doctor`,
  `config`) work even if Foundry Local is offline.
- All LLM prompts are sanitized (control chars, role markers, length cap) to mitigate prompt
  injection.

Recommended environment:

```powershell
# Leave FOUNDRY_LOCAL_ENDPOINT unset to auto-discover the (dynamic) port.
$env:FOUNDRY_LOCAL_MODEL = "qwen2.5-0.5b-instruct-generic-cpu:4"
$env:FOUNDRY_LOCAL_API_KEY = "local-dev-key"
```

Use `twc doctor` to verify the runtime is reachable and the model is loaded.

## Tests

```bash
npm test
```

## Further reading

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — full component / runtime architecture, no-fallback policy.
- **[docs/KNOWLEDGE.md](docs/KNOWLEDGE.md)** — RAG pipeline, grounding, `docs ask` internals.
- **[docs/PROBES.md](docs/PROBES.md)** — per-product diagnostic probe coverage.
- **[docs/AZURE-DEMO.md](docs/AZURE-DEMO.md)** — laptop ↔ Azure VM end-to-end demo.
- **[docs/HARDENING.md](docs/HARDENING.md)** — production hardening table + recommended next steps.
- **[docs/mastra-agent-prompts.md](docs/mastra-agent-prompts.md)** — the actual agent prompts.
