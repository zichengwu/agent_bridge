import type { DomainJsonValue } from "@agent-bridge/schemas";

export type ObservabilityAttributes = Readonly<Record<string, DomainJsonValue>>;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface StructuredLogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly attributes: ObservabilityAttributes;
}

export interface StructuredLogSink {
  emit(entry: StructuredLogEntry): void;
}

export interface StructuredLogger {
  log(level: LogLevel, message: string, attributes?: ObservabilityAttributes): void;
}

export class SinkStructuredLogger implements StructuredLogger {
  constructor(
    private readonly sink: StructuredLogSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  log(level: LogLevel, message: string, attributes: ObservabilityAttributes = {}): void {
    if (!LOG_LEVELS.includes(level) || typeof message !== "string" || message.length === 0) {
      return;
    }
    try {
      this.sink.emit(
        Object.freeze({
          timestamp: this.now().toISOString(),
          level,
          message,
          attributes: Object.freeze({ ...attributes }),
        }),
      );
    } catch {
      // Diagnostics must never become a task-lifecycle dependency.
    }
  }
}

export interface TraceSpan {
  setAttribute(name: string, value: DomainJsonValue): void;
  recordError(code: string, attributes?: ObservabilityAttributes): void;
  end(attributes?: ObservabilityAttributes): void;
}

export interface Tracer {
  startSpan(name: string, attributes?: ObservabilityAttributes): TraceSpan;
}

const NOOP_SPAN: TraceSpan = Object.freeze({
  setAttribute: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
});

export const NOOP_LOGGER: StructuredLogger = Object.freeze({
  log: () => undefined,
});

export const NOOP_TRACER: Tracer = Object.freeze({
  startSpan: () => NOOP_SPAN,
});
