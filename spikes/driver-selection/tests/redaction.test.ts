import { describe, expect, it } from "vitest";

import { redactText } from "../src/harness/redaction.js";

describe("driver-selection 日志脱敏", () => {
  it("脱敏常见凭据、Bearer token 和隔离路径", () => {
    const privatePath = "/private/tmp/agent-bridge-secret-home";
    const input = [
      "sk-ant-api03-abcdefghijklmnop",
      "sk-proj-abcdefghijklmnop",
      "AIzaabcdefghijklmnop",
      "Bearer header.payload.signature",
      "api_key=canary-secret-value",
      privatePath,
    ].join(" ");

    const result = redactText(
      `${input} x-api-key: synthetic-secret`,
      [privatePath],
      ["synthetic-secret"],
    );

    expect(result).not.toContain("abcdefghijklmnop");
    expect(result).not.toContain("canary-secret-value");
    expect(result).not.toContain(privatePath);
    expect(result).not.toContain("synthetic-secret");
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("[ISOLATED_PATH]");
  });
});
