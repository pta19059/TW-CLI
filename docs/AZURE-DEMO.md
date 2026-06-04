# Azure Demo (laptop ↔ remote VM)

A short, **reproducible** demo. The reproduction scripts live in
[demo/azure](../demo/azure) so you can replay it even without the original Azure account — just
supply your own subscription and TeamViewer tokens.

## Architecture

```
┌─────────────────────────┐        TeamViewer WebAPI        ┌──────────────────────────┐
│  Your laptop            │  ───────────────────────────▶  │  Azure VM (Ubuntu 22.04) │
│  twc CLI (this repo)    │   GET /account, GET /devices    │  TeamViewer Host daemon  │
│  TEAMVIEWER_API_TOKEN   │  ◀───────────────────────────  │  enrolled via assignment │
└─────────────────────────┘    sees VM by name + state      └──────────────────────────┘
```

The CLI is **not** installed on the VM. It runs on your laptop and observes the remote VM
through the TeamViewer account: the VM enrolls as a managed device, and the `auth-policy`
specialist lists it by name and online/offline state. The `connectivity` specialist
independently validates reachability of the TeamViewer network endpoints from the laptop.

## Prerequisites

- A TeamViewer account.
- A **WebAPI script token** (Management Console → *Edit profile → Apps → Create script token*)
  with the **Account: read** and **Device groups / Computers & Contacts: read** scopes. Use it
  as `TEAMVIEWER_API_TOKEN`.
- An **assignment token** (Management Console → *Design & Deploy* or the *Assignment* tool) to
  enroll the VM into your account.
- Azure CLI logged in: `az login` (the demo uses resource group `TW` in `swedencentral` by
  default — change with script parameters).

## 1 — Deploy the remote VM (one command)

```powershell
cd demo/azure
./Deploy-TeamViewerDemo.ps1 -AssignmentToken "<assignment-token>"
```

This creates an Ubuntu `Standard_B2s` VM in RG `TW`, installs TeamViewer Host headless via
[cloud-init](../demo/azure/cloud-init.yaml), enables `teamviewerd`, and enrolls the device
(alias `vm-twc-demo`). Enrollment completes ~2–3 min after boot.

## 2 — Run the demo from your laptop

```powershell
cd "c:\TW CLI"
npm install; npm run build

$env:TEAMVIEWER_API_TOKEN = "<webapi-script-token>"

# Connectivity health from the laptop:
node dist/index.js doctor

# Full diagnosis that "sees" the remote VM by name:
node dist/index.js troubleshoot "VM unreachable" --product "TeamViewer Remote" --target vm-twc-demo
```

## Expected output

- **auth-policy**: `Authenticated as <you>`, `Managed devices: vm-twc-demo (online), …`, and
  `Target 'vm-twc-demo' matches managed device 'vm-twc-demo' — online`. If the VM is powered
  off, it instead reports it **offline** and raises a root cause + remediation.
- **connectivity**: resolves and reaches `router*.teamviewer.com` / `webapi` on TCP 5938 / 443.
- The aggregate report (`twc jobs show <jobId> --markdown`) merges these into a ranked
  root-cause + action list.

> The Foundry Local LLM layer is optional. Without it the deterministic probe-driven baseline
> still runs and produces the report.

## Cleanup

```powershell
az group delete --name TW --yes --no-wait
```
