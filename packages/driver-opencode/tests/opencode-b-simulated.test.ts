import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  createOpenCodeDriver,
  type OpenCodeDriver,
  type OpenCodeDriverRecoveryState,
} from "../src/driver.js";
import {
  collectFormalGitEvidence,
  createFormalGitFixture,
  readSumSource,
  type FormalGitEvidence,
} from "./fixtures/b-simulated/git-fixture.js";
import {
  DescendantProcessTracker,
  assertRootRemoved,
  createIsolatedOpenCodeEnvironment,
  replaceProcessEnvironment,
  safeError,
} from "./fixtures/b-simulated/isolation.js";
import {
  startFormalMockProvider,
  type FormalMockProvider,
  type FormalProviderAudit,
  type FormalProviderScenario,
} from "./fixtures/b-simulated/mock-provider.js";

interface ScenarioEvidence {
  readonly scenario: FormalProviderScenario;
  readonly runId: string;
  readonly sessionId: string;
  readonly eventTypes: readonly AgentEvent["type"][];
  readonly result: AgentResult;
  readonly git: FormalGitEvidence;
  readonly provider: FormalProviderAudit;
  readonly permissionDecision?: "allow" | "deny";
  readonly permissionWaitHadNoSideEffect: boolean;
  readonly postCancelSideEffects: number;
  readonly resumedSameSession: boolean;
  readonly credentialsRead: false;
  readonly realProviderRequests: 0;
  readonly costUsd: 0;
  residualProcessCount: number;
  temporaryRootRemoved: boolean;
}

const nestedMacOsSandboxUnavailable =
  process.platform === "darwin" &&
  spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
    stdio: "ignore",
  }).status !== 0;

describe
  .skipIf(nestedMacOsSandboxUnavailable)
  .sequential("OpenCodeDriver 1.18.3 正式 B-simulated 回归", () => {
    it("通过正式 Driver 重复完成允许写入、统一事件、用量、结果和 Git 白名单验证", async () => {
      const first = await runFormalScenario("write", "run-write-1");
      const second = await runFormalScenario("write", "run-write-2");

      for (const evidence of [first, second]) {
        expect(
          evidence.provider.requests,
          `provider requests=${evidence.provider.requests}`,
        ).toBeGreaterThan(1);
        expect(evidence.eventTypes, evidence.eventTypes.join(",")).toContain("output.delta");
        expect(evidence.result.status).toBe("succeeded");
        expect(evidence.result.output.text).toBeTypeOf("string");
        expect(evidence.result.output.text).toContain("allowed file");
        expect(evidence.result.usage?.inputTokens).toBeGreaterThan(0);
        expect(evidence.result.usage?.outputTokens).toBeGreaterThan(0);
        expect(evidence.git.changedFiles).toEqual(["src/sum.ts"]);
        expect(evidence.git.verificationExitCode).toBe(0);
        expect(evidence.permissionDecision).toBe("allow");
        expect(evidence.permissionWaitHadNoSideEffect).toBe(true);
        expect(evidence.provider).toMatchObject({
          rejectedRequests: 0,
          realProviderRequests: 0,
        });
        expect(evidence.provider.paths.every((path) => path === "/v1/chat/completions")).toBe(true);
        expect(evidence.provider.models.every((model) => model === "deepseek-v4-pro")).toBe(true);
        assertSafetyClosure(evidence);
      }

      expect(second.eventTypes).toEqual(first.eventTypes);
      expect(second.provider.requests).toBe(first.provider.requests);
      expect(second.result.status).toBe(first.result.status);
    }, 90_000);

    it("权限拒绝在等待期间和终态后均保持工作目录外文件系统不变", async () => {
      const evidence = await runFormalScenario("deny", "run-deny");

      expect(evidence.permissionDecision).toBe("deny");
      expect(evidence.permissionWaitHadNoSideEffect).toBe(true);
      expect(evidence.eventTypes).toContain("permission.requested");
      expect(evidence.eventTypes).toContain("permission.responded");
      expect(evidence.result.status).toBe("succeeded");
      expect(evidence.git.changedFiles).toEqual([]);
      expect(evidence.git.verificationExitCode).not.toBe(0);
      expect(evidence.provider.realProviderRequests).toBe(0);
      assertSafetyClosure(evidence);
    }, 45_000);

    it("执行中取消形成 cancelled 终态且取消后没有工具调用或文件写入", async () => {
      const evidence = await runFormalScenario("cancel", "run-cancel");

      expect(evidence.eventTypes[0]).toBe("run.started");
      expect(evidence.eventTypes.slice(-2)).toEqual([
        "run.cancellation_requested",
        "run.cancelled",
      ]);
      expect(
        evidence.eventTypes.some((type) => type === "tool.started" || type === "tool.completed"),
      ).toBe(false);
      expect(evidence.result.status).toBe("cancelled");
      expect(evidence.git.changedFiles).toEqual([]);
      expect(evidence.postCancelSideEffects).toBe(0);
      expect(evidence.provider.requests).toBe(1);
      expect(evidence.provider.realProviderRequests).toBe(0);
      assertSafetyClosure(evidence);
    }, 45_000);

    it("Driver 与 OpenCode Server 重启后由正式 resumeTask 恢复同一 Session 和连续事件边界", async () => {
      const evidence = await runFormalScenario("resume", "run-resume");

      expect(evidence.resumedSameSession).toBe(true);
      expect(evidence.eventTypes).toContain("run.resumed");
      expect(evidence.eventTypes.at(-1)).toBe("run.completed");
      expect(evidence.result.status).toBe("succeeded");
      expect(evidence.git.changedFiles).toEqual(["src/sum.ts"]);
      expect(evidence.git.verificationExitCode).toBe(0);
      expect(evidence.provider.realProviderRequests).toBe(0);
      assertSafetyClosure(evidence);
    }, 60_000);
  });

async function runFormalScenario(
  scenario: FormalProviderScenario,
  runId: string,
): Promise<ScenarioEvidence> {
  const originalWorkingDirectory = process.cwd();
  const originalEnvironment = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-opencode-formal-b-"));
  const syntheticToken = `synthetic-${randomBytes(24).toString("hex")}`;
  const privateValues = [syntheticToken];
  let privatePaths: readonly string[] = [root];
  let driver: OpenCodeDriver | undefined;
  let provider: FormalMockProvider | undefined;
  const tracker = new DescendantProcessTracker();
  let trackerStarted = false;
  let evidence: ScenarioEvidence | undefined;
  let scenarioError: unknown;

  try {
    const fixture = await createFormalGitFixture(root);
    const isolation = await createIsolatedOpenCodeEnvironment({
      root,
      workDirectory: fixture.workDirectory,
      originalEnvironment,
    });
    privatePaths = isolation.privatePaths;
    provider = await startFormalMockProvider({ scenario, syntheticToken });
    await tracker.start();
    trackerStarted = true;
    replaceProcessEnvironment(isolation.environment);
    process.chdir(fixture.workDirectory);
    assertCredentialFreeEnvironment();

    driver = await startFormalDriver({
      workDirectory: fixture.workDirectory,
      executablePath: isolation.executablePath,
      providerUrl: provider.url,
      syntheticToken,
      scenario,
      runId,
    });
    const health = await driver.healthCheck();
    expect(health).toMatchObject({
      status: "healthy",
      message: "OpenCode runtime 1.18.3",
    });
    const prepared = await driver.prepareTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      taskId: `task-${scenario}`,
      taskVersion: 1,
      idempotencyKey: `formal-b-${scenario}`,
      task: {
        objective:
          scenario === "deny"
            ? "Attempt one out-of-worktree write for denial verification"
            : "Correct the allowed sum fixture",
        allowedPaths: ["src/sum.ts"],
      },
    });
    const run = await driver.startTask({
      protocolVersion: DRIVER_PROTOCOL_VERSION,
      preparedTask: prepared,
      context: {
        layer: "B-simulated",
        provider: "deterministic-loopback",
        realProviderRequests: 0,
      },
    });
    let stream = new EventStream(driver.streamEvents(run.runId));
    let permissionDecision: "allow" | "deny" | undefined;
    let permissionWaitHadNoSideEffect = true;
    let postCancelSideEffects = 0;
    let resumedSameSession = false;

    if (scenario === "cancel") {
      await stream.nextMatching((event) => event.type === "run.started");
      await provider.waitForRequests(1);
      const sourceBeforeCancel = await readSumSource(fixture);
      await driver.cancelTask({
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId: run.runId,
        sessionId: run.session.sessionId,
        reason: "Formal B-simulated cancellation",
      });
      await stream.collectToEnd();
      const eventsAtCancellation = stream.events.length;
      await delay(300);
      const sourceAfterCancel = await readSumSource(fixture);
      const outsideExists = await pathExists(fixture.outsidePath);
      postCancelSideEffects =
        Number(sourceAfterCancel !== sourceBeforeCancel) +
        Number(outsideExists) +
        Number(stream.events.length !== eventsAtCancellation);
    } else {
      const permission = await stream.nextMatching(
        (event): event is PermissionRequestedEvent => event.type === "permission.requested",
      );
      const sourceWhileWaiting = await readSumSource(fixture);
      const outsideWhileWaiting = await pathExists(fixture.outsidePath);
      permissionWaitHadNoSideEffect =
        sourceWhileWaiting === "export const sum = (a, b) => a - b;\n" && !outsideWhileWaiting;
      expect(JSON.stringify(permission.permission.details)).toContain(
        scenario === "deny" ? "outside.txt" : "sum.ts",
      );

      permissionDecision = scenario === "deny" ? "deny" : "allow";
      await driver.respondToPermission({
        protocolVersion: DRIVER_PROTOCOL_VERSION,
        runId: run.runId,
        sessionId: run.session.sessionId,
        permissionId: permission.permission.permissionId,
        toolCallId: permission.permission.toolCallId,
        decision: permissionDecision,
        reason:
          permissionDecision === "allow" ? "Allowed fixture file" : "Outside the allowed worktree",
      });

      if (scenario === "resume") {
        await stream.nextMatching(
          (event) => event.type === "tool.completed" && event.outcome === "succeeded",
        );
        await provider.waitForRequests(2);
        const recoveryState = driver.exportRecoveryState(run.runId);
        await driver.close();
        driver = undefined;
        driver = await startFormalDriver({
          workDirectory: fixture.workDirectory,
          executablePath: isolation.executablePath,
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
        const resumeEvent = await stream.nextMatching((event) => event.type === "run.resumed");
        const predecessorEvent = stream.events.at(-2);
        resumedSameSession =
          resumed.runId === run.runId &&
          resumed.session.sessionId === run.session.sessionId &&
          resumeEvent.sessionId === run.session.sessionId &&
          resumeEvent.sequence === (predecessorEvent?.sequence ?? 0) + 1;
        await driver.sendFeedback({
          protocolVersion: DRIVER_PROTOCOL_VERSION,
          runId: run.runId,
          sessionId: run.session.sessionId,
          feedbackId: "resume-after-restart",
          feedback: {
            instruction: "Continue from the persisted tool result and finish",
            realProviderRequests: 0,
          },
        });
      }
      await stream.collectToEnd();
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
    const git = await collectFormalGitEvidence(fixture);
    if (scenario === "deny" || scenario === "cancel") {
      expect(await pathExists(fixture.outsidePath)).toBe(false);
      expect(await readSumSource(fixture)).toBe("export const sum = (a, b) => a - b;\n");
    } else {
      expect(await readSumSource(fixture)).toBe("export const sum = (a, b) => a + b;\n");
    }
    if (scenario === "deny") {
      expect(
        stream.events.some(
          (event) => event.type === "tool.completed" && event.outcome === "denied",
        ),
      ).toBe(true);
    }
    const providerAudit = provider.audit();
    expect(providerAudit.rejectedRequests).toBe(0);
    expect(providerAudit.realProviderRequests).toBe(0);

    evidence = {
      scenario,
      runId: run.runId,
      sessionId: run.session.sessionId,
      eventTypes: stream.events.map((event) => event.type),
      result,
      git,
      provider: providerAudit,
      permissionDecision,
      permissionWaitHadNoSideEffect,
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
    throw new Error("OPENCODE_B_SIMULATED_EVIDENCE_MISSING");
  }
  return evidence;
}

function startFormalDriver(input: {
  readonly workDirectory: string;
  readonly executablePath: string;
  readonly providerUrl: string;
  readonly syntheticToken: string;
  readonly scenario: FormalProviderScenario;
  readonly runId: string;
  readonly recoveryStates?: readonly OpenCodeDriverRecoveryState[];
}): Promise<OpenCodeDriver> {
  return createOpenCodeDriver({
    workDirectory: input.workDirectory,
    hostname: "127.0.0.1",
    timeoutMs: 15_000,
    executablePath: input.executablePath,
    createRunId: () => input.runId,
    recoveryStates: input.recoveryStates,
    provider: {
      enabledProviders: ["deepseek"],
      model: "deepseek/deepseek-v4-pro",
      smallModel: "deepseek/deepseek-v4-pro",
      providers: {
        deepseek: {
          name: "Agent Bridge deterministic loopback Provider",
          options: {
            apiKey: input.syntheticToken,
            baseURL: `${input.providerUrl}/v1`,
            timeout: 10_000,
          },
          models: {
            "deepseek-v4-pro": {
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro local simulation",
              tool_call: true,
              limit: {
                context: 1_000_000,
                output: 16_000,
              },
            },
          },
        },
      },
      permissions: {
        edit: input.scenario === "cancel" ? "deny" : "ask",
        bash: "deny",
        webfetch: "deny",
        doomLoop: "deny",
        externalDirectory: input.scenario === "deny" ? "ask" : "deny",
      },
    },
  });
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

  async collectToEnd(): Promise<void> {
    for (;;) {
      const next = await Promise.race([
        this.iterator.next(),
        delay(20_000).then(() => {
          throw new Error(
            `OPENCODE_B_SIMULATED_EVENT_TIMEOUT:${this.events
              .map((event) => event.type)
              .join(",")}`,
          );
        }),
      ]);
      if (next.done) {
        return;
      }
      this.events.push(next.value);
    }
  }

  private async next(): Promise<AgentEvent> {
    const next = await Promise.race([
      this.iterator.next(),
      delay(20_000).then(() => {
        throw new Error(
          `OPENCODE_B_SIMULATED_EVENT_TIMEOUT:${this.events.map((event) => event.type).join(",")}`,
        );
      }),
    ]);
    if (next.done) {
      throw new Error("OPENCODE_B_SIMULATED_EVENT_STREAM_ENDED");
    }
    this.events.push(next.value);
    return next.value;
  }
}

function assertCredentialFreeEnvironment(): void {
  const forbidden = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
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
}

function assertSafetyClosure(evidence: ScenarioEvidence): void {
  expect(evidence.realProviderRequests).toBe(0);
  expect(evidence.credentialsRead).toBe(false);
  expect(evidence.costUsd).toBe(0);
  expect(evidence.residualProcessCount).toBe(0);
  expect(evidence.temporaryRootRemoved).toBe(true);
}

function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
