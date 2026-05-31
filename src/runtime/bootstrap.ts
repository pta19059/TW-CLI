// Process-level bootstrap: zero-dependency .env autoload and global
// uncaughtException / unhandledRejection handlers. Invoked once from
// the bin entry (src/index.ts) and from the worker entrypoints.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

let bootstrapped = false;

/** Minimal `.env` parser (KEY=VALUE, supports quotes and # comments). */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  try {
    const raw = readFileSync(file, "utf-8");
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Process env always wins so users can override per-shell.
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    /* never let a malformed .env file break the CLI */
  }
}

function attachGlobalHandlers(): void {
  process.on("uncaughtException", (err) => {
    // Print, but don't crash silently. Exit with a stable code so scripts can branch.
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`\n[twc] uncaught exception: ${message}\n`);
    process.exitCode = 70; // EX_SOFTWARE
  });

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    process.stderr.write(`\n[twc] unhandled rejection: ${message}\n`);
    process.exitCode = 70;
  });

  // Best-effort UTF-8 console on Windows so the banner/spinner glyphs render correctly.
  if (process.platform === "win32" && process.stdout.isTTY) {
    try {
      // chcp 65001 equivalent — most modern Windows Terminals already default to UTF-8.
      // We only set the encoding hint; we don't shell out.
      process.stdout.setDefaultEncoding?.("utf-8");
    } catch {
      /* noop */
    }
  }
}

/** Call once, very early. Idempotent. */
export function bootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  // Load .env from several locations so the CLI finds its config whether it is
  // run from the project root, installed globally (npm link), or driven from a
  // per-user data dir on a server/VM. First definition wins; process env always
  // overrides (handled inside loadDotEnv).
  const installDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const userHome = path.join(os.homedir(), ".twc");
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), ".env.local"),
    path.join(userHome, ".env"),
    path.join(installDir, ".env")
  ];
  if (process.env.TWC_HOME) {
    candidates.push(path.join(path.resolve(process.env.TWC_HOME), ".env"));
  }
  for (const file of candidates) {
    loadDotEnv(file);
  }
  attachGlobalHandlers();
}
