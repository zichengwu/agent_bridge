import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "@agent-bridge/driver-protocol";
import { isDomainJsonValue, redactSensitiveContent } from "@agent-bridge/core";

import { BridgeControlService } from "./bridge-control-service.js";
import { BridgeControlError, classifyBridgeError } from "./errors.js";
import { BRIDGE_TOOLS } from "./tool-contracts.js";

export function createBridgeMcpServer(service: BridgeControlService): Server {
  const server = new Server(
    { name: "agent-bridge", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: [...BRIDGE_TOOLS] }),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as JsonObject;
    try {
      const result = await dispatch(service, name, args);
      await service.recordControlInvocation({
        tool_name: name,
        arguments: args,
        status: "succeeded",
      });
      return response(result, false);
    } catch (error) {
      const code = stableErrorCode(error);
      await service
        .recordControlInvocation({
          tool_name: name,
          arguments: args,
          status: "failed",
          error_code: code,
        })
        .catch(() => undefined);
      return response({ error: { code, details: safeErrorDetails(error) } }, true);
    }
  });
  return server;
}

export async function serveBridgeMcpStdio(service: BridgeControlService): Promise<Server> {
  const server = createBridgeMcpServer(service);
  await server.connect(new StdioServerTransport());
  return server;
}

async function dispatch(
  service: BridgeControlService,
  name: string,
  args: JsonObject,
): Promise<unknown> {
  switch (name) {
    case "bridge_create_task":
      return service.createTask(args);
    case "bridge_create_task_version":
      return service.createTaskVersion(args);
    case "bridge_link_task_versions":
      return service.linkTaskVersions(args);
    case "bridge_validate_task":
      return service.validateTask(args);
    case "bridge_prepare_context":
      return service.prepareContext(args);
    case "bridge_start_task":
      return service.startTask(args);
    case "bridge_get_task":
      return service.getTask(args);
    case "bridge_list_tasks":
      return service.listTasks(args);
    case "bridge_get_events":
      return service.getEvents(args);
    case "bridge_get_result":
      return service.getResult(args);
    case "bridge_list_handoffs":
      return service.listHandoffs(args);
    case "bridge_get_context_package":
      return service.getContextPackage(args);
    case "bridge_rollover_session":
      return service.rolloverSession(args);
    case "bridge_send_feedback":
      return service.sendFeedback(args);
    case "bridge_respond_to_approval":
      return service.respondToApproval(args);
    case "bridge_preview_run_action":
      return service.previewRunAction(args);
    case "bridge_confirm_run_action":
      return service.confirmRunAction(args);
    case "bridge_cancel_task":
      return service.cancelTask(args);
    case "bridge_mark_completed":
      return service.markCompleted(args);
    default:
      throw new BridgeControlError("TOOL_NOT_FOUND", "Unknown Agent Bridge tool", {
        tool_name: name,
      });
  }
}

function response(value: unknown, isError: boolean) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: serializableObject(value),
    ...(isError ? { isError: true } : {}),
  };
}

function serializableObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (JSON.parse(JSON.stringify(value)) as Record<string, unknown>)
    : { value: JSON.parse(JSON.stringify(value)) as unknown };
}

export function stableErrorCode(error: unknown): string {
  if (error instanceof BridgeControlError) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return "INTERNAL_ERROR";
}

export function safeErrorDetails(error: unknown): Readonly<Record<string, unknown>> {
  const code = stableErrorCode(error);
  const classification =
    error instanceof BridgeControlError
      ? { category: error.category, retryable: error.retryable }
      : classifyBridgeError(code);
  let details: unknown = {};
  if (error instanceof BridgeControlError) details = error.details;
  if (
    !(error instanceof BridgeControlError) &&
    typeof error === "object" &&
    error !== null &&
    "details" in error &&
    typeof error.details === "object" &&
    error.details !== null
  )
    details = error.details;
  const cloned = JSON.parse(JSON.stringify(details)) as unknown;
  const safeDetails = isDomainJsonValue(cloned) ? redactSensitiveContent(cloned) : {};
  return {
    category: classification.category,
    retryable: classification.retryable,
    ...(typeof safeDetails === "object" && safeDetails !== null && !Array.isArray(safeDetails)
      ? safeDetails
      : {}),
  };
}
