import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "twc-test-"));
  prevHome = process.env.TWC_HOME;
  process.env.TWC_HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.TWC_HOME;
  else process.env.TWC_HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("userConfig + paths", () => {
  it("APP_DIR honors TWC_HOME and persists active model", async () => {
    // dynamic import so the modules pick up the patched env
    const paths = await import("../src/paths.js");
    const userConfig = await import("../src/userConfig.js");
    expect(path.resolve(paths.APP_DIR)).toBe(path.resolve(tmp));

    userConfig.setActiveModelId("phi-4-mini-instruct-generic-gpu:1");
    expect(existsSync(path.join(tmp, "config.json"))).toBe(true);
    const raw = JSON.parse(readFileSync(path.join(tmp, "config.json"), "utf-8"));
    expect(raw.activeModelId).toBe("phi-4-mini-instruct-generic-gpu:1");

    userConfig.setActiveModelId(undefined);
    const cleared = JSON.parse(readFileSync(path.join(tmp, "config.json"), "utf-8"));
    expect(cleared.activeModelId).toBeUndefined();
  });

  it("user config wins over env when present", async () => {
    const userConfig = await import("../src/userConfig.js");
    process.env.FOUNDRY_LOCAL_MODEL = "env-model";
    userConfig.setActiveModelId("explicit-model");
    expect(userConfig.getActiveModelId()).toBe("explicit-model");
    userConfig.setActiveModelId(undefined);
    expect(userConfig.getActiveModelId()).toBe("env-model");
    delete process.env.FOUNDRY_LOCAL_MODEL;
  });
});
