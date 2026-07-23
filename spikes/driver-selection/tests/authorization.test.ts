import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import {
  AUTHORIZATION_VALUE,
  readSecretsFromTty,
  validateCredentialSet,
  validateAuthorizationPreconditions,
} from "../src/harness/authorization.js";

describe("B 层真实调用授权门禁", () => {
  it("缺少显式授权时失败关闭", () => {
    expect(() =>
      validateAuthorizationPreconditions({
        stdinIsTTY: true,
        stderrIsTTY: true,
      }),
    ).toThrow("B_LAYER_AUTHORIZED_REQUIRED");
  });

  it("非 TTY 即使有授权值也失败关闭", () => {
    expect(() =>
      validateAuthorizationPreconditions({
        authorizedValue: AUTHORIZATION_VALUE,
        stdinIsTTY: false,
        stderrIsTTY: true,
      }),
    ).toThrow("B_LAYER_TTY_REQUIRED");
  });

  it("协作命令要求两个不同的临时 Key", () => {
    const first = Buffer.from("temporary-key-one");
    const second = Buffer.from("temporary-key-two");
    expect(() => validateCredentialSet([first, second], 2)).not.toThrow();
    expect(() => validateCredentialSet([first, Buffer.from(first)], 2)).toThrow(
      "B_LAYER_DISTINCT_CREDENTIALS_REQUIRED",
    );
    expect(() => validateCredentialSet([first], 2)).toThrow("B_LAYER_CREDENTIAL_COUNT_INVALID");
    first.fill(0);
    second.fill(0);
  });

  it("连续读取两个不回显 Key 时不会销毁同一个 TTY 输入流", async () => {
    const input = new PassThrough();
    const unref = vi.fn();
    Object.assign(input, { unref });
    const output = new PassThrough();

    const credentialsRead = readSecretsFromTty(input, output, ["first: ", "second: "]);
    input.write("temporary-key-one\r\ntemporary-key-two\r");
    const [first, second] = await credentialsRead;

    expect(first?.toString()).toBe("temporary-key-one");
    expect(second?.toString()).toBe("temporary-key-two");
    expect(input.destroyed).toBe(false);
    expect(unref).toHaveBeenCalledOnce();

    first?.fill(0);
    second?.fill(0);
    input.destroy();
    output.destroy();
  });
});
