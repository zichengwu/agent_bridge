import { describe, expect, it } from "vitest";

import { ProviderStreamAuditor } from "../src/harness/provider-stream-audit.js";

describe("B-real 流式响应审计", () => {
  it("只提取 OpenAI 模型、usage 和终止原因", () => {
    const auditor = new ProviderStreamAuditor("openai");
    auditor.push(
      Buffer.from(
        'data: {"id":"req-openai","model":"deepseek-v4-pro","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n',
      ),
    );
    expect(auditor.finish()).toEqual({
      models: ["deepseek-v4-pro"],
      inputTokens: 11,
      outputTokens: 7,
      requestIds: ["req-openai"],
      terminalReasons: ["stop"],
      modelObserved: true,
      usageObserved: true,
    });
  });

  it("提取 Anthropic message_start 和 message_delta usage", () => {
    const auditor = new ProviderStreamAuditor("anthropic");
    auditor.push(
      Buffer.from(
        'data: {"type":"message_start","message":{"id":"req-anthropic","model":"deepseek-v4-pro","usage":{"input_tokens":13,"output_tokens":1}}}\n' +
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n',
      ),
    );
    expect(auditor.finish()).toEqual({
      models: ["deepseek-v4-pro"],
      inputTokens: 13,
      outputTokens: 9,
      requestIds: ["req-anthropic"],
      terminalReasons: ["end_turn"],
      modelObserved: true,
      usageObserved: true,
    });
  });
});
