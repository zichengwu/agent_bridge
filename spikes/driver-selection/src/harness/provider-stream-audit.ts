import type { ProviderProtocol } from "./provider-policy.js";

export interface ProviderStreamEvidence {
  models: string[];
  inputTokens: number;
  outputTokens: number;
  requestIds: string[];
  terminalReasons: string[];
  modelObserved: boolean;
  usageObserved: boolean;
}

export class ProviderStreamAuditor {
  readonly #protocol: ProviderProtocol;
  readonly #evidence: ProviderStreamEvidence = {
    models: [],
    inputTokens: 0,
    outputTokens: 0,
    requestIds: [],
    terminalReasons: [],
    modelObserved: false,
    usageObserved: false,
  };
  #pending = "";

  constructor(protocol: ProviderProtocol) {
    this.#protocol = protocol;
  }

  push(chunk: Buffer): void {
    this.#pending += chunk.toString("utf8");
    const lines = this.#pending.split("\n");
    this.#pending = lines.pop() ?? "";
    for (const line of lines) this.#parseLine(line.trim());
  }

  finish(): ProviderStreamEvidence {
    if (this.#pending.trim() !== "") this.#parseLine(this.#pending.trim());
    return structuredClone(this.#evidence);
  }

  #parseLine(line: string): void {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (payload === "" || payload === "[DONE]" || !payload.startsWith("{")) return;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (this.#protocol === "openai") this.#parseOpenAi(value);
    else this.#parseAnthropic(value);
  }

  #parseOpenAi(value: Record<string, unknown>): void {
    this.#addString(this.#evidence.models, value.model);
    this.#evidence.modelObserved ||= typeof value.model === "string" && value.model !== "";
    this.#addString(this.#evidence.requestIds, value.id);
    const usage = asRecord(value.usage);
    this.#evidence.usageObserved ||= hasNumericUsage(usage, "prompt_tokens", "completion_tokens");
    this.#evidence.inputTokens = Math.max(
      this.#evidence.inputTokens,
      numberValue(usage?.prompt_tokens),
    );
    this.#evidence.outputTokens = Math.max(
      this.#evidence.outputTokens,
      numberValue(usage?.completion_tokens),
    );
    const choices = Array.isArray(value.choices) ? value.choices : [];
    for (const choice of choices) {
      this.#addString(this.#evidence.terminalReasons, asRecord(choice)?.finish_reason);
    }
  }

  #parseAnthropic(value: Record<string, unknown>): void {
    const message = asRecord(value.message);
    const model = value.model ?? message?.model;
    this.#addString(this.#evidence.models, model);
    this.#evidence.modelObserved ||= typeof model === "string" && model !== "";
    this.#addString(this.#evidence.requestIds, value.id ?? message?.id);
    const usage = asRecord(value.usage) ?? asRecord(message?.usage);
    this.#evidence.usageObserved ||=
      hasNumericUsage(usage, "input_tokens") || hasNumericUsage(usage, "output_tokens");
    this.#evidence.inputTokens = Math.max(
      this.#evidence.inputTokens,
      numberValue(usage?.input_tokens),
    );
    this.#evidence.outputTokens = Math.max(
      this.#evidence.outputTokens,
      numberValue(usage?.output_tokens),
    );
    const delta = asRecord(value.delta);
    this.#addString(this.#evidence.terminalReasons, value.stop_reason ?? delta?.stop_reason);
  }

  #addString(target: string[], value: unknown): void {
    if (typeof value === "string" && value !== "" && !target.includes(value)) target.push(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function hasNumericUsage(usage: Record<string, unknown> | undefined, ...fields: string[]): boolean {
  return fields.some((field) => {
    const value = usage?.[field];
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  });
}
