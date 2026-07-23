import { describe, expect, it } from "vitest";

import { realGatewayPolicy } from "../src/harness/provider-policy.js";
import { startRealProviderGatewayCore } from "../src/harness/real-provider-gateway-core.js";
import { startRealProviderGateway } from "../src/harness/real-provider-gateway.js";
import type {
  UpstreamRequest,
  UpstreamResponse,
  UpstreamTransport,
} from "../src/harness/real-provider-transport.js";

class FakeTransport implements UpstreamTransport {
  request?: UpstreamRequest;
  readonly statusCode: number;
  readonly responseBody: Buffer;

  constructor(
    statusCode = 200,
    responseBody = 'data: {"id":"req-local","model":"deepseek-v4-pro","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
  ) {
    this.statusCode = statusCode;
    this.responseBody = Buffer.from(responseBody);
  }

  send(request: UpstreamRequest): Promise<UpstreamResponse> {
    this.request = request;
    return Promise.resolve({
      statusCode: this.statusCode,
      headers: { "content-type": "text/event-stream" },
      body: Readable.from([this.responseBody]),
      destroy: () => undefined,
    });
  }
}

describe("B-real 本地网关", () => {
  it("仅把白名单请求转给注入式传输并记录真实 usage", async () => {
    const transport = new FakeTransport();
    const credential = Buffer.from("temporary-real-key");
    const policy = realGatewayPolicy("opencode", "synthetic-real-token");
    const gateway = await startRealProviderGatewayCore({ policy, credential, transport });
    try {
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${policy.syntheticToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "local fixture" }],
          stream: true,
          max_tokens: 99_999,
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("[DONE]");
      expect(JSON.parse(transport.request!.body.toString("utf8"))).toMatchObject({
        model: "deepseek-v4-pro",
        max_tokens: 2_048,
        stream_options: { include_usage: true },
      });
      expect(gateway.audit()).toMatchObject({
        realProviderRequests: 1,
        inputTokens: 20,
        outputTokens: 5,
        models: ["deepseek-v4-pro"],
        circuitOpen: false,
      });
    } finally {
      credential.fill(0);
      await gateway.close();
    }
  });

  it("未知模型在传输调用前失败", async () => {
    const transport = new FakeTransport();
    const gateway = await startRealProviderGatewayCore({
      policy: realGatewayPolicy("opencode", "synthetic-real-token"),
      credential: Buffer.from("temporary-real-key"),
      transport,
    });
    try {
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-real-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
      });
      expect(response.status).toBe(502);
      expect(transport.request).toBeUndefined();
      expect(gateway.audit().circuitOpen).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("网关子进程通过独立凭据管道启动并在无请求时退出", async () => {
    const credential = Buffer.from("temporary-child-key");
    const gateway = await startRealProviderGateway({
      policy: realGatewayPolicy("opencode", "synthetic-child-token"),
      credential,
    });
    credential.fill(0);
    const audit = await gateway.close();
    expect(audit).toMatchObject({ realProviderRequests: 0, requests: 0 });
  });

  it("在调用传输前执行请求预算熔断", async () => {
    const transport = new FakeTransport();
    const policy = realGatewayPolicy("opencode", "synthetic-budget-token");
    policy.limits = { ...policy.limits, maxRequests: 0 };
    const gateway = await startRealProviderGatewayCore({
      policy,
      credential: Buffer.from("temporary-budget-key"),
      transport,
    });
    try {
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-budget-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "deepseek-v4-pro", messages: [] }),
      });
      expect(response.status).toBe(429);
      expect(transport.request).toBeUndefined();
      expect(gateway.audit().circuitOpen).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("拒绝上游重定向并熔断", async () => {
    const transport = new FakeTransport(302);
    const gateway = await startRealProviderGatewayCore({
      policy: realGatewayPolicy("opencode", "synthetic-redirect-token"),
      credential: Buffer.from("temporary-redirect-key"),
      transport,
    });
    try {
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-redirect-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "deepseek-v4-pro", messages: [] }),
      });
      expect(response.status).toBe(502);
      expect(gateway.audit()).toMatchObject({
        realProviderRequests: 1,
        circuitOpen: true,
        statusCodes: [302],
      });
    } finally {
      await gateway.close();
    }
  });

  it("成功响应缺少 usage 时熔断，防止报告误通过", async () => {
    const transport = new FakeTransport(
      200,
      'data: {"id":"req-local","model":"deepseek-v4-pro","choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    const gateway = await startRealProviderGatewayCore({
      policy: realGatewayPolicy("opencode", "synthetic-usage-token"),
      credential: Buffer.from("temporary-usage-key"),
      transport,
    });
    try {
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-usage-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "deepseek-v4-pro", messages: [] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(gateway.audit()).toMatchObject({
        circuitOpen: true,
        errorClasses: ["usage_missing"],
      });
    } finally {
      await gateway.close();
    }
  });

  it("成功响应缺少模型证据时熔断，防止映射未知", async () => {
    const transport = new FakeTransport(
      200,
      'data: {"id":"req-local","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
    );
    const gateway = await startRealProviderGatewayCore({
      policy: realGatewayPolicy("opencode", "synthetic-model-token"),
      credential: Buffer.from("temporary-model-key"),
      transport,
    });
    try {
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-model-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "deepseek-v4-pro", messages: [] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(gateway.audit()).toMatchObject({
        circuitOpen: true,
        errorClasses: ["response_model_missing"],
      });
    } finally {
      await gateway.close();
    }
  });
});
import { Readable } from "node:stream";
