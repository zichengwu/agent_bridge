import type { ServerResponse } from "node:http";

export type MockProtocol = "openai" | "anthropic";
export type MockScenario = "text" | "write" | "review" | "deny" | "cancel";

export interface MockResponseUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface MockProviderRequest {
  protocol: MockProtocol;
  model: string;
  scenario: MockScenario;
  requestIndex: number;
  body: Record<string, unknown>;
}

export function mockUsage(body: Record<string, unknown>, outputTokens = 12): MockResponseUsage {
  const serialized = JSON.stringify(body);
  return {
    inputTokens: Math.max(1, Math.ceil(serialized.length / 4)),
    outputTokens,
  };
}

export async function writeMockResponse(
  response: ServerResponse,
  request: MockProviderRequest,
  usage: MockResponseUsage,
): Promise<void> {
  if (request.scenario === "cancel") {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      response.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (response.destroyed) {
      return;
    }
  }

  if (request.protocol === "openai") {
    writeOpenAiResponse(response, request, usage);
  } else {
    writeAnthropicResponse(response, request, usage);
  }
}

function writeOpenAiResponse(
  response: ServerResponse,
  request: MockProviderRequest,
  usage: MockResponseUsage,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const id = "chatcmpl-agent-bridge-mock";
  const created = 1_700_000_000;
  const tool = selectTool(request.body, request.scenario, "openai", request.requestIndex);

  if (tool !== undefined) {
    sendOpenAiChunk(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_agent_bridge_mock",
                type: "function",
                function: { name: tool.name, arguments: JSON.stringify(tool.input) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    sendOpenAiChunk(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    });
  } else {
    sendOpenAiChunk(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: finalText(request.scenario) },
          finish_reason: null,
        },
      ],
    });
    sendOpenAiChunk(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    });
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

function writeAnthropicResponse(
  response: ServerResponse,
  request: MockProviderRequest,
  usage: MockResponseUsage,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const tool = selectTool(request.body, request.scenario, "anthropic", request.requestIndex);
  sendAnthropicEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: "msg_agent_bridge_mock",
      type: "message",
      role: "assistant",
      model: request.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.inputTokens, output_tokens: 0 },
    },
  });

  if (tool !== undefined) {
    sendAnthropicEvent(response, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_agent_bridge_mock",
        name: tool.name,
        input: {},
      },
    });
    sendAnthropicEvent(response, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
    });
    sendAnthropicEvent(response, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    sendAnthropicEvent(response, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: usage.outputTokens },
    });
  } else {
    const text = finalText(request.scenario);
    sendAnthropicEvent(response, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    sendAnthropicEvent(response, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });
    sendAnthropicEvent(response, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    sendAnthropicEvent(response, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.outputTokens },
    });
  }
  sendAnthropicEvent(response, "message_stop", { type: "message_stop" });
  response.end();
}

function selectTool(
  body: Record<string, unknown>,
  scenario: MockScenario,
  protocol: MockProtocol,
  requestIndex: number,
): { name: string; input: Record<string, unknown> } | undefined {
  if (scenario !== "write" && scenario !== "review" && scenario !== "deny") {
    return undefined;
  }
  const available = toolNames(body);
  const completedTools = requestIndex - 1;
  if (protocol === "anthropic" && scenario === "write" && requestIndex === 1) {
    const readName = available.find((candidate) => /^read$/i.test(candidate));
    return readName === undefined
      ? undefined
      : { name: readName, input: inputForTool(body, readName, "src/sum.ts", undefined) };
  }
  if (completedTools > (protocol === "anthropic" && scenario === "write" ? 1 : 0)) {
    return undefined;
  }
  if (scenario === "review") {
    if (completedTools > 0) return undefined;
    const name = available.find((candidate) => /read/i.test(candidate));
    return name === undefined
      ? undefined
      : { name, input: inputForTool(body, name, "src/sum.ts", undefined) };
  }
  if (scenario === "deny" && completedTools > 0) return undefined;
  const name = available.find((candidate) => /^(write|edit)$/i.test(candidate));
  const path = scenario === "deny" ? "../outside.txt" : "src/sum.ts";
  return name === undefined
    ? undefined
    : {
        name,
        input: inputForTool(body, name, path, "export const sum = (a, b) => a + b;\n"),
      };
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.flatMap((tool) => {
    if (typeof tool !== "object" || tool === null) return [];
    const item = tool as Record<string, unknown>;
    if (typeof item.name === "string") return [item.name];
    if (typeof item.function === "object" && item.function !== null) {
      const name = (item.function as Record<string, unknown>).name;
      return typeof name === "string" ? [name] : [];
    }
    return [];
  });
}

function inputForTool(
  body: Record<string, unknown>,
  name: string,
  path: string,
  content: string | undefined,
): Record<string, unknown> {
  const serialized = JSON.stringify(body.tools ?? []);
  const pathKey = serialized.includes('"filePath"')
    ? "filePath"
    : serialized.includes('"file_path"')
      ? "file_path"
      : "path";
  const result: Record<string, unknown> = { [pathKey]: path };
  if (content !== undefined) {
    if (/edit/i.test(name) && serialized.includes("oldString")) {
      result.oldString = "export const sum = (a, b) => a - b;";
      result.newString = content.trim();
    } else {
      result.content = content;
    }
  }
  return result;
}

function finalText(scenario: MockScenario): string {
  if (scenario === "review") {
    return '{"findings":[],"conclusion":"passed"}';
  }
  return "Agent Bridge local simulated Provider completed the scripted turn.";
}

function sendOpenAiChunk(response: ServerResponse, value: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function sendAnthropicEvent(
  response: ServerResponse,
  event: string,
  value: Record<string, unknown>,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}
