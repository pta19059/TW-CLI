import { describe, expect, it } from "vitest";
import { resolveModelId, findEntry, MODEL_CATALOG } from "../src/mastra/modelCatalog.js";

describe("modelCatalog", () => {
  it("catalog is non-empty and has unique aliases", () => {
    expect(MODEL_CATALOG.length).toBeGreaterThan(0);
    const aliases = new Set(MODEL_CATALOG.map((m) => m.alias));
    expect(aliases.size).toBe(MODEL_CATALOG.length);
  });

  it("resolveModelId accepts alias", () => {
    expect(resolveModelId("phi4-mini-gpu")).toBe("phi-4-mini-instruct-generic-gpu:1");
  });

  it("resolveModelId accepts full id verbatim", () => {
    expect(resolveModelId("phi-3-mini-4k-instruct-qnn-npu:3")).toBe("phi-3-mini-4k-instruct-qnn-npu:3");
  });

  it("resolveModelId accepts unknown but plausible Foundry ids", () => {
    expect(resolveModelId("custom-model-name-generic-gpu:7")).toBe("custom-model-name-generic-gpu:7");
  });

  it("resolveModelId rejects empty and non-id-shaped strings", () => {
    expect(resolveModelId("")).toBeUndefined();
    expect(resolveModelId("garbage")).toBeUndefined();
  });

  it("findEntry locates by id and alias", () => {
    expect(findEntry("phi4-mini-gpu")?.id).toBe("phi-4-mini-instruct-generic-gpu:1");
    expect(findEntry("phi-4-mini-instruct-generic-gpu:1")?.alias).toBe("phi4-mini-gpu");
    expect(findEntry("nonexistent")).toBeUndefined();
  });
});
