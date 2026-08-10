import { describe, expect, it } from "vitest";

import { redactSensitiveContent, scanSensitiveContent } from "@agent-bridge/core";

import { BridgeControlError } from "../../apps/bridge-mcp/dist/errors.js";
import { safeErrorDetails } from "../../apps/bridge-mcp/dist/server.js";

describe("Phase 4 全链路脱敏与稳定错误边界", () => {
  it("领域持久化前移除凭据字段、完整 transcript 和字符串 Token", () => {
    const safe = redactSensitiveContent({
      authorization: "Bearer abcdefghijklmnop",
      messages: [{ content: "private" }],
      nested: "sk-abcdefghijklmnop",
    });

    expect(scanSensitiveContent(safe)).toEqual([]);
    expect(JSON.stringify(safe)).not.toContain("abcdefghijklmnop");
    expect(safe).toEqual({ nested: "[REDACTED]", redacted_fields: ["authorization", "messages"] });
  });

  it("MCP 错误只暴露稳定分类、重试性和脱敏详情", () => {
    const details = safeErrorDetails(
      new BridgeControlError("LEASE_CONFLICT", "unsafe internal message", {
        api_key: "sk-abcdefghijklmnop",
        resource: "worktree-1",
      }),
    );

    expect(details).toEqual({
      category: "RECOVERY",
      retryable: false,
      resource: "worktree-1",
      redacted_fields: ["api_key"],
    });
    expect(JSON.stringify(details)).not.toContain("abcdefghijklmnop");
  });

  it("只有明确瞬态错误可自动建议重试", () => {
    expect(safeErrorDetails({ code: "DRIVER_TRANSPORT_UNAVAILABLE", details: {} })).toEqual({
      category: "TRANSIENT",
      retryable: true,
    });
    expect(safeErrorDetails({ code: "IDEMPOTENCY_CONFLICT", details: {} })).toEqual({
      category: "CONFLICT",
      retryable: false,
    });
  });
});
