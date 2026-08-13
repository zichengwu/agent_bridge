import type { AuthoritativeDomainEvent } from "@agent-bridge/core";
import { describe, expect, it } from "vitest";

import { invalidatedResources } from "../../apps/bridge-mcp/dist/management-sse.js";

describe("Phase 4.2 Slice D management SSE security", () => {
  it("OPS-009/SSE-006 projects only safe resource identifiers from a hostile raw event", () => {
    const event = {
      event_id: "event-hostile",
      event_version: 1,
      event_type: "approval_request.status_changed",
      aggregate: { kind: "approval_request", id: "approval-1", revision: 9 },
      occurred_at: "2026-08-13T00:00:00.000Z",
      audit: {
        actor: { kind: "driver", id: "driver-fake" },
        operation: "hostile-test",
        request_id: "request-hostile",
        correlation_id: "correlation-hostile",
        idempotency_key: "idempotency-hostile",
        task_id: "task-1",
        run_id: "run-1",
        metadata: {
          cookie: "cookie-secret",
          csrf: "csrf-secret",
          stream_id: "stream-secret",
          confirmation_token: "confirmation-secret",
        },
      },
      payload: {
        launch_secret: "launch-secret",
        absolute_path: "/Users/alice/private",
        driver_payload: { transcript: "private transcript" },
      },
    } as unknown as AuthoritativeDomainEvent;

    const serialized = JSON.stringify(invalidatedResources(event));
    expect(JSON.parse(serialized)).toEqual(["dashboard", "task:task-1", "tasks"]);
    expect(serialized).not.toMatch(
      /cookie-secret|csrf-secret|stream-secret|confirmation-secret|launch-secret|\/Users\/alice|transcript/u,
    );
  });
});
