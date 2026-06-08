import { describe, expect, it } from "vitest";
import { createExecutionContext, LocalContext } from "../src/runtime/execContext.js";

describe("createExecutionContext", () => {
  it("returns LocalContext for explicit local markers", async () => {
    for (const target of ["local-device", "localhost", "127.0.0.1", "::1", ""]) {
      const ctx = await createExecutionContext({ target });
      expect(ctx).toBeInstanceOf(LocalContext);
      expect(ctx.kind).toBe("local");
    }
  });

  it("returns LocalContext for symbolic labels without --user", async () => {
    const ctx = await createExecutionContext({ target: "vm-twc-demo" });
    expect(ctx.kind).toBe("local");
  });

  it("rejects malformed azure-vm URLs", async () => {
    await expect(createExecutionContext({ target: "azure-vm://justonefield" })).rejects.toThrow(
      /Invalid azure-vm target/
    );
  });

  it("rejects malformed k8s URLs", async () => {
    await expect(createExecutionContext({ target: "k8s://only-namespace" })).rejects.toThrow(
      /Invalid k8s target/
    );
  });

  it("rejects ssh:// without a user", async () => {
    await expect(createExecutionContext({ target: "ssh://example.internal" })).rejects.toThrow(
      /missing a username/
    );
  });

  it("rejects a remote-looking bare target without --user", async () => {
    await expect(createExecutionContext({ target: "10.0.0.5" })).rejects.toThrow(/--user/);
  });
});
