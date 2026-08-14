import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDashboardClientState,
  dashboardWritesAllowed,
  reduceDashboardClientState,
} from "../../apps/bridge-mcp/dist/management-dashboard-assets/dashboard.d7edfe43.js";
import { MANAGEMENT_DASHBOARD_STATIC_ROOT } from "../../apps/bridge-mcp/dist/management-static-manifest.js";

const INSTANCE = "11111111-1111-4111-8111-111111111111";

describe("Phase 4.2 Slice E no-Provider page acceptance", () => {
  it("UX-008/SSE-011/SSE-013 follows session → ready → consistent snapshots → writable", () => {
    let state = createDashboardClientState();
    state = reduceDashboardClientState(state, {
      type: "session",
      server_instance_id: INSTANCE,
      event_cursor: "event-cursor:10",
    });
    expect(dashboardWritesAllowed(state)).toBe(false);
    state = reduceDashboardClientState(state, {
      type: "stream_ready",
      server_instance_id: INSTANCE,
      stream_id: "stream-current",
      head_cursor: "event-cursor:12",
    });
    const generation = state.generation;
    state = reduceDashboardClientState(state, {
      type: "snapshot",
      kind: "dashboard",
      server_instance_id: INSTANCE,
      event_cursor: "event-cursor:12",
      generation,
    });
    state = reduceDashboardClientState(state, {
      type: "snapshot",
      kind: "tasks",
      server_instance_id: INSTANCE,
      event_cursor: "event-cursor:12",
      generation,
    });
    expect(dashboardWritesAllowed(state)).toBe(true);

    state = reduceDashboardClientState(state, { type: "select_task", task_id: "task-1" });
    expect(dashboardWritesAllowed(state)).toBe(false);
    state = reduceDashboardClientState(state, {
      type: "snapshot",
      kind: "dashboard",
      server_instance_id: INSTANCE,
      event_cursor: "event-cursor:12",
      generation: state.generation,
    });
    state = reduceDashboardClientState(state, {
      type: "snapshot",
      kind: "tasks",
      server_instance_id: INSTANCE,
      event_cursor: "event-cursor:12",
      generation: state.generation,
    });
    state = reduceDashboardClientState(state, {
      type: "snapshot",
      kind: "detail",
      server_instance_id: INSTANCE,
      event_cursor: "event-cursor:12",
      generation: state.generation,
    });
    expect(dashboardWritesAllowed(state)).toBe(true);

    state = reduceDashboardClientState(state, { type: "stream_disconnected" });
    expect(dashboardWritesAllowed(state)).toBe(false);
  });

  it("UX-006/007/009/010 client sends normal decisions directly, previews risky actions, and refreshes conflicts", async () => {
    const client = await readFile(
      resolve(MANAGEMENT_DASHBOARD_STATIC_ROOT, "dashboard.d7edfe43.js"),
      "utf8",
    );
    expect(client).toContain("/internal/v1/approvals/");
    expect(client).toContain("/preview");
    expect(client.indexOf("/preview")).toBeLessThan(
      client.indexOf("confirmation_token: preview.confirmation_token"),
    );
    expect(client).toContain("STALE_EVENT_CURSOR");
    expect(client).toContain("ETAG_MISMATCH");
    expect(client).toContain("CONFIRMATION_EXPIRED");
    expect(client).toContain("beginPostWriteSync");
  });

  it("UX-011/012 page has no Provider execution or task-creation transport", async () => {
    const client = await readFile(
      resolve(MANAGEMENT_DASHBOARD_STATIC_ROOT, "dashboard.d7edfe43.js"),
      "utf8",
    );
    expect(client).not.toMatch(/bridge_create_task|bridge_start_task|provider_key|api_key/u);
    expect(client).not.toMatch(/WebSocket|Worker\(|serviceWorker/u);
  });
});
