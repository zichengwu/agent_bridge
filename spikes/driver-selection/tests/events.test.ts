import { describe, expect, it } from "vitest";

import { EventRecorder } from "../src/harness/events.js";

describe("B 层结构化事件", () => {
  it("生成单调序号且返回副本", () => {
    const recorder = new EventRecorder("opencode");
    recorder.record("run.started", "start");
    recorder.record("permission.waiting", "wait");
    const first = recorder.snapshot();
    first[0]!.detail = "changed";

    expect(recorder.snapshot()).toEqual([
      expect.objectContaining({ sequence: 1, detail: "start" }),
      expect.objectContaining({ sequence: 2, detail: "wait" }),
    ]);
  });
});
