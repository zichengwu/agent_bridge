import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  DRIVER_PROTOCOL_VERSION,
  assertAgentEvent,
  assertAgentEventSequence,
  type AgentEvent,
  type AgentResult,
  type PermissionRequestedEvent,
} from "@agent-bridge/driver-protocol";

import {
  createClaudeAgentDriver,
  type ClaudeAgentDriver,
  type ClaudeAgentDriverRecoveryState,
} from "../src/driver.js";
import {
  applyReviewHandoff,
  buggyClaudeSumSource,
  collectClaudeFormalGitEvidence,
  createClaudeFormalGitFixture,
  fixedClaudeSumSource,
  snapshotClaudeWorktree,
  type ClaudeFormalGitEvidence,
  type ClaudeWorktreeSnapshot,
} from "./fixtures/b-simulated/git-fixture.js";
import {
  DescendantProcessTracker,
  assertRootRemoved,
  createIsolatedClaudeEnvironment,
  isolatedProcessEnvironment,
  replaceProcessEnvironment,
  safeError,
  type IsolatedClaudeEnvironment,
} from "./fixtures/b-simulated/isolation.js";
import {
  startClaudeFormalMockProvider,
  type ClaudeFormalMockProvider,
  type ClaudeFormalProviderAudit,
  type ClaudeFormalProviderScenario,
} from "./fixtures/b-simulated/mock-provider.js";

interface ScenarioEvidence {
  readonly scenario: ClaudeFormalProviderScenario;
  readonly runId: string;
  readonly sessionId: string;
  readonly eventTypes: readonly AgentEvent["type"][];
  readonly events: readonly AgentEvent[];
  readonly result: AgentResult;
  readonly git: ClaudeFormalGitEvidence;
  readonly provider: ClaudeFormalProviderAudit;
  readonly permissionDecisions: readonly ("allow" | "deny")[];
  readonly permissionWaitHadNoSideEffect: boolean;
  readonly reviewReadOnly: boolean;
  readonly postCancelSideEffects: number;
  readonly resumedSameSession: boolean;
  readonly credentialsRead: false;
  readonly realProviderRequests: 0;
  readonly costUsd: 0;
  residualProcessCount: number;
  temporaryRootRemoved: boolean;
}

describe.sequential("ClaudeAgentDriver 0.3.215 / Claude Code 2.1.215 正式 B-simulated 回归", () => {
  it("通过正式 Driver 连续两次完成允许写入、统一事件、用量、结果和 Git 白名单验证", async () => {
    const first = await runFormalClaudeScenario("write", "run-claude-write-1");
    const second = await runFormalClaudeScenario("write", "run-claude-write-2");

    for (const evidence of [first, second]) {
      expect(evidence.provider.requests).toBe(3);
      expect(evidence.eventTypes).toContain("output.delta");
      expect(evidence.eventTypes).toContain("permission.requested");
      expect(evidence.eventTypes).toContain("permission.responded");
      expect(evidence.result.status).toBe("succeeded");
      expect(evidence.result.output.text).toContain("completed safely");
      expect(evidence.result.usage?.inputTokens).toBeGreaterThan(0);
      expect(evidence.result.usage?.outputTokens).toBeGreaterThan(0);
      expect(evidence.git.changedFiles).toEqual(["src/sum.ts"]);
      expect(evidence.git.verificationExitCode).toBe(0);
      expect(evidence.permissionDecisions).toEqual(["allow", "allow"]);
      expect(evidence.permissionWaitHadNoSideEffect).toBe(true);
      assertProviderBoundary(evidence.provider);
      assertSafetyClosure(evidence);
    }

    expect(second.eventTypes).toEqual(first.eventTypes);
    expect(second.provider.requests).toBe(first.provider.requests);
    expect(second.result.status).toBe(first.result.status);
  }, 120_000);

  it("在独立 claude-review worktree 只读复核 Handoff patch", async () => {
    const evidence = await runFormalClaudeScenario("review", "run-claude-review");

    expect(evidence.provider.requests).toBe(2);
    expect(evidence.permissionDecisions).toEqual(["allow"]);
    expect(evidence.permissionWaitHadNoSideEffect).toBe(true);
    expect(evidence.reviewReadOnly).toBe(true);
    expect(evidence.result.status).toBe("succeeded");
    expect(evidence.result.output.text).toContain('"findings":[]');
    expect(evidence.git.changedFiles).toEqual(["src/sum.ts"]);
    expect(evidence.git.verificationExitCode).toBe(0);
    assertProviderBoundary(evidence.provider);
    assertSafetyClosure(evidence);
  }, 60_000);

  it("权限拒绝在等待期间和终态后均保持工作目录外文件系统不变", async () => {
    const evidence = await runFormalClaudeScenario("deny", "run-claude-deny");

    expect(evidence.permissionDecisions).toEqual(["deny"]);
    expect(evidence.permissionWaitHadNoSideEffect).toBe(true);
    expect(evidence.eventTypes).toContain("permission.requested");
    expect(evidence.eventTypes).toContain("permission.responded");
    expect(
      evidence.events.some(
        (event) => event.type === "tool.completed" && event.outcome === "denied",
      ),
    ).toBe(true);
    expect(evidence.result.status).toBe("succeeded");
    expect(evidence.git.changedFiles).toEqual([]);
    expect(evidence.git.verificationExitCode).not.toBe(0);
    assertProviderBoundary(evidence.provider);
    assertSafetyClosure(evidence);
  }, 60_000);

  it("执行中取消形成 cancelled 终态且取消后没有工具调用或文件写入", async () => {
    const evidence = await runFormalClaudeScenario("cancel", "run-claude-cancel");

    expect(evidence.eventTypes[0]).toBe("run.started");
    expect(evidence.eventTypes.slice(-2)).toEqual(["run.cancellation_requested", "run.cancelled"]);
    expect(
      evidence.eventTypes.some((type) => type === "tool.started" || type === "tool.completed"),
    ).toBe(false);
    expect(evidence.result.status).toBe("cancelled");
    expect(evidence.git.changedFiles).toEqual([]);
    expect(evidence.postCancelSideEffects).toBe(0);
    expect(evidence.provider.requests).toBe(1);
    assertProviderBoundary(evidence.provider);
    assertSafetyClosure(evidence);
  }, 60_000);

  it("Driver 与 Claude Code 重启后由正式 resumeTask 恢复同一 Session 和连续事件边界", async () => {
    const evidence = await runFormalClaudeScenario("resume", "run-claude-resume");

    expect(evidence.resumedSameSession).toBe(true);
    expect(evidence.eventTypes).toContain("run.resumed");
    expect(evidence.eventTypes.at(-1)).toBe("run.completed");
    expect(evidence.result.status).toBe("succeeded");
    expect(evidence.git.changedFiles).toEqual(["src/sum.ts"]);
    expect(evidence.git.verificationExitCode).toBe(0);
    expect(evidence.provider.requests).toBe(4);
    assertProviderBoundary(evidence.provider);
    assertSafetyClosure(evidence);
  }, 90_000);
});

async function runFormalClaudeScenario(
  scenario: ClaudeFormalProviderScenario,
  runId: string,
): Promise<ScenarioEvidence> {
  const originalWorkingDirectory = process.cwd();
  const originalEnvironment = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-claude-formal-b-"));
  const syntheticToken = `synthetic-${randomBytes(24).toString("hex")}`;
  const privateValues = [syntheticToken];
  let privatePaths: readonly string[] = [root];
  let driver: ClaudeAgentDriver | undefined;
  let provider: ClaudeFormalMockProvider | undefined;
  const tracker = new DescendantProcessTracker();
  let trackerStarted = false;
  let evidence: ScenarioEvidence | undefined;
  let scenarioError: unknown;

  try {
    const fixture = await createClaudeFormalGitFixture(root);
    if (scenario === "review") {
      await applyReviewHandoff(fixture);
    }
    const workDirectory =
      scenario === "review" ? fixture.workDirectories.review : fixture.workDirectories.fallback;
    const initialSnapshot = await snapshotClaudeWorktree(fixture, workDirectory);
    const isolation = await createIsolatedClaudeEnvironment({
      root,
      workDirectory,
      originalEnvironment,
    });
    privatePaths = isolation.privatePaths;
    provider = await startClaudeFormalMockProvider({ scenario, syntheticToken });
    await tracker.start();
    trackerStarted = true;
    replaceProcessEnvironment(isolatedProcessEnvironment(isolation.isolation));
    process.chdir(workDirectory);
    assertCredentialFreeEnvironment(isolation);

    driver = startFormalClaudeDriver({
      workDirectory,
      isolation,
      providerUrl: provider.url,
      syntheticToken,
      scenario,
      runId,
    });
    const health = await driver.healthCheck();
    expect(health).toMatchObject({
      status: "healthy",
      message: "Claude Agent SDK 0.3.215; Claude Code 2.1.215",
      details: {
        sdkVersion: "0.3.215",
        runtimeVersion: "2.1.215",
      },
    });
    const prepared = await driver.prepareTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      taskId: `task-claude-${scenario}`,
      taskVersion: 1,
      idempotencyKey: `formal-claude-b-${scenario}`,
      task: {
        objective: objectiveForScenario(scenario),
        allowedPaths: ["src/sum.ts"],
        role: scenario === "review" ? "reviewer" : "developer",
      },
    });
    const run = await driver.startTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTask: prepared,
      context: {
        layer: "B-simulated",
        provider: "deterministic-anthropic-loopback",
        realProviderRequests: 0,
      },
    });
    let stream = new EventStream(driver.streamEvents(run.runId));
    const permissionDecisions: ("allow" | "deny")[] = [];
    let permissionWaitHadNoSideEffect = true;
    let reviewReadOnly = scenario !== "review";
    let postCancelSideEffects = 0;
    let resumedSameSession = false;

    if (scenario === "cancel") {
      await stream.nextMatching((event) => event.type === "run.started");
      await provider.waitForRequests(1);
      const beforeCancel = await snapshotClaudeWorktree(fixture, workDirectory);
      await driver.cancelTask({
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId: run.runId,
        sessionId: run.session.sessionId,
        reason: "Formal Claude B-simulated cancellation",
      });
      await stream.collectToEnd();
      const eventsAtCancellation = stream.events.length;
      await delay(300);
      const afterCancel = await snapshotClaudeWorktree(fixture, workDirectory);
      postCancelSideEffects =
        Number(!sameSnapshot(beforeCancel, afterCancel)) +
        Number(stream.events.length !== eventsAtCancellation);
    } else if (scenario === "resume") {
      for (let toolIndex = 0; toolIndex < 2; toolIndex += 1) {
        const permission = await stream.nextMatching(
          (event): event is PermissionRequestedEvent => event.type === "permission.requested",
        );
        permissionWaitHadNoSideEffect &&= await assertPermissionWaitHasNoSideEffect(
          fixture,
          workDirectory,
        );
        expect(JSON.stringify(permission.permission.details)).toContain("sum.ts");
        permissionDecisions.push("allow");
        await driver.respondToPermission({
          protocolVersion: DRIVER_PROTOCOL_VERSION,
          runId: run.runId,
          sessionId: run.session.sessionId,
          permissionId: permission.permission.permissionId,
          toolCallId: permission.permission.toolCallId,
          decision: "allow",
          reason: "Allowed fixture file",
        });
        await stream.nextMatching(
          (event) => event.type === "tool.completed" && event.outcome === "succeeded",
        );
      }
      await provider.waitForRequests(3);
      const recoveryState = driver.exportRecoveryState(run.runId);
      await driver.close();
      driver = undefined;
      driver = startFormalClaudeDriver({
        workDirectory,
        isolation,
        providerUrl: provider.url,
        syntheticToken,
        scenario,
        runId,
        recoveryStates: [recoveryState],
      });
      stream = new EventStream(driver.streamEvents(run.runId));
      const resumed = await driver.resumeTask({
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId: run.runId,
        sessionId: run.session.sessionId,
        reason: "Restart recovery checkpoint",
        context: {
          checkpoint: "tool-completed",
          realProviderRequests: 0,
        },
      });
      await stream.collectToEnd();
      const resumeIndex = stream.events.findIndex((event) => event.type === "run.resumed");
      const resumeEvent = stream.events[resumeIndex];
      const predecessor = stream.events[resumeIndex - 1];
      resumedSameSession =
        resumed.runId === run.runId &&
        resumed.session.sessionId === run.session.sessionId &&
        resumeEvent?.sessionId === run.session.sessionId &&
        resumeEvent.sequence === (predecessor?.sequence ?? 0) + 1;
    } else {
      const decisions = await collectWithPermissionResponses({
        driver,
        stream,
        fixture,
        workDirectory,
        runId: run.runId,
        sessionId: run.session.sessionId,
        scenario,
      });
      permissionDecisions.push(...decisions.decisions);
      permissionWaitHadNoSideEffect &&= decisions.waitHadNoSideEffect;
    }

    for (const event of stream.events) {
      assertAgentEvent(event);
      expect(event.runId).toBe(run.runId);
      expect(event.sessionId).toBe(run.session.sessionId);
    }
    assertAgentEventSequence(stream.events);
    const result = await driver.collectResult(run.runId);
    const startedEvent = stream.events.find((event) => event.type === "run.started");
    expect(startedEvent).toMatchObject({
      preparedTaskId: prepared.preparedTaskId,
      runId: run.runId,
      sessionId: run.session.sessionId,
    });
    expect(result.runId).toBe(run.runId);
    expect(result.sessionId).toBe(run.session.sessionId);

    const finalSnapshot = await snapshotClaudeWorktree(fixture, workDirectory);
    if (scenario === "review") {
      reviewReadOnly = sameSnapshot(initialSnapshot, finalSnapshot);
    }
    if (scenario === "write" || scenario === "review" || scenario === "resume") {
      expect(finalSnapshot.source).toBe(fixedClaudeSumSource());
      expect(finalSnapshot.outsideExists).toBe(false);
    } else {
      expect(finalSnapshot.source).toBe(buggyClaudeSumSource());
      expect(finalSnapshot.outsideExists).toBe(false);
    }
    const git = await collectClaudeFormalGitEvidence(fixture, workDirectory);
    const providerAudit = provider.audit();
    expect(providerAudit.rejectedRequests).toBe(0);
    expect(providerAudit.realProviderRequests).toBe(0);

    evidence = {
      scenario,
      runId: run.runId,
      sessionId: run.session.sessionId,
      eventTypes: stream.events.map((event) => event.type),
      events: stream.events.map((event) => structuredClone(event)),
      result,
      git,
      provider: providerAudit,
      permissionDecisions,
      permissionWaitHadNoSideEffect,
      reviewReadOnly,
      postCancelSideEffects,
      resumedSameSession,
      credentialsRead: false,
      realProviderRequests: 0,
      costUsd: 0,
      residualProcessCount: -1,
      temporaryRootRemoved: false,
    };
    expect(JSON.stringify(evidence)).not.toContain(syntheticToken);
    expect(JSON.stringify(evidence)).not.toContain(root);
  } catch (error) {
    scenarioError = error;
  } finally {
    await driver?.close().catch((error: unknown) => {
      scenarioError ??= error;
    });
    await provider?.close().catch((error: unknown) => {
      scenarioError ??= error;
    });
    process.chdir(originalWorkingDirectory);
    replaceProcessEnvironment(originalEnvironment);
    if (trackerStarted) {
      const cleanup = await tracker.stopAndCleanup().catch((error: unknown) => {
        scenarioError ??= error;
        return { residualProcessCount: -1 };
      });
      if (evidence !== undefined) {
        evidence.residualProcessCount = cleanup.residualProcessCount;
      }
    }
    await rm(root, { recursive: true, force: true }).catch((error: unknown) => {
      scenarioError ??= error;
    });
    await assertRootRemoved(root).catch((error: unknown) => {
      scenarioError ??= error;
    });
    if (evidence !== undefined) {
      evidence.temporaryRootRemoved = !(await pathExists(root));
    }
  }

  if (scenarioError !== undefined) {
    throw new Error(safeError(scenarioError, privatePaths, privateValues));
  }
  if (evidence === undefined) {
    throw new Error("CLAUDE_B_SIMULATED_EVIDENCE_MISSING");
  }
  return evidence;
}

function startFormalClaudeDriver(input: {
  readonly workDirectory: string;
  readonly isolation: IsolatedClaudeEnvironment;
  readonly providerUrl: string;
  readonly syntheticToken: string;
  readonly scenario: ClaudeFormalProviderScenario;
  readonly runId: string;
  readonly recoveryStates?: readonly ClaudeAgentDriverRecoveryState[];
}): ClaudeAgentDriver {
  return createClaudeAgentDriver({
    workDirectory: input.workDirectory,
    isolation: input.isolation.isolation,
    pathToClaudeCodeExecutable: input.isolation.executablePath,
    sessionReadyTimeoutMs: 15_000,
    createRunId: () => input.runId,
    recoveryStates: input.recoveryStates,
    provider: {
      baseUrl: input.providerUrl,
      authToken: input.syntheticToken,
      apiKey: input.syntheticToken,
      model: "deepseek-v4-pro[1m]",
    },
    security: {
      tools: toolsForScenario(input.scenario),
      maxTurns: 6,
      maxBudgetUsd: 0.12,
    },
  });
}

async function collectWithPermissionResponses(input: {
  readonly driver: ClaudeAgentDriver;
  readonly stream: EventStream;
  readonly fixture: Awaited<ReturnType<typeof createClaudeFormalGitFixture>>;
  readonly workDirectory: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly scenario: Exclude<ClaudeFormalProviderScenario, "cancel" | "resume">;
}): Promise<{
  readonly decisions: readonly ("allow" | "deny")[];
  readonly waitHadNoSideEffect: boolean;
}> {
  const decisions: ("allow" | "deny")[] = [];
  let waitHadNoSideEffect = true;
  for (;;) {
    const next = await input.stream.nextOrEnd();
    if (next === undefined) {
      return { decisions, waitHadNoSideEffect };
    }
    if (next.type !== "permission.requested") {
      continue;
    }
    waitHadNoSideEffect &&= await assertPermissionWaitHasNoSideEffect(
      input.fixture,
      input.workDirectory,
    );
    const expectedPath = input.scenario === "deny" ? "outside.txt" : "sum.ts";
    expect(JSON.stringify(next.permission.details)).toContain(expectedPath);
    const decision = input.scenario === "deny" ? "deny" : "allow";
    decisions.push(decision);
    await input.driver.respondToPermission({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      runId: input.runId,
      sessionId: input.sessionId,
      permissionId: next.permission.permissionId,
      toolCallId: next.permission.toolCallId,
      decision,
      reason: decision === "allow" ? "Allowed fixture path" : "Outside the allowed worktree",
    });
  }
}

async function assertPermissionWaitHasNoSideEffect(
  fixture: Awaited<ReturnType<typeof createClaudeFormalGitFixture>>,
  workDirectory: string,
): Promise<boolean> {
  const before = await snapshotClaudeWorktree(fixture, workDirectory);
  await delay(75);
  const after = await snapshotClaudeWorktree(fixture, workDirectory);
  return sameSnapshot(before, after);
}

class EventStream {
  readonly events: AgentEvent[] = [];
  private readonly iterator: AsyncIterator<AgentEvent>;

  constructor(events: AsyncIterable<AgentEvent>) {
    this.iterator = events[Symbol.asyncIterator]();
  }

  async nextMatching<TEvent extends AgentEvent>(
    predicate: (event: AgentEvent) => event is TEvent,
  ): Promise<TEvent>;
  async nextMatching(predicate: (event: AgentEvent) => boolean): Promise<AgentEvent>;
  async nextMatching(predicate: (event: AgentEvent) => boolean): Promise<AgentEvent> {
    for (;;) {
      const event = await this.next();
      if (predicate(event)) {
        return event;
      }
    }
  }

  async nextOrEnd(): Promise<AgentEvent | undefined> {
    const next = await withEventTimeout(this.iterator.next(), this.events);
    if (next.done) {
      return undefined;
    }
    this.events.push(next.value);
    return next.value;
  }

  async collectToEnd(): Promise<void> {
    while ((await this.nextOrEnd()) !== undefined) {
      // 事件已由 nextOrEnd 收集。
    }
  }

  private async next(): Promise<AgentEvent> {
    const event = await this.nextOrEnd();
    if (event === undefined) {
      throw new Error("CLAUDE_B_SIMULATED_EVENT_STREAM_ENDED");
    }
    return event;
  }
}

function withEventTimeout<T>(promise: Promise<T>, events: readonly AgentEvent[]): Promise<T> {
  return Promise.race([
    promise,
    delay(25_000).then(() => {
      throw new Error(
        `CLAUDE_B_SIMULATED_EVENT_TIMEOUT:${events.map((event) => event.type).join(",")}`,
      );
    }),
  ]);
}

function toolsForScenario(scenario: ClaudeFormalProviderScenario): readonly string[] {
  switch (scenario) {
    case "write":
      return ["Read", "Write"];
    case "review":
      return ["Read"];
    case "deny":
      return ["Write"];
    case "resume":
      return ["Read", "Write"];
    case "cancel":
      return [];
  }
}

function objectiveForScenario(scenario: ClaudeFormalProviderScenario): string {
  switch (scenario) {
    case "write":
      return "Read and correct src/sum.ts using only one allowed write";
    case "review":
      return "Read src/sum.ts and return a concise JSON review without modifying files";
    case "deny":
      return "Attempt one ../outside.txt write so Agent Bridge can deny it";
    case "cancel":
      return "Wait for the simulated Provider response without using tools";
    case "resume":
      return "Correct src/sum.ts, then continue from the persisted Session after restart";
  }
}

function assertCredentialFreeEnvironment(isolation: IsolatedClaudeEnvironment): void {
  const forbidden = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "B_LAYER_AUTHORIZED",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
  ];
  for (const key of forbidden) {
    expect(process.env).not.toHaveProperty(key);
  }
  expect(process.env).toMatchObject({
    HOME: isolation.isolation.homeDirectory,
    TMPDIR: isolation.isolation.tempDirectory,
    XDG_CONFIG_HOME: isolation.isolation.configDirectory,
    XDG_DATA_HOME: isolation.isolation.dataDirectory,
    XDG_CACHE_HOME: isolation.isolation.cacheDirectory,
    CLAUDE_CONFIG_DIR: isolation.isolation.claudeConfigDirectory,
    CLAUDE_CODE_TMPDIR: isolation.isolation.tempDirectory,
  });
}

function assertProviderBoundary(provider: ClaudeFormalProviderAudit): void {
  expect(provider.rejectedRequests).toBe(0);
  expect(provider.realProviderRequests).toBe(0);
  expect(provider.paths.every((path) => path === "/anthropic/v1/messages")).toBe(true);
  expect(provider.models.every((model) => model === "deepseek-v4-pro")).toBe(true);
}

function assertSafetyClosure(evidence: ScenarioEvidence): void {
  expect(evidence.realProviderRequests).toBe(0);
  expect(evidence.credentialsRead).toBe(false);
  expect(evidence.costUsd).toBe(0);
  expect(evidence.residualProcessCount).toBe(0);
  expect(evidence.temporaryRootRemoved).toBe(true);
}

function sameSnapshot(left: ClaudeWorktreeSnapshot, right: ClaudeWorktreeSnapshot): boolean {
  return (
    left.source === right.source &&
    left.status === right.status &&
    left.patchSha256 === right.patchSha256 &&
    left.outsideExists === right.outsideExists
  );
}

function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
