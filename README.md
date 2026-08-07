# Agent Bridge

Agent Bridge 是运行在开发者本机的单用户、单机协作控制层，用于在 Codex 与可替换的 Code Agent 之间传递结构化任务、执行事件和可验证产物。

它不共享 Agent 的完整聊天记录或内部思考，而是通过版本化任务合同、Session 绑定、权限策略、独立 Git worktree 和结构化 Handoff，让不同 Agent 在明确边界内协作。Codex 负责需求、架构、审查和最终集成；受管 Code Agent 负责开发、测试、审查、文档或研究等执行任务；Git 与可重复验证命令作为代码和质量结果的权威来源。

当前仓库处于 MVP 开发阶段，已经具备领域内核、正式 Agent Driver、受监督 Worker Runtime 和本地 MCP stdio 控制入口。

## 当前能力

- **版本化领域合同**：Task、TaskVersion、Agent Run、Session Binding、Context、Handoff、Continuation Snapshot 和 Task Result Schema。
- **确定状态与审计边界**：任务、Run 和 Session 生命周期，权威领域事件、审计信息、幂等写入合同与内存 Repository。
- **供应商无关 Driver Protocol**：统一能力声明、事件、权限、取消、结果、用量和恢复状态，并提供严格的 JSONL/stdin-stdout 传输边界。
- **正式 Agent Driver**：OpenCode `1.18.3` 为 MVP 主 Driver；Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 为降级 Driver。
- **受监督 Worker Runtime**：Driver 子进程启动、监控、超时、取消、退出码、输出限制和进程树清理。
- **固定角色策略**：Coordinator、Developer、Tester、Reviewer、Docs 和 Research 的 Prompt、逻辑模型档位、工具权限与路径权限；Reviewer 和 Coordinator 默认只读，Tester 不得修改产品代码。
- **Git/worktree 隔离**：分支与 worktree 创建、base commit 校验、写入所有权、租约冲突、diff 越权校验，以及路径穿越和符号链接逃逸防护。
- **恢复决策**：Bridge 可根据现有领域合同、Driver 能力、Session、租约和 Git 事实判断一个未完成 Run 应恢复还是失败。
- **SQLite 持久化与 Outbox**：领域状态、权威事件、幂等结果、Artifact 引用和待发布事件在同一事务提交；支持严格顺序、失败重试、租约回收和按 `event_id` 安全重放。
- **本地 Artifact Repository**：内容寻址、SHA-256 校验、原子写入、去重、路径与符号链接防护，以及不执行删除的孤儿清理预览。
- **持久事件观察**：观察端从权威事件游标独立读取历史与后续事件；异常、断开或慢消费者不会终止任务或影响其他观察端。
- **供应商中立可观测接口**：提供结构化日志与 Trace/Span 抽象，不绑定具体日志、OpenTelemetry SDK 或云端后端。
- **运行期 Context 与 Handoff**：从 Repository、Git 和验证 Artifact 的权威事实组装 Context，并生成确定、可校验且经过敏感信息扫描的 Handoff。
- **独立验收执行**：只执行严格配置的命令合同；Tester 可请求、Reviewer 不可触发，支持超时、取消、进程树清理、输出脱敏和 Artifact 归档。
- **显式 Driver 降级**：OpenCode 不健康或新 Run 启动失败时，只有能力检查通过并获得显式确认，才为一个新的 Run 选择 Claude；不会切换正在运行的任务。
- **严格运行时配置**：无凭据配置只接受 OpenCode 主 Driver、Claude 降级 Driver 和独立验证命令目录；拒绝未知字段、历史 Cline 字段及凭据类字段。
- **MCP stdio 控制接口**：提供任务/版本、关系、Context、启动、查询、反馈、审批、滚动、取消和完成工具；所有调用写入 SQLite 审计记录。
- **有限审批与返工闭环**：Driver 权限请求绑定当前 Run/Session，结构化 finding 绑定当前 commit，同一任务版本最多返工三轮；Bridge 重启后保留审批、返工和观察事实，但不会盲目重放 Driver 副作用。

## 尚未完成的产品边界

- Bridge 重启后的正式 Driver 端到端恢复尚未完成；当前只提供进程监督、Driver checkpoint 和恢复决策。
- Artifact 自动保留期清理、磁盘配额和内容 tombstone 尚未实现；当前只清理失败/过期临时文件并提供孤儿候选预览。
- 管理 CLI、HTTP API 和图形界面尚未实现；MCP 当前只支持本地 stdio。
- MVP 只面向本地单用户、单机环境，不支持跨机器 Worker、多租户或云端控制面。
- Bridge 不自动合并 `main`，最终集成仍由 Codex 或用户确认执行。

## 架构与包职责

Bridge Core 只依赖版本化 Driver Protocol，不直接依赖 OpenCode、Claude 或其他具体 Agent SDK。

| 路径                           | 职责                                                             | 当前状态 |
| ------------------------------ | ---------------------------------------------------------------- | -------- |
| `packages/schemas`             | 领域 Schema、解析和版本合同                                      | 已实现   |
| `packages/core`                | 状态机、Session、Context/Handoff 策略、Repository 和领域事件     | 已实现   |
| `packages/driver-protocol`     | Agent Driver Contract、运行时断言和 JSONL/stdin-stdout Transport | 已实现   |
| `packages/driver-opencode`     | OpenCode 主 Driver 和独立 Worker 入口                            | 已实现   |
| `packages/driver-claude-agent` | Claude Agent SDK 降级 Driver 和独立 Worker 入口                  | 已实现   |
| `packages/worker-runtime`      | Context/Handoff、验收、Driver 选择、Run 编排、Git 与恢复策略     | 已实现   |
| `packages/storage-sqlite`      | SQLite Repository、Artifact 引用索引与事务性 Outbox              | 已实现   |
| `packages/artifacts-local`     | 本地产物存储、完整性和安全清理基础                               | 已实现   |
| `packages/observability`       | 持久事件观察、结构化日志与遥测抽象                               | 已实现   |
| `apps/bridge-mcp`              | Codex 面向 Bridge 的 MCP stdio 接口                              | 已实现   |

## 环境要求

- Node.js 22.13.0 或更高版本（使用内置 `node:sqlite`）
- pnpm 11.9.0
- Git

## 开发与验证

安装锁文件指定的依赖并运行完整质量门禁：

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` 依次检查格式、ESLint、TypeScript、全部 Vitest 测试和构建。默认验证不读取真实 Agent 配置，不调用真实模型，也不产生模型费用。

先复制并修改严格配置与项目基线示例，再启动本地 MCP stdio Server：

```bash
pnpm build
pnpm bridge:mcp -- --config /absolute/path/to/agent-bridge.yaml
```

配置必须包含绝对的 `project.project_baseline_path`。MCP 的 stdout 专用于协议帧；启动和稳定错误只写 stderr。运行状态、审批、返工轮次、Context 和控制调用审计保存在 `project.runtime_root/agent-bridge.sqlite`，因此 UI/IDE 不可用时仍可在下一次 MCP 连接中查询。

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
