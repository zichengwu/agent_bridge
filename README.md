# Agent Bridge

Agent Bridge 是运行在开发者本机的单用户、单机协作控制层，用于在 Codex 与可替换的 Code Agent 之间传递结构化任务、执行事件和可验证产物。

它不共享 Agent 的完整聊天记录或内部思考，而是通过版本化任务合同、Session 绑定、权限策略、独立 Git worktree 和结构化 Handoff，让不同 Agent 在明确边界内协作。Codex 负责需求、架构、审查和最终集成；受管 Code Agent 负责开发、测试、审查、文档或研究等执行任务；Git 与可重复验证命令作为代码和质量结果的权威来源。

当前仓库处于 MVP 开发阶段，已经具备领域内核、正式 Agent Driver 和受监督 Worker Runtime，但还没有可供最终用户调用的完整 MCP 或 CLI 产品入口。

## 当前能力

- **版本化领域合同**：Task、TaskVersion、Agent Run、Session Binding、Context、Handoff、Continuation Snapshot 和 Task Result Schema。
- **确定状态与审计边界**：任务、Run 和 Session 生命周期，权威领域事件、审计信息、幂等写入合同与内存 Repository。
- **供应商无关 Driver Protocol**：统一能力声明、事件、权限、取消、结果、用量和恢复状态，并提供严格的 JSONL/stdin-stdout 传输边界。
- **正式 Agent Driver**：OpenCode `1.18.3` 为 MVP 主 Driver；Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 为降级 Driver。
- **受监督 Worker Runtime**：Driver 子进程启动、监控、超时、取消、退出码、输出限制和进程树清理。
- **固定角色策略**：Coordinator、Developer、Tester、Reviewer、Docs 和 Research 的 Prompt、逻辑模型档位、工具权限与路径权限；Reviewer 和 Coordinator 默认只读，Tester 不得修改产品代码。
- **Git/worktree 隔离**：分支与 worktree 创建、base commit 校验、写入所有权、租约冲突、diff 越权校验，以及路径穿越和符号链接逃逸防护。
- **恢复决策**：Bridge 可根据现有领域合同、Driver 能力、Session、租约和 Git 事实判断一个未完成 Run 应恢复还是失败。

## 尚未完成的产品边界

- SQLite Repository、事务性 Outbox、Artifact Repository、事件持久化和观察端扇出尚未实现。
- 运行期 Context/Handoff 组装、独立验收执行、正式 Driver 降级编排和最终配置迁移尚未实现。
- Bridge 重启后的正式 Driver 端到端恢复尚未完成；当前只提供进程监督、Driver checkpoint 和恢复决策。
- MCP stdio、管理 CLI、HTTP API 和图形界面尚未实现。
- MVP 只面向本地单用户、单机环境，不支持跨机器 Worker、多租户或云端控制面。
- Bridge 不自动合并 `main`，最终集成仍由 Codex 或用户确认执行。

## 架构与包职责

Bridge Core 只依赖版本化 Driver Protocol，不直接依赖 OpenCode、Claude 或其他具体 Agent SDK。

| 路径                           | 职责                                                             | 当前状态                        |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------------- |
| `packages/schemas`             | 领域 Schema、解析和版本合同                                      | 已实现                          |
| `packages/core`                | 状态机、Session、Context/Handoff 策略、Repository 和领域事件     | 已实现；当前提供内存 Repository |
| `packages/driver-protocol`     | Agent Driver Contract、运行时断言和 JSONL/stdin-stdout Transport | 已实现                          |
| `packages/driver-opencode`     | OpenCode 主 Driver 和独立 Worker 入口                            | 已实现                          |
| `packages/driver-claude-agent` | Claude Agent SDK 降级 Driver 和独立 Worker 入口                  | 已实现                          |
| `packages/worker-runtime`      | 进程监督、角色权限、路径策略、Git/worktree、租约和恢复决策       | 已实现                          |
| `packages/storage-sqlite`      | SQLite Repository 与 Outbox                                      | 包骨架                          |
| `packages/artifacts-local`     | 本地产物存储                                                     | 包骨架                          |
| `packages/observability`       | 事件观察与诊断                                                   | 包骨架                          |
| `apps/bridge-mcp`              | Codex 面向 Bridge 的 MCP stdio 接口                              | 应用骨架                        |

## 环境要求

- Node.js 22 或更高版本
- pnpm 11.9.0
- Git

## 开发与验证

安装锁文件指定的依赖并运行完整质量门禁：

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` 依次检查格式、ESLint、TypeScript、全部 Vitest 测试和构建。默认验证不读取真实 Agent 配置，不调用真实模型，也不产生模型费用。

两个正式 Driver 的 B-simulated 回归可以单独运行：

```bash
pnpm test:driver-opencode:b-simulated
pnpm test:driver-claude-agent:b-simulated
```

B-simulated 使用临时隔离环境、一次性 Git worktree、合成 Token 和仅监听 `127.0.0.1` 的模拟 Provider，用于验证正式 Driver 的 Session、权限、取消、恢复、Git 和清理边界；它不等同于真实 Provider 验证。

任何真实 Provider 验证都必须单独获得费用与凭据授权。OpenCode 与 Claude Agent SDK 当前共用 DeepSeek，因此只提供 Driver 级降级，不构成 Provider 级灾备。

## 文档

- [产品需求与验收基线](docs/prd/agent-bridge-prd.md)
- [MVP Agent Driver 选型 ADR](docs/adr/0001-agent-driver-selection.md)
- [Cline SDK/Hub 历史 Spike](docs/spikes/cline-sdk-hub.md)

产品行为以 PRD 和版本化领域合同为准；架构决策以 ADR 为准；Spike 文档只保留历史技术证据，不代表当前主执行路径。
