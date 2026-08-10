import process from "node:process";

import { runStdioDriverHost } from "@agent-bridge/driver-protocol";
import { OpenCodeDriver } from "../../../packages/driver-opencode/dist/index.js";

class NoCredentialOpenCodeRuntime {
  version = "1.18.3";
  subscriptions = new Set();

  async healthCheck() {
    return { healthy: true, version: this.version };
  }

  async createSession() {
    return { id: "session-e2e" };
  }

  async getSession(sessionId) {
    return { id: sessionId };
  }

  async subscribe(_directory, signal) {
    const queue = new EventQueue();
    this.subscriptions.add(queue);
    signal.addEventListener(
      "abort",
      () => {
        queue.close();
        this.subscriptions.delete(queue);
      },
      { once: true },
    );
    return queue.stream();
  }

  async prompt(sessionId) {
    for (const queue of this.subscriptions) {
      queue.push({
        type: "text",
        sessionId,
        messageId: "message-e2e",
        partId: "part-e2e",
        text: "partial change preserved",
        delta: "partial change preserved",
      });
    }
  }

  async respondToPermission() {}

  async abortSession() {
    return true;
  }

  async close() {
    for (const queue of this.subscriptions) queue.close();
    this.subscriptions.clear();
  }
}

class EventQueue {
  closed = false;
  events = [];
  listeners = new Set();

  push(event) {
    this.events.push(event);
    this.notify();
  }

  close() {
    this.closed = true;
    this.notify();
  }

  async *stream() {
    let cursor = 0;
    while (true) {
      while (cursor < this.events.length) yield this.events[cursor++];
      if (this.closed) return;
      await new Promise((resolve) => this.listeners.add(resolve));
    }
  }

  notify() {
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

await runStdioDriverHost({
  hostId: "recoverable-opencode-e2e-worker",
  input: process.stdin,
  output: process.stdout,
  factory: {
    create: async (initialization) =>
      new OpenCodeDriver(new NoCredentialOpenCodeRuntime(), {
        workDirectory: initialization.workDirectory,
        recoveryStates: initialization.recoveryStates ?? [],
        createRunId: () => "external-run-e2e",
      }),
  },
});
