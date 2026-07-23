import { request } from "node:http";

import { describe, expect, it } from "vitest";

import {
  defaultGatewayLimits,
  startProviderGateway,
  type GatewayPolicy,
} from "../src/harness/provider-gateway.js";

const POLICY: GatewayPolicy = {
  candidate: "opencode",
  protocol: "openai",
  scenario: "text",
  syntheticToken: "synthetic-test-token",
  allowedPaths: ["/v1/chat/completions"],
  allowedModel: "deepseek-v4-pro",
  logicalUpstreamOrigin: "https://api.deepseek.com",
  limits: defaultGatewayLimits(),
};

describe("B 层本地 Provider 网关", () => {
  it("只接受合成 Token、白名单路径和模型并累计 usage", async () => {
    const gateway = await startProviderGateway(POLICY);
    try {
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${POLICY.syntheticToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: POLICY.allowedModel, messages: [] }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("[DONE]");
      expect(gateway.audit()).toMatchObject({
        requests: 1,
        realProviderRequests: 0,
        models: ["deepseek-v4-pro"],
        paths: ["/v1/chat/completions"],
      });
    } finally {
      await gateway.close();
    }
  });

  it("拒绝未知模型和缺失凭据", async () => {
    const gateway = await startProviderGateway(POLICY);
    try {
      const missingToken = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: POLICY.allowedModel }),
      });
      const wrongModel = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${POLICY.syntheticToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "other-model" }),
      });
      expect(missingToken.status).toBe(401);
      expect(wrongModel.status).toBe(403);
      expect(gateway.audit().requests).toBe(0);
      expect(gateway.audit().rejectedRequests).toBe(2);
      expect(gateway.audit().rejectedModels).toEqual(["other-model"]);
      expect(gateway.audit().rejectionReasons).toEqual([
        "synthetic_token_invalid",
        "model_not_allowed",
      ]);
    } finally {
      await gateway.close();
    }
  });

  it("达到请求上限后熔断", async () => {
    const gateway = await startProviderGateway({
      ...POLICY,
      limits: { ...defaultGatewayLimits(), maxRequests: 0 },
    });
    try {
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${POLICY.syntheticToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: POLICY.allowedModel }),
      });
      expect(response.status).toBe(429);
      expect(gateway.audit().circuitOpen).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("拒绝非白名单域名、Host、路径和过大请求体", async () => {
    await expect(
      startProviderGateway({
        ...POLICY,
        logicalUpstreamOrigin: "https://example.invalid" as "https://api.deepseek.com",
      }),
    ).rejects.toThrow("PROVIDER_DOMAIN_NOT_ALLOWED");

    const gateway = await startProviderGateway({
      ...POLICY,
      limits: { ...defaultGatewayLimits(), maxBodyBytes: 4 },
    });
    try {
      const wrongHostStatus = await requestStatus(gateway.url, "/v1/chat/completions", {
        host: "example.invalid",
        authorization: `Bearer ${POLICY.syntheticToken}`,
        "content-type": "application/json",
      });
      const wrongPath = await fetch(`${gateway.url}/v1/unknown`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${POLICY.syntheticToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      const tooLarge = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${POLICY.syntheticToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: POLICY.allowedModel }),
      });
      expect(wrongHostStatus).toBe(403);
      expect(wrongPath.status).toBe(404);
      expect(tooLarge.status).toBe(413);
      expect(gateway.audit().circuitOpen).toBe(true);
      expect(gateway.audit().rejectionReasons).toEqual([
        "host_not_allowed",
        "route_not_allowed",
        "invalid_request",
      ]);
    } finally {
      await gateway.close();
    }
  });
});

function requestStatus(
  origin: string,
  path: string,
  headers: Record<string, string>,
): Promise<number | undefined> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: "POST",
        headers,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    outgoing.once("error", reject);
    outgoing.end("{}");
  });
}
