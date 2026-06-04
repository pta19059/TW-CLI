# Hardening

## Production hardening (already shipped)

| Concern | Mitigation |
|---|---|
| Background jobs never start when CLI runs outside repo root | Worker entrypoint resolved relative to the module (`import.meta.url`), not `process.cwd()` ([src/jobs/dispatch.ts](../src/jobs/dispatch.ts)) |
| Split-brain data store across working dirs | Deterministic, cwd-independent dir: `TWC_HOME` > `~/.twc` > legacy `./.twc-data` (only if no `~/.twc` yet) ([src/paths.ts](../src/paths.ts)) |
| Hanging LLM call | `Promise.race` workflow timeout (default 120 s, override `TWC_WORKFLOW_TIMEOUT_MS`) |
| Two CLIs writing jobs.json | Cross-process `mkdir` lock with 5 s timeout + stale-lock recovery |
| Orphaned worker on cancel (Windows) | `taskkill /PID … /T /F` via [src/jobs/killTree.ts](../src/jobs/killTree.ts) |
| Accidental PII / secrets on disk | Email / IPv4 / JWT / bearer-token / `password=` / `api_key=` redaction in [src/jobs/redact.ts](../src/jobs/redact.ts), applied at `addJob()` |
| Crash silently swallowed | Global `uncaughtException` / `unhandledRejection` handlers with stable exit code 70 |
| `.env` not found after global install | Autoload from CWD, `~/.twc/.env`, install dir and `TWC_HOME` ([src/runtime/bootstrap.ts](../src/runtime/bootstrap.ts)); process env always wins. See [.env.example](../.env.example) |
| `doctor` reports NOT READY despite configured model | `twc doctor` now reads the active model from config (`twc models use`), not just `FOUNDRY_LOCAL_MODEL` |
| Probe failure crashes a specialist branch | Baseline probe call is wrapped; errors become evidence, the branch still completes |
| Version drift | `--version` reads `package.json` at runtime |
| REPL ergonomics | Persisted history across sessions (`~/.twc/history`, last 500 entries) |
| Wrong-model picked at runtime | Explicit `models use` / `/model` wins over `FOUNDRY_LOCAL_MODEL` env |
| `docs ask` hangs for minutes on Snapdragon/NPU | Broken QNN/NPU provider stalls `*-qnn-npu` models; switch to a CPU build (`twc models use qwen2.5-0.5b-cpu`). If the inference queue is wedged, restart Foundry: `foundry service start` (a new dynamic port is auto-discovered) |
| Stale Foundry port after service restart | `FOUNDRY_LOCAL_ENDPOINT` left unset → endpoint auto-discovered from `foundry service status` (origin + `/v1`), so a new dynamic port just works |
| `docs ask` says "no endpoint is configured" only when launched from the **desktop icon** | The `foundry` command is a Windows *App Execution Alias* that does not resolve in the icon-launched child process. Discovery now also tries `foundry.exe` by absolute path and falls back to a last-known-good endpoint cached at `~/.twc/foundry-endpoint.json` (refreshed on every successful run from a terminal). [src/mastra/foundryLocal.ts](../src/mastra/foundryLocal.ts) |
| Small CPU model repeats the same sentence | Sentence-split + dedup in [src/knowledge/llmCompose.ts](../src/knowledge/llmCompose.ts) collapses looped output; `maxOutputTokens` bounded |

## Recommended next steps (not yet implemented)

- Encrypt sensitive data in `~/.twc/`.
- Add retry/backoff + circuit breaker around `gatewayAgent.generate` (today only the JSON parser
  retries).
- OpenTelemetry tracing for job execution.
- RBAC for operator role.
- CLI package signing and distribution checksums.
- Migrate `~/.twc/jobs.json` to SQLite or JSONL when the operator volume grows.
