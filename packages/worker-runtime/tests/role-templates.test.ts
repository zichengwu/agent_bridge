import { describe, expect, it } from "vitest";

import type { AgentRole } from "@agent-bridge/schemas";

import { assertRoleCanWritePath, evaluateRoleTool, getRoleTemplate } from "../src/index.js";

describe("固定角色模板", () => {
  it.each([
    ["coordinator", "deny", []],
    ["developer", "allow", ["product", "test", "docs"]],
    ["tester", "allow", ["test"]],
    ["reviewer", "deny", []],
    ["docs", "allow", ["docs"]],
    ["research", "deny", []],
  ] as const)("%s 的写权限与路径类别固定", (role, writeDecision, writableKinds) => {
    expect(evaluateRoleTool(role, "filesystem.write")).toBe(writeDecision);
    expect(getRoleTemplate(role).writablePathKinds).toEqual(writableKinds);
  });

  it.each([
    ["coordinator", "product"],
    ["reviewer", "test"],
    ["tester", "product"],
    ["docs", "product"],
    ["research", "docs"],
  ] as const)("%s 默认拒绝写入 %s", (role, kind) => {
    expect(() => assertRoleCanWritePath(role, kind)).toThrowError(
      expect.objectContaining({ code: "ROLE_POLICY_DENIED" }),
    );
  });

  it("未知角色返回稳定错误", () => {
    expect(() => getRoleTemplate("operator" as AgentRole)).toThrowError(
      expect.objectContaining({ code: "ROLE_TEMPLATE_INVALID" }),
    );
  });
});
