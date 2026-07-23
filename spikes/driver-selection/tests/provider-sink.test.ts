import { describe, expect, it } from "vitest";

import { startProviderSink } from "../src/harness/provider-sink.js";

describe("driver-selection 本地 Provider sink", () => {
  it("只在 loopback 返回确定的 401", async () => {
    const sink = await startProviderSink();
    try {
      expect(new URL(sink.url).hostname).toBe("127.0.0.1");
      const response = await fetch(`${sink.url}/v1/messages`, { method: "POST" });
      expect(response.status).toBe(401);
      expect(sink.requestCount()).toBe(1);
    } finally {
      await sink.close();
    }
  });
});
