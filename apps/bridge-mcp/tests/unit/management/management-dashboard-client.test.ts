import { describe, expect, it } from "vitest";

import {
  createDashboardClientState,
  dashboardWritesAllowed,
  formatUsageUnits,
  mergeTaskCards,
  reduceDashboardClientState,
  type DashboardClientState,
  type DashboardTaskCard,
} from "../../../src/management-dashboard-assets/dashboard.d7edfe43.js";

const INSTANCE = "11111111-1111-4111-8111-111111111111";

describe("Slice E dashboard client reducer", () => {
  it("SSE-011/UX-008 断线、重连和 ready 后未追平时立即只读", () => {
    let state = currentState();
    expect(dashboardWritesAllowed(state)).toBe(true);

    state = reduceDashboardClientState(state, { type: "stream_disconnected" });
    expect(state.phase).toBe("reconnecting");
    expect(dashboardWritesAllowed(state)).toBe(false);

    state = reduceDashboardClientState(state, {
      type: "stream_ready",
      server_instance_id: INSTANCE,
      stream_id: "stream-2",
      head_cursor: "event-cursor:8",
    });
    expect(state.phase).toBe("syncing");
    expect(dashboardWritesAllowed(state)).toBe(false);
  });

  it("SSE-013 只有 dashboard、完整 tasks 和已打开详情都追平同一 head 才恢复写", () => {
    let state = createDashboardClientState();
    state = reduceDashboardClientState(state, {
      type: "session",
      server_instance_id: INSTANCE,
      event_cursor: "event-cursor:4",
    });
    state = reduceDashboardClientState(state, {
      type: "stream_ready",
      server_instance_id: INSTANCE,
      stream_id: "stream-1",
      head_cursor: "event-cursor:7",
    });
    state = reduceDashboardClientState(state, { type: "select_task", task_id: "task-1" });
    const generation = state.generation;

    state = snapshot(state, "dashboard", generation);
    expect(dashboardWritesAllowed(state)).toBe(false);
    state = snapshot(state, "tasks", generation);
    expect(dashboardWritesAllowed(state)).toBe(false);
    state = snapshot(state, "detail", generation);
    expect(state.phase).toBe("current");
    expect(dashboardWritesAllowed(state)).toBe(true);
  });

  it("READ-013 忽略旧 generation、拒绝错误实例，invalidate 后清空全部可写快照", () => {
    let state = currentState();
    const stale = reduceDashboardClientState(state, {
      type: "snapshot",
      kind: "dashboard",
      server_instance_id: INSTANCE,
      event_cursor: "event-cursor:7",
      generation: state.generation - 1,
    });
    expect(stale).toBe(state);

    state = reduceDashboardClientState(state, {
      type: "invalidate",
      server_instance_id: INSTANCE,
      head_cursor: "event-cursor:8",
    });
    expect(state.snapshots).toEqual({ dashboard: null, tasks: null, detail: null });
    expect(dashboardWritesAllowed(state)).toBe(false);

    state = reduceDashboardClientState(state, {
      type: "snapshot",
      kind: "dashboard",
      server_instance_id: "22222222-2222-4222-8222-222222222222",
      event_cursor: "event-cursor:8",
      generation: state.generation,
    });
    expect(state.phase).toBe("fatal");
    expect(state.stream_id).toBeNull();
  });

  it("SSE-013 reset 始终撤销 stream 与可写状态", () => {
    const state = reduceDashboardClientState(currentState(), {
      type: "reset",
      server_instance_id: INSTANCE,
      head_cursor: "event-cursor:9",
    });
    expect(state.phase).toBe("reset");
    expect(state.stream_id).toBeNull();
    expect(dashboardWritesAllowed(state)).toBe(false);
  });

  it("SSE-013 reset 实例变化时进入致命只读状态", () => {
    const state = reduceDashboardClientState(currentState(), {
      type: "reset",
      server_instance_id: "22222222-2222-4222-8222-222222222222",
      head_cursor: "event-cursor:9",
    });
    expect(state.phase).toBe("fatal");
    expect(dashboardWritesAllowed(state)).toBe(false);
  });

  it("UX-005 usage 缺失显示破折号且已上报值使用稳定短格式", () => {
    expect(formatUsageUnits(null)).toBe("—");
    expect(formatUsageUnits(0)).toBe("0");
    expect(formatUsageUnits(1_620)).toBe("1.6k");
    expect(formatUsageUnits(1_200_000)).toBe("1.2m");
  });

  it("READ-013 合并任务卡时 revision 不倒退", () => {
    const newer = taskCard(9, "新标题");
    const older = taskCard(8, "旧标题");
    expect(mergeTaskCards([newer], [older])).toEqual([newer]);
    expect(mergeTaskCards([older], [newer])).toEqual([newer]);
  });
});

function currentState(): DashboardClientState {
  let state = createDashboardClientState();
  state = reduceDashboardClientState(state, {
    type: "session",
    server_instance_id: INSTANCE,
    event_cursor: "event-cursor:7",
  });
  state = reduceDashboardClientState(state, {
    type: "stream_ready",
    server_instance_id: INSTANCE,
    stream_id: "stream-1",
    head_cursor: "event-cursor:7",
  });
  const generation = state.generation;
  state = snapshot(state, "dashboard", generation);
  state = snapshot(state, "tasks", generation);
  return state;
}

function snapshot(
  state: DashboardClientState,
  kind: "dashboard" | "tasks" | "detail",
  generation: number,
): DashboardClientState {
  return reduceDashboardClientState(state, {
    type: "snapshot",
    kind,
    server_instance_id: INSTANCE,
    event_cursor: state.head_cursor!,
    generation,
  });
}

function taskCard(revision: number, title: string): DashboardTaskCard {
  return {
    task_id: "task-1",
    run_id: "run-1",
    title,
    authoritative_status: "RUNNING",
    display_stage: "executing",
    current_step: "执行任务",
    wait_reason: null,
    elapsed_ms: 1_000,
    latest_event: null,
    revision,
    etag: `"task-task-1-r${revision}"`,
  };
}
