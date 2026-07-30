import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { readJsonLines } from "@agent-bridge/driver-protocol";

import { runClaudeAgentWorker } from "../src/worker-entry.js";

describe("Claude Agent stdio Worker 入口", () => {
  it("启动后先声明固定 host 身份且不触发 Provider", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end();

    await runClaudeAgentWorker({
      input,
      output,
      factory: { create: async () => Promise.reject(new Error("factory must not run")) },
    });
    output.end();

    const messages = [];
    for await (const message of readJsonLines(output)) {
      messages.push(message);
    }
    expect(messages).toMatchObject([{ kind: "ready", hostId: "claude-agent-worker" }]);
  });
});
