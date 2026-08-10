import { describe, expect, it, vi } from "vitest";

import type { OutboxDispatchResult } from "@agent-bridge/storage-sqlite";

import { OutboxPump } from "../src/outbox-pump.js";

describe("OutboxPump", () => {
  it("按顺序排空可发布项并在空队列停止本轮", async () => {
    const results: OutboxDispatchResult[] = [
      { outcome: "PUBLISHED", event_id: "event-1", attempt: 1 },
      { outcome: "PUBLISHED", event_id: "event-2", attempt: 2 },
      { outcome: "IDLE", reason: "EMPTY" },
    ];
    const dispatchNext = vi.fn(() => Promise.resolve(results.shift()!));
    const pump = new OutboxPump({ dispatchNext }, () => Promise.resolve());

    await pump.drain();

    expect(dispatchNext).toHaveBeenCalledTimes(3);
    await pump.stop();
  });

  it("失败或租约等待不会热循环", async () => {
    const dispatchNext = vi.fn(() =>
      Promise.resolve({
        outcome: "FAILED" as const,
        event_id: "event-1",
        attempt: 1,
        retry_at: "2026-08-07T00:00:01.000Z",
      }),
    );
    const pump = new OutboxPump({ dispatchNext }, () => Promise.resolve());

    await pump.drain();

    expect(dispatchNext).toHaveBeenCalledTimes(1);
    await pump.stop();
  });
});
