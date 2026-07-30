import { describe, expect, it } from "vitest";

import { assertCommandAllowed, evaluateCommand, type CommandRule } from "../src/index.js";

const executable = "/usr/bin/git";
const rules: readonly CommandRule[] = [
  { executable, argsPrefix: ["status"], decision: "allow" },
  { executable, argsPrefix: ["diff"], allowAdditionalArgs: true, decision: "approval" },
];

describe("命令权限默认拒绝", () => {
  it.each([
    ["developer", ["status"], "allow"],
    ["developer", ["diff", "--stat"], "approval"],
    ["developer", ["push"], "deny"],
    ["tester", ["status"], "allow"],
    ["reviewer", ["status"], "deny"],
    ["coordinator", ["status"], "deny"],
  ] as const)("%s 执行 git %s => %s", (role, args, decision) => {
    expect(evaluateCommand(role, { executable, args }, rules)).toBe(decision);
  });

  it("拒绝 shell 字符串式相对命令", () => {
    expect(() =>
      evaluateCommand("developer", { executable: "git", args: ["status"] }, rules),
    ).toThrowError(expect.objectContaining({ code: "COMMAND_POLICY_DENIED" }));
  });

  it("只有 allow 可以通过断言", () => {
    expect(() =>
      assertCommandAllowed("developer", { executable, args: ["status"] }, rules),
    ).not.toThrow();
    expect(() =>
      assertCommandAllowed("developer", { executable, args: ["diff"] }, rules),
    ).toThrowError(expect.objectContaining({ code: "COMMAND_POLICY_DENIED" }));
  });
});
