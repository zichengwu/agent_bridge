import { describe, expect, it } from "vitest";

import { createRequestOptions } from "../src/harness/real-provider-transport.js";

describe("B-real HTTPS 传输", () => {
  it("不透传候选认证并固定 DeepSeek TLS 目标", () => {
    const credential = Buffer.from("real-secret-value");
    const options = createRequestOptions({
      protocol: "anthropic",
      origin: "https://api.deepseek.com",
      path: "/anthropic/v1/messages",
      body: Buffer.from("{}"),
      credential,
      sourceHeaders: {
        authorization: "Bearer synthetic-token",
        "x-api-key": "synthetic-token",
        cookie: "private-cookie",
        "anthropic-version": "2023-06-01",
      },
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "api.deepseek.com",
      servername: "api.deepseek.com",
      path: "/anthropic/v1/messages",
    });
    expect(options.headers).toMatchObject({
      "x-api-key": "real-secret-value",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.stringify(options.headers)).not.toContain("synthetic-token");
    expect(JSON.stringify(options.headers)).not.toContain("private-cookie");
    credential.fill(0);
  });
});
