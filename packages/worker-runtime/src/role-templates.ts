import type { AgentRole } from "@agent-bridge/schemas";

import { WorkerRuntimeError } from "./errors.js";

export type RoleModelProfile =
  "coordination" | "coding" | "testing" | "review" | "docs" | "research";

export type PolicyDecision = "allow" | "approval" | "deny";

export type WorkerToolKind =
  | "filesystem.read"
  | "filesystem.write"
  | "search"
  | "git.status"
  | "git.diff"
  | "process.execute"
  | "network.access"
  | "tool.use";

export type WritablePathKind = "product" | "test" | "docs" | "unknown";

export interface RoleTemplate {
  readonly role: AgentRole;
  readonly prompt: string;
  readonly modelProfile: RoleModelProfile;
  readonly tools: Readonly<Record<WorkerToolKind, PolicyDecision>>;
  readonly writablePathKinds: readonly WritablePathKind[];
}

const READ_ONLY_TOOLS: Readonly<Record<WorkerToolKind, PolicyDecision>> = {
  "filesystem.read": "allow",
  "filesystem.write": "deny",
  search: "allow",
  "git.status": "allow",
  "git.diff": "allow",
  "process.execute": "deny",
  "network.access": "deny",
  "tool.use": "deny",
};

export const ROLE_TEMPLATES: Readonly<Record<AgentRole, RoleTemplate>> = Object.freeze({
  coordinator: template({
    role: "coordinator",
    prompt: "负责执行层协调、状态检查和风险汇总；不得修改代码、测试或任务合同。",
    modelProfile: "coordination",
    tools: READ_ONLY_TOOLS,
    writablePathKinds: [],
  }),
  developer: template({
    role: "developer",
    prompt: "仅在任务合同允许的路径内实现产品代码和必要测试；不得扩大范围或绕过验证。",
    modelProfile: "coding",
    tools: {
      ...READ_ONLY_TOOLS,
      "filesystem.write": "allow",
      "process.execute": "allow",
      "tool.use": "approval",
    },
    writablePathKinds: ["product", "test", "docs"],
  }),
  tester: template({
    role: "tester",
    prompt: "编写并执行测试，只能修改测试类文件；不得通过修改产品代码让测试通过。",
    modelProfile: "testing",
    tools: {
      ...READ_ONLY_TOOLS,
      "filesystem.write": "allow",
      "process.execute": "allow",
    },
    writablePathKinds: ["test"],
  }),
  reviewer: template({
    role: "reviewer",
    prompt: "进行只读审查并输出结构化 finding；不得直接修复代码或执行写入命令。",
    modelProfile: "review",
    tools: READ_ONLY_TOOLS,
    writablePathKinds: [],
  }),
  docs: template({
    role: "docs",
    prompt: "只维护任务合同明确允许的文档，并执行文档检查；不得修改产品代码。",
    modelProfile: "docs",
    tools: {
      ...READ_ONLY_TOOLS,
      "filesystem.write": "allow",
      "process.execute": "allow",
    },
    writablePathKinds: ["docs"],
  }),
  research: template({
    role: "research",
    prompt: "进行只读资料检索并提供可追溯结论；不得修改工作区，网络访问必须审批。",
    modelProfile: "research",
    tools: {
      ...READ_ONLY_TOOLS,
      "network.access": "approval",
    },
    writablePathKinds: [],
  }),
});

export function getRoleTemplate(role: AgentRole): RoleTemplate {
  const selected = ROLE_TEMPLATES[role];
  if (selected === undefined) {
    throw new WorkerRuntimeError("ROLE_TEMPLATE_INVALID", "Worker role template is unknown");
  }
  return selected;
}

export function evaluateRoleTool(role: AgentRole, tool: WorkerToolKind): PolicyDecision {
  return getRoleTemplate(role).tools[tool] ?? "deny";
}

export function assertRoleCanWritePath(role: AgentRole, kind: WritablePathKind): void {
  if (!getRoleTemplate(role).writablePathKinds.includes(kind)) {
    throw new WorkerRuntimeError("ROLE_POLICY_DENIED", "Worker role cannot write this path kind", {
      role,
      path_kind: kind,
    });
  }
}

function template(value: RoleTemplate): RoleTemplate {
  return Object.freeze({
    ...value,
    tools: Object.freeze({ ...value.tools }),
    writablePathKinds: Object.freeze([...value.writablePathKinds]),
  });
}
