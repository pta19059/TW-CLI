import { describe, expect, it } from "vitest";
import { redactSensitive, redactJobInput } from "../src/jobs/redact.js";

describe("redactSensitive", () => {
  it("redacts email addresses", () => {
    expect(redactSensitive("contact admin@example.com today")).toContain("[REDACTED_EMAIL]");
  });

  it("redacts IPv4 addresses", () => {
    expect(redactSensitive("server at 192.168.1.42 is down")).toContain("[REDACTED_IP]");
  });

  it("redacts bearer-like tokens", () => {
    const out = redactSensitive("Authorization: Bearer ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456");
    expect(out).toContain("[REDACTED_TOKEN]");
  });

  it("redacts JWT-like tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.signature_part_here";
    expect(redactSensitive(`token=${jwt}`)).toContain("[REDACTED_JWT]");
  });

  it("redacts inline password=value", () => {
    expect(redactSensitive('password="hunter2"')).toContain("[REDACTED]");
    expect(redactSensitive("api_key=abcdef")).toContain("[REDACTED]");
  });

  it("returns undefined for undefined input", () => {
    expect(redactSensitive(undefined)).toBeUndefined();
  });

  it("leaves benign text unchanged", () => {
    expect(redactSensitive("Session drops every 5 minutes")).toBe("Session drops every 5 minutes");
  });
});

describe("redactJobInput", () => {
  it("redacts all three string fields", () => {
    const input = {
      target: "endpoint admin@corp.com",
      issue: "fails at 10.0.0.5",
      context: "token=sk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456"
    };
    const out = redactJobInput(input);
    expect(out.target).toContain("[REDACTED_EMAIL]");
    expect(out.issue).toContain("[REDACTED_IP]");
    expect(out.context).toContain("[REDACTED");
  });

  it("preserves missing context as undefined", () => {
    const out = redactJobInput({ target: "x", issue: "y" });
    expect(out.context).toBeUndefined();
  });
});
