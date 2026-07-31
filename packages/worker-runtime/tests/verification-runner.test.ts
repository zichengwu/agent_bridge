import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ArtifactMetadata,
  ArtifactMetadataQuery,
  ArtifactRepository,
  ArtifactWriteRequest,
  ArtifactWriteResult,
} from "@agent-bridge/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  IndependentVerificationRunner,
  ProcessSupervisor,
  WorkerRuntimeError,
  assertVerificationInitiatorAllowed,
  type VerificationCommandConfiguration,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Bridge 独立验证执行", () => {
  it("执行精确配置命令并归档命令日志与汇总报告", async () => {
    const artifacts = new MemoryArtifacts();
    const execution = new IndependentVerificationRunner(new ProcessSupervisor(), artifacts).start(
      await request("process.stdout.write('ok')"),
    );

    const result = await execution.result;

    expect(result.status).toBe("passed");
    expect(result.commands).toEqual([
      expect.objectContaining({ contract: "verify", status: "passed", exit_code: 0 }),
    ]);
    expect(artifacts.text(result.commands[0]!.log_artifact_id!)).toContain("ok");
    expect(JSON.parse(artifacts.text(result.report_artifact_id))).toMatchObject({
      status: "passed",
      run_id: "run-1",
    });
  });

  it("非零退出保留真实退出码且不把 Agent 自述当作结果", async () => {
    const execution = new IndependentVerificationRunner(
      new ProcessSupervisor(),
      new MemoryArtifacts(),
    ).start(await request("process.stderr.write('failed'); process.exit(7)"));

    await expect(execution.result).resolves.toMatchObject({
      status: "failed",
      commands: [{ status: "failed", exit_code: 7 }],
    });
  });

  it("超时和取消都清理进程且不伪造退出码", async () => {
    const timed = new IndependentVerificationRunner(
      new ProcessSupervisor(),
      new MemoryArtifacts(),
    ).start(await request("setInterval(() => {}, 1000)", 1));
    const timedResult = await timed.result;

    expect(timedResult.status).toBe("timed_out");
    expect(timedResult.commands[0]).not.toHaveProperty("exit_code");

    const cancelled = new IndependentVerificationRunner(
      new ProcessSupervisor(),
      new MemoryArtifacts(),
    ).start(await request("setInterval(() => {}, 1000)", 5));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await cancelled.cancel("用户取消验证");
    const cancelledResult = await cancelled.result;

    expect(cancelledResult.status).toBe("cancelled");
    expect(cancelledResult.commands[0]).not.toHaveProperty("exit_code");
  });

  it("进程尚在启动时收到取消也会在取得句柄后立即清理", async () => {
    const execution = new IndependentVerificationRunner(
      new ProcessSupervisor(),
      new MemoryArtifacts(),
    ).start(await request("setInterval(() => {}, 1000)", 5));

    await execution.cancel("立即取消");

    await expect(execution.result).resolves.toMatchObject({
      status: "cancelled",
      commands: [{ status: "cancelled" }],
    });
  });

  it("日志归档前脱敏常见凭据形态", async () => {
    const artifacts = new MemoryArtifacts();
    const secret = "sk-abcdefghijklmnop1234";
    const execution = new IndependentVerificationRunner(new ProcessSupervisor(), artifacts).start(
      await request(`process.stdout.write('${secret}')`),
    );
    const result = await execution.result;

    expect(artifacts.text(result.commands[0]!.log_artifact_id!)).not.toContain(secret);
  });

  it("Tester 可请求独立验证，Reviewer 保持只读", () => {
    expect(() =>
      assertVerificationInitiatorAllowed({ kind: "agent", id: "tester-1", role: "tester" }),
    ).not.toThrow();
    expect(() =>
      assertVerificationInitiatorAllowed({ kind: "agent", id: "reviewer-1", role: "reviewer" }),
    ).toThrowError(
      expect.objectContaining({ code: "ROLE_POLICY_DENIED" } satisfies Partial<WorkerRuntimeError>),
    );
  });
});

async function request(source: string, timeoutSeconds = 2) {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-verification-"));
  roots.push(root);
  const command: VerificationCommandConfiguration = {
    contract: "verify",
    executable: process.execPath,
    args: ["-e", source],
    timeout_seconds: timeoutSeconds,
  };
  return {
    verification_id: `verification-${roots.length}`,
    run_id: "run-1",
    worktree_path: root,
    acceptance_commands: ["verify"],
    command_catalog: { verify: command },
    initiator: { kind: "bridge", id: "bridge-1" } as const,
    environment: { PATH: process.env.PATH ?? "", CI: "1", NO_COLOR: "1" },
    max_output_bytes: 1024,
    termination_grace_ms: 100,
  };
}

class MemoryArtifacts implements ArtifactRepository {
  private readonly values = new Map<
    string,
    { readonly metadata: ArtifactMetadata; readonly data: Buffer }
  >();

  put(request: ArtifactWriteRequest): Promise<ArtifactWriteResult> {
    if (!(request.content instanceof Uint8Array)) {
      throw new Error("Test repository only accepts byte content");
    }
    const data = Buffer.from(request.content);
    const metadata: ArtifactMetadata = {
      artifact_id: request.artifact_id,
      kind: request.kind,
      content_hash: `sha256:${createHash("sha256").update(data).digest("hex")}`,
      size_bytes: data.length,
      retention_class: request.retention_class ?? "standard",
      created_at: request.created_at ?? new Date().toISOString(),
      ...(request.media_type === undefined ? {} : { media_type: request.media_type }),
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    };
    this.values.set(request.artifact_id, { metadata, data });
    return Promise.resolve({ outcome: "STORED", artifact: metadata });
  }

  getMetadata(artifactId: string): Promise<ArtifactMetadata | undefined> {
    return Promise.resolve(this.values.get(artifactId)?.metadata);
  }

  read(artifactId: string): Promise<AsyncIterable<Uint8Array>> {
    const data = this.values.get(artifactId)?.data;
    if (data === undefined) {
      throw new Error("missing artifact");
    }
    return Promise.resolve(
      (async function* () {
        await Promise.resolve();
        yield data;
      })(),
    );
  }

  listMetadata(query?: ArtifactMetadataQuery): Promise<readonly ArtifactMetadata[]> {
    void query;
    return Promise.resolve([...this.values.values()].map((entry) => entry.metadata));
  }

  text(artifactId: string): string {
    const value = this.values.get(artifactId);
    if (value === undefined) {
      throw new Error("missing artifact");
    }
    return value.data.toString("utf8");
  }
}
