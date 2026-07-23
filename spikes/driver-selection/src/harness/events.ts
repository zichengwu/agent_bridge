import type { BLayerCandidateId, BLayerEvent, BLayerEventType } from "../contract.js";

export class EventRecorder {
  readonly #candidate: BLayerCandidateId;
  readonly #events: BLayerEvent[] = [];

  constructor(candidate: BLayerCandidateId) {
    this.#candidate = candidate;
  }

  record(type: BLayerEventType, detail: string, fields: Partial<BLayerEvent> = {}): BLayerEvent {
    const event: BLayerEvent = {
      sequence: this.#events.length + 1,
      type,
      candidate: this.#candidate,
      detail,
      ...fields,
    };
    this.#events.push(event);
    return event;
  }

  snapshot(): BLayerEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }
}
