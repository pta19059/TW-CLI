// Persistent CLI configuration stored in `.twc-data/config.json`.
// Currently tracks the active model id selected via `models use` or `/model`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_DIR } from "./paths.js";

const CONFIG_PATH = join(APP_DIR, "config.json");

export interface UserConfig {
  activeModelId?: string;
}

export function loadUserConfig(): UserConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as UserConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveUserConfig(next: UserConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
}

export function setActiveModelId(id: string | undefined): void {
  const current = loadUserConfig();
  if (id) current.activeModelId = id;
  else delete current.activeModelId;
  saveUserConfig(current);
}

/**
 * Read the active model id with priority:
 *   1. persisted user config (`models use <id>` / `/model <id>` — explicit user choice)
 *   2. process.env.FOUNDRY_LOCAL_MODEL / MASTRA_MODEL (default from environment)
 *   3. undefined (caller decides what to do)
 */
export function getActiveModelId(): string | undefined {
  return loadUserConfig().activeModelId ?? process.env.FOUNDRY_LOCAL_MODEL ?? process.env.MASTRA_MODEL;
}
