# PRD：Agent Bridge——Codex 与 Code Agent 协作控制层

## 0. 文档状态

- PRD 标识：`PRD-AGENT-BRIDGE-001`
- 版本：`v1.8`
- 状态：Phase 4.1 已完成；Phase 4.2 产品、原型与技术安全合同均已收口，研发就绪但尚未授权实现
- 文档深度：完整 PRD
- 负责人：待指定
- 最近更新：2026-08-11
- 目标版本：MVP
- 基线或关联提交：暂无
- 替代版本：`v1.7`
- 关联原型：[`docs/prototypes/phase-4-2-dashboard/dashboard-prototype-v2.html`](../prototypes/phase-4-2-dashboard/dashboard-prototype-v2.html)，已完成核心流程验证
- 本次主要变更：关闭 OQ-006；接受 ADR-0003、内部 HTTP/JSON + SSE v1 合同与 Contract 测试矩阵，冻结本地管理页技术栈、localhost 安全、事件恢复、并发写入和实现门禁

### 0.1 来源状态说明

- **已确认**：用户已明确表达或确认。
- **已决策**：用户接受的前序方案结论。
- **候选建议**：为形成可执行方案提出，但尚未由用户确认。
- **开放问题**：答案会改变实现或验收，目前尚未确认。

### 0.2 需求认知面板

- 目标用户：使用 Codex 与一个或多个 Code Agent 共同开发软件的单一开发者。
- 核心场景：由 Codex 负责项目级规划、审查和集成，由受管 Code Agent 完成开发、测试、审查等执行任务。
- 当前做法：Codex 与各类 Code Agent 是独立工具，默认不共享会话、任务状态、权限和工作区。
- 主要问题：缺少中立控制层，导致信息难以结构化传递，业务约束可能漂移；不同需求长期复用同一对话还会造成上下文污染，而强制切换窗口又可能丢失关联任务的必要成果。
- 期望结果：通过独立 Agent Bridge 建立可审计、可隔离、可恢复、可验证的协作流程，并通过统一管理面降低任务管理、进度观察、审批处理和异常定位成本。
- 已确认事实：需要独立 Agent Bridge；MVP 采用本地、单用户、单机部署；技术栈采用 Node.js 22+、TypeScript 和 pnpm monorepo；Bridge Core 只依赖版本化 Agent Driver 协议；OpenCode `1.18.3` 为 MVP 主 Driver，Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 为 MVP 降级 Driver；OQ-004 全部规则已定稿；不同需求使用独立 Agent Session，相关需求通过结构化摘要传递必要信息；Phase 4.2 首版采用由项目命令或 Codex 启动并自动打开浏览器的本地 Web 管理页，不提供用户侧通用管理 CLI，也不在页面创建任务；OQ-006 已关闭，首版采用原生 TypeScript/HTML/CSS、Node.js 22 内置 HTTP 与 SSE，不新增外部运行时依赖。
- 合理推断：MVP 主要面向个人开发环境，而不是团队级云平台。
- 已验证事实：OpenCode 与 Claude Agent SDK 均已通过 A 层、B-simulated 和 B-real 的适用 Session、事件、取消、权限、恢复、隔离、结果、用量和清理硬门禁；精确上下文用量等增强能力仍允许由 Bridge 估算或持久化机制补偿，但稳定 Session、确定取消和安全隔离不得静默降级。
- 待验证假设：后续 Provider 级灾备可以在不改变 Driver Protocol 和领域核心的前提下接入；当前 OpenCode 与 Claude Agent SDK 共用 DeepSeek，只提供 Driver 级降级。
- 开放问题：仅 OQ-003“GitHub 是否进入 MVP”继续作为非阻塞问题；Phase 4.2 不再存在阻塞研发的产品或技术开放问题。

当前判断：

- 当前阶段：Phase 4.1 已完成；Phase 4.2 的产品规则、可操作原型和技术安全合同均已完成，达到研发就绪；具体 Driver 继续保持进程外隔离和协议边界。
- 目标交付与 PRD 深度：完整 PRD。
- 最大实施风险：现有 deny/retry/cleanup/usage 应用层缺口必须先按 ADR-0003 修正；页面不得自行补偿或旁路状态机。
- 下一步：在单独获得实现授权后，按测试矩阵 Slice A 至 E 推进；技术合同确认不自动授权安装依赖、真实 Provider、提交、推送或 PR。

## 1. 执行摘要

Agent Bridge 是运行在开发者本机的单用户、单机协作控制层。它位于 Codex 与可替换的 Code Agent 之间，通过结构化任务合同、任务状态机、需求级 Session 隔离、版本化 Handoff、权限策略、独立 Git worktree、执行事件和验证产物，实现不同 Agent 工具之间的可靠协作。

Codex 负责需求、架构、任务合同、最终审查与集成；受管 Code Agent 负责 Developer、Tester、Reviewer 等执行角色；Agent Bridge 负责双方之间的 Harness 控制、任务状态、隔离、权限、超时、取消、审计和结果传递；Git 与 CI/本地验证命令作为代码和质量结果的权威来源。

系统不共享 Codex 与受管 Code Agent 的完整聊天记录，不传递模型内部思考，不允许执行 Agent 反向调用 Codex 形成循环。新需求继承经过筛选且可追溯的事实、接口和成果，而不是继承上一个需求的对话历史。

## 2. 背景与问题定义

### 2.1 原始需求输入

用户最初希望组合 Codex 和 Cline 完成项目开发，并让不同 Agent 承担开发、测试、代码审查、协调等角色。Cline SDK/Hub 技术 Spike 随后证明当前发布版本不能满足主路径门禁，因此产品目标被提升为连接 Codex 与可替换 Code Agent，而不是绑定某个具体工具。用户进一步指出：同一需求的多轮修改适合延续上下文，但不同需求长期放在同一对话会互相干扰；新需求应独立启动，同时相关任务需要继承上一任务完成后的必要概要信息。

### 2.2 问题陈述

> 对于同时使用 Codex 与 Code Agent 的开发者，在组织多 Agent 完成软件项目时，由于不同工具缺少共享的任务协议、状态、权限和工作区控制，难以安全地完成任务交接、并行执行、结果审查和失败恢复，可能导致上下文漂移、代码冲突、权限越界、成本失控和错误合并。

### 2.3 影响

- Agent 交付依赖自然语言聊天，难以稳定解析和审计。
- 业务规则可能只存在于某一方的 Prompt 中，另一方无法可靠获取。
- 两个写入型 Agent 可能修改同一分支或文件。
- Agent 自述“完成”或“测试通过”缺少独立验证。
- 工具调用、模型凭据和高风险命令缺少统一控制。
- 失败、超时、取消和重试没有权威状态机。
- 不同需求复用同一对话会引入无关指令和陈旧假设；完全切断上下文又会丢失已完成接口、架构决策和验证结果。

## 3. 用户与利益相关者

### 3.1 核心用户

- 本期核心用户：在一台开发机上使用 Codex 与受管 Code Agent 的单一开发者。
- 次要用户：后续接入更多 Agent 工具或远程 Worker 的开发者。
- 本期不覆盖：多人团队、组织管理员、云端 Worker 运维人员。

### 3.2 关键角色

- 人类负责人：批准高风险操作，决定最终发布。
- Codex Coordinator：需求澄清、架构、任务合同和项目级协调。
- Codex Integrator：最终审查、冲突处理、回归和集成。
- Agent Bridge：控制面和权威任务状态源。
- Execution Coordinator：执行层任务拆分与角色调度；只有 Driver 声明支持时启用。
- Developer Agent：指定范围内的产品代码开发。
- Tester Agent：测试开发和执行，不修改产品代码。
- Reviewer Agent：只读审查，不直接修复代码。
- Git：代码版本权威来源。
- CI 或 Bridge Verification：可重复质量门禁。

## 4. 产品目标与成功衡量

### 4.1 产品目标

1. Codex 能以结构化接口创建、启动、查询、反馈和取消受管 Agent 任务。
2. 每个写入任务在独立分支和 worktree 中执行。
3. 业务规则、范围、权限和验收命令随任务合同传递并可追溯。
4. Bridge 独立验证 Agent 产物，而不是依赖 Agent 自述。
5. 任一任务均可追溯到输入版本、执行角色、模型、事件、commit 和验证结果。
6. 失败、取消、超时、重启和返工有确定的恢复路径。
7. 不同需求在独立 Agent Session 中执行，相关任务通过版本化交接包传递最小必要上下文。
8. 同一需求上下文接近上限时能够生成检查点并滚动到新 Session，且不中断任务追溯关系。

### 4.2 非目标

- 不开发云端、团队级或多租户 Web 管理后台；Phase 4.2 仅提供本地单用户管理页。
- 不开发账号、登录、组织和多租户体系。
- 不支持跨机器或分布式 Worker。
- 不自动部署生产环境。
- 不自动合并 `main`。
- 不让 Codex 与受管 Code Agent 共享完整会话或内部思考。
- 不以 Codex、IDE 或具体 Agent 的可见 UI 窗口作为任务隔离和状态判断的权威来源。
- 不允许执行 Agent 反向调用 Codex 形成循环编排。
- MVP 不同时正式支持全部 Code Agent 产品，只实现一个主 Driver 和一个降级 Driver。

### 4.3 成功指标

| 指标 | 状态 | 来源 | 定义 | MVP 目标 | 数据来源 |
|---|---|---|---|---|---|
| 任务可追溯率 | 候选建议 | 产品分析 | 可关联任务版本、run、commit、验证结果的任务比例 | 100% | Bridge 存储与审计日志 |
| 越权写入放行数 | 候选建议 | 安全护栏 | 越权修改仍进入待合并状态的次数 | 0 | Git diff 校验事件 |
| 重复执行数 | 候选建议 | 幂等要求 | 同一幂等键产生多个并行写 run 的次数 | 0 | Run 与租约记录 |
| 敏感信息泄漏数 | 候选建议 | 安全护栏 | 凭据出现在任务、结果或普通日志中的次数 | 0 | 脱敏测试和日志扫描 |

上述成功指标为非阻塞候选运营指标，不改变 MVP 功能行为和验收基线；首个可运行版本产出数据后再建立实际基线。

## 5. 方案与决策

### 5.1 方案比较

| 方案 | 价值 | 复杂度 | 主要风险 | 结论 |
|---|---|---|---|---|
| 仅人工复制 Prompt | 低成本 | 低 | 不可审计、易漂移、无法自动隔离 | 不采用 |
| 仅通过 GitHub Issue/PR 协作 | 有审计能力 | 中 | 本地进程、权限、超时仍无人控制 | 可作为外部协作补充 |
| 本地 Agent Bridge | 结构化控制、隔离和恢复 | 中 | 需要开发适配器和状态机 | MVP 采用 |
| 云端多租户控制平台 | 可支持团队和远程 Worker | 高 | 范围过大、运维和安全复杂 | 后续评估 |

### 5.2 已确认方案

MVP 采用本地、单用户、单机 Agent Bridge：

```text
用户
  ↓
Codex
项目级 Coordinator / Architect / Final Reviewer / Integrator
  ↓
Agent Bridge
任务协议 / 状态机 / 权限 / 隔离 / 审计 / 超时 / 产物传递
  ↓
OpenCode 主 Driver / Claude Agent SDK 降级 Driver
  ↓
Execution Coordinator（可选能力）
  ├── Developer
  ├── Tester
  ├── Reviewer
  └── Docs / Research
  ↓
Git + CI 或本地验证
```

### 5.3 部署定义

- **本地运行**：Bridge、任务状态、日志和 worktree 位于开发者电脑；允许访问模型 API、Git 远程和依赖源。
- **单用户**：只服务一个操作者，不开发账号、RBAC 和租户隔离；不限制 Agent 数量。
- **单机运行**：Codex、Bridge、受管 Code Agent 和 Git 工作区位于同一台电脑，不调度远程 Worker。

### 5.4 已确认技术架构

#### 技术栈

| 层级 | MVP 已决策方案 | 后续演进方向 |
|---|---|---|
| 语言与运行时 | Node.js 22+、TypeScript | 核心继续使用 TypeScript；特殊 Worker 可独立使用 Go/Rust |
| 工程组织 | pnpm monorepo | 保持包边界和独立发布能力 |
| Codex 接口 | MCP stdio | Streamable HTTP MCP 与远程认证 |
| 管理接口 | MCP stdio；只读 preflight/content-hash 启动辅助入口；Phase 4.2 提供本地单用户 Web 管理页及其内部 localhost HTTP/JSON + SSE 接口，保留内部启动/诊断命令 | 需要桌面封装时可评估 Tauri；公网或团队部署时再评估 API Gateway、OIDC 和团队权限 |
| Agent Driver | 版本化 JSON Schema；本地 JSON-RPC/JSONL over stdio | WebSocket 或 gRPC 远程 Worker 协议 |
| Agent 接入 | OpenCode 主 Driver + Claude Agent SDK 降级 Driver；具体 SDK、Server 或 CLI 只存在于独立 Driver 子进程 | 远程 Driver、更多 Provider 与独立 Worker 服务 |
| 本地存储 | SQLite，通过 Repository 接口访问 | PostgreSQL |
| 事件投递 | 进程内 Dispatcher + 持久化 Outbox | NATS JetStream 或等效消息系统 |
| Artifact | 本地文件系统 | S3 兼容对象存储 |
| 执行隔离 | Git worktree + 独立子进程 | OCI 容器、Kubernetes Job |
| 可观测性 | 结构化 JSON 日志和 OpenTelemetry 接口 | 集中式 Trace、Metric、Log |
| Schema | JSON Schema + 运行时校验 | 保持协议版本兼容 |
| 测试 | Vitest、假 Driver、临时 Git 仓库 E2E | 容器化和多 Worker E2E |

#### 核心边界

```text
agent-bridge monorepo
├── bridge-core            # 任务、状态机、策略和调度；不得依赖具体 Agent SDK
├── bridge-mcp             # Codex 控制接口
├── driver-protocol        # Agent 能力和生命周期协议
├── driver-opencode        # OpenCode 主 Driver，独立子进程
├── driver-claude-agent    # Claude Agent SDK 降级 Driver，独立子进程
├── worker-runtime         # worktree、进程、超时、取消和权限隔离
└── storage                # SQLite、Outbox 和 Artifact 索引
```

#### Driver 运行模式

```text
Agent Bridge
  ↓ Driver Protocol
OpenCode 主 Driver 或 Claude Agent SDK 降级 Driver（独立子进程）
  ↓ SDK / local server / structured CLI
Code Agent Runtime
  └── Agent Loop、工具调用和 Session 状态
```

- OpenCode 主 Driver 与 Claude Agent SDK 降级 Driver 已通过统一 Spike 硬门禁；其 SDK 只能成为对应 Driver 包的运行依赖，不得进入 Bridge Core。
- Bridge 负责 Driver 子进程生命周期、事件持久化、权限决策、超时和取消；具体 Agent UI 或 IDE 插件不是执行依赖。
- Driver 必须声明 Session、恢复、事件、取消、权限、使用量和分叉等能力；Bridge 不得根据产品名称猜测能力。
- 多观察端由 Bridge 基于权威事件日志提供扇出；上游 Agent 原生多客户端只作为非阻塞增强项。
- 单元和集成测试默认使用 Fake Driver；候选的真实 SDK/Server 只在兼容性测试和显式授权的 Provider 测试中运行。
- 未来云端环境使用远程 Worker Driver；不得要求领域核心理解某个候选的本地 Session 或 Hub 语义。

#### Agent Driver 协议

Bridge Core 只能依赖统一 Driver 接口，不能直接导入任何具体 Agent SDK。Driver 至少提供以下能力：

```ts
interface AgentDriver {
  describeCapabilities(): Promise<AgentCapabilities>
  prepareTask(task: TaskContract): Promise<PreparedTask>
  startTask(task: PreparedTask, context: ContextPackage): Promise<RunHandle>
  streamEvents(runId: string): AsyncIterable<AgentEvent>
  getContextUsage(sessionId: string): Promise<ContextUsage>
  createSuccessorSession(runId: string, predecessorSessionId: string, context: ContextPackage): Promise<SessionHandle>
  sendFeedback(runId: string, feedback: ReviewFeedback): Promise<void>
  cancelTask(runId: string, reason: string): Promise<void>
  collectResult(runId: string): Promise<AgentResult>
  healthCheck(): Promise<HealthStatus>
}
```

Driver 必须返回可持久化的外部 Session ID，并声明是否支持精确上下文用量、Session 恢复和 Session 滚动；不支持精确用量时由 Bridge 根据已记录输入输出估算，但 Driver 仍必须支持创建后继 Session。Bridge 不得把 Session 隔离降级为 Prompt 约定。

本地 Driver 使用 stdio 传输，协议对象保持传输无关。未来跨机调度时替换传输层，不修改任务合同、状态机、Session 绑定和 Driver 语义。

#### 面向云端的演进约束

- 存储必须通过 Repository 接口访问，不允许领域服务直接依赖 SQLite 实现。
- 状态更新与待发送事件使用事务性 Outbox，消费者根据 `event_id` 幂等处理。
- 本地文件 Artifact 通过 Artifact Repository 管理，业务逻辑不依赖绝对文件路径。
- Agent Driver 必须进程外隔离，后续可平移为远程 Worker。
- MCP 是 Codex 面向 Bridge 的控制接口，不作为 Bridge 内部 Worker 协议。
- MVP 不引入 PostgreSQL、NATS、Kubernetes 和对象存储服务，但接口边界必须允许后续替换。

## 6. MVP 范围

### 6.1 Must

- 单项目任务管理。
- 任务合同和结果 JSON Schema。
- 任务状态机与事件日志。
- Codex 控制接口。
- OpenCode `1.18.3` 主 Agent Driver。
- 固定角色模板。
- Git 分支和 worktree 隔离。
- 路径和工具权限策略。
- 进程启动、监控、超时和取消。
- 结构化反馈和返工。
- 需求级 Agent Session 隔离与绑定校验。
- 同一需求的上下文检查点和 Session 滚动。
- Project Baseline、TaskContract 与版本化 Handoff 的最小上下文组装。
- 任务关系图及关联交接包选择。
- 独立验收命令执行。
- 本地持久化与崩溃恢复。
- Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 降级 Driver；降级组件缺失不得阻塞主 Driver 健康检查和运行。
- 单元测试、集成测试和临时 Git 仓库端到端测试。

### 6.2 后续范围

- GitHub Issue、PR 和 Actions 深度集成。
- 可视化任务看板。
- 跨机器 Worker。
- 多用户和组织级权限。
- 更多 Agent 适配器。
- 成本预算、配额和报表。

### 6.3 明确不做

- 自动发布和自动合并主分支。
- 任意 Agent 间自由互调。
- 将模型 API Key 存入任务数据库。
- 将完整 Agent 会话作为协作协议。
- 让新需求隐式继承上一需求的完整聊天记录或全部历史 Handoff。
- 由执行 Agent 修改 Codex 定义的业务规则或验收标准。

## 7. 端到端流程

### 7.1 创建与执行

1. Codex 生成结构化任务合同。
2. Bridge 校验 Schema、Git 仓库、base commit、角色、范围和命令策略。
3. Bridge 将任务置为 `VALIDATED`。
4. Codex 或用户批准启动任务。
5. Bridge 获取写入租约，创建任务分支和独立 worktree。
6. Bridge 按角色模板和能力声明启动选定 Driver 中的执行 Agent。
7. 执行 Agent 在限定工作区内执行并报告事件。
8. 执行 Agent 提交 commit 和标准化结果。
9. Bridge 检查 Git diff 是否越权，并独立执行验收命令。
10. Bridge 将结果转为 `REVIEW_REQUIRED`，交给 Codex。
11. Codex选择批准、提交结构化修改意见或取消。
12. 通过审查后进入 `READY_FOR_MERGE`；最终集成由 Codex 或用户执行。

### 7.2 返工

1. Codex 提交带文件、位置、严重级别和期望行为的 finding。
2. Bridge 校验 task version、run 和 commit。
3. Bridge 增加审查轮次，将状态置为 `CHANGES_REQUESTED`。
4. 执行 Agent 在原任务分支继续修改。
5. Bridge 对新 commit 重新执行全部验证。
6. 超过最大审查轮次后停止自动循环，等待用户决定。

### 7.3 失败与恢复

- Driver 或 Agent 异常退出：记录退出码和错误；仅 Provider 瞬时错误可在单次 run 内有限重试，整个 Agent 任务不自动重跑。
- Bridge 重启：运行中任务标为 `INTERRUPTED`，不得自动判定成功。
- base commit 过期：拒绝启动或要求重新建立基线。
- worktree 越权修改：任务失败，不进入待合并状态。
- 验收失败：保存日志并进入审查或失败状态。
- 用户取消：终止子进程，保留日志、事件和已有 Git 产物。

### 7.4 新需求隔离与关联任务交接

1. Codex 或用户判断输入属于同一 `TaskVersion` 的实现返工、新 `TaskVersion`，还是新的 `Task`。
2. Bridge 对新 `Task` 或新 `TaskVersion` 强制创建新的 Agent Session；不得把旧 Session 重新绑定到新需求。
3. Coordinator 为相关任务声明 `depends_on`、`related_to`、`supersedes` 或 `follow_up_of` 关系，并显式选择允许注入的 Handoff。
4. Bridge 组装 `ProjectBaseline + 当前 TaskContract + 已选 Handoff`，创建可审计的 Context Package 后启动新 Session。
5. 同一 `TaskVersion` 的测试修复和 Review 返工可续用当前 Session；目标、范围、业务规则或验收标准变化时必须创建新版本和新 Session。
6. Bridge 不因任务位于同一项目或修改同一模块而自动复用 Session，也不自动注入所有历史任务。

### 7.5 同一需求的上下文滚动

1. Bridge 在每次向 Agent 发送下一轮输入前读取 Driver 上报的上下文使用量；无法直接上报时，根据已记录输入输出进行估算。
2. 当使用量达到该 Session 上下文窗口的 70% 时，Bridge 在当前工具调用或原子步骤结束后的安全边界生成 `ContinuationSnapshot`。
3. Bridge 将旧 Session 标记为 `SUPERSEDED`，在同一 `TaskVersion` 和 `AgentRun` 下创建新 Session，并只注入 Project Baseline、当前任务合同、最新检查点和仍有效的已选 Handoff。
4. 新 Session 建立并记录审计事件后继续执行；不得把旧 Session 的完整聊天记录复制到新 Session。
5. 如果 Provider 在预期滚动前返回上下文长度错误，Bridge 使用持久化事件、Git 状态和 Artifact 生成降级检查点，执行一次滚动；滚动失败则将 run 标记失败并等待人工处理。

## 8. 角色与权限

| 角色 | 查看 | 写产品代码 | 写测试 | 执行命令 | 合并 | 特殊限制 |
|---|---:|---:|---:|---:|---:|---|
| Codex Coordinator | 是 | 否 | 否 | 只读检查 | 否 | 不直接执行受管 Agent 内部任务 |
| Codex Integrator | 是 | 是 | 是 | 是 | 经用户批准 | 仅在最终集成阶段写入 |
| Bridge | 必要范围 | 管理工作区 | 否 | 策略控制 | 否 | 不做业务决策 |
| Execution Coordinator | 是 | 否 | 否 | 状态检查 | 否 | 不修改任务合同；仅在 Driver 支持时启用 |
| Developer | 是 | 指定目录 | 按任务合同 | 允许列表 | 否 | 一个文件同一时间一个 Owner |
| Tester | 是 | 否 | 指定目录 | 测试命令 | 否 | 不得通过改产品代码让测试通过 |
| Reviewer | 是 | 否 | 否 | 只读检查 | 否 | 只输出 finding |
| Docs | 是 | 否 | 否 | 文档检查 | 否 | 只写文档范围 |

## 9. 功能需求

### FR-001：任务合同

- 状态：已决策
- 来源：用户要求解决两个独立 App 的信息传递和业务约束问题。
- 优先级：Must
- 主要行为：接收、校验、版本化并冻结结构化任务合同；合同包含任务关系、所选 Handoff 和上下文策略。
- 异常：非法 Schema、未知角色、非法路径或缺失 base commit 时拒绝进入 `VALIDATED`。

### FR-002：任务状态机

- 状态：已决策
- 来源：用户要求双方协调逻辑可开发、可交接。
- 优先级：Must
- 主要行为：Bridge 维护权威状态；Agent 只能报告事件，不能直接改状态。

### FR-003：Codex 控制接口

- 状态：已决策
- 来源：Agent Bridge 作为 Codex 与 Code Agent Harness 控制层的既定方向；用户于 2026-07-19 接受 MCP 接入建议。
- 优先级：Must
- 主要行为：支持创建任务和版本、声明关系、准备 Context Package、启动、查询、反馈、Session 滚动、取消和标记完成。
- 接口形态：MVP 使用 MCP stdio；预留 Streamable HTTP MCP 适配器，不在 MVP 启用远程模式。

### FR-004：Agent Driver 执行适配

- 状态：已决策
- 来源：用户于 2026-07-19 确认解除 Cline 唯一主路径绑定并采用统一 Driver Spike 选型；2026-07-22 确认接受 B-real 结果并完成最终选型。
- 优先级：Must
- 主要行为：启动受管 Agent、传递角色和 Context Package、返回稳定 Session ID、接收结构化事件和上下文用量、创建后继 Session、处理权限、取消任务并收集结果。
- 适配方式：具体 SDK、Server、JSONL 或 CLI 接口运行在独立 Driver 子进程；Bridge Core 只依赖版本化 Driver Protocol。
- 选型门禁：候选必须通过安装、Headless、Session、恢复、事件、取消、权限、worktree 隔离、结果、脱敏和可复现性硬门禁；主 Driver 与降级 Driver 在 Spike 报告中确定。
- MVP 实现：OpenCode `1.18.3` 为主 Driver；Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 为降级 Driver；Codex SDK 保留 A 层证据但本轮 B 层延期。
- Provider 边界：MVP 两个 Driver 均使用 DeepSeek V4 Pro，因此只提供 Driver 级降级，不承诺 Provider 级灾备；任何真实 Provider 兼容性测试继续要求逐次费用授权。
- 观察接口：Bridge 持久化权威事件并向观察端扇出；Agent 原生多客户端或 IDE 附着不是 MVP 硬依赖。

### FR-005：角色模板

- 状态：已决策
- 来源：用户希望不同 Agent 承担开发、测试、Reviewer、Coordinator 等角色。
- 优先级：Must
- 主要行为：提供 Coordinator、Developer、Tester、Reviewer、Docs/Research 固定模板；每个模板关联 Prompt、模型、工具和路径权限。

### FR-006：Git 与 worktree 隔离

- 状态：已决策
- 来源：用于满足用户提出的隔离要求；用户于 2026-07-19 接受 worktree + 独立子进程技术方案。
- 优先级：Must
- 主要行为：每个写入任务使用独立分支和 worktree；启动前记录 base commit；完成后检查 diff。

### FR-007：权限策略

- 状态：已决策
- 来源：用户明确要求处理业务约束与隔离。
- 优先级：Must
- 主要行为：按角色显式声明读、写、禁止路径和工具权限；未声明能力默认拒绝。

### FR-008：执行 Harness

- 状态：已决策
- 来源：用户明确提出 Agent Bridge 用于 Harness 控制。
- 优先级：Must
- 主要行为：控制进程生命周期、并发租约、超时、取消、退出码和 stdout/stderr；仅允许 Provider 瞬时错误在单次 run 内有限重试，不自动重跑整个 Agent 任务。

### FR-009：独立验证

- 状态：已决策
- 来源：用户于 2026-07-19 确认按推荐方案定稿 OQ-004。
- 优先级：Must
- 主要行为：Bridge 在受控环境中重新执行任务合同列出的验收命令，并保存退出码和日志。

### FR-010：审查与返工

- 状态：已决策
- 来源：Codex 最终 Reviewer/Integrator 与受管 Agent 执行层的分工。
- 优先级：Must
- 主要行为：Codex提交结构化 finding；Bridge 控制有限次数的返工循环。

### FR-011：本地持久化与恢复

- 状态：已决策
- 来源：本地单机 Harness 的可靠性要求；用户于 2026-07-19 接受 SQLite + Repository + Outbox 演进方案。
- 优先级：Must
- 主要行为：使用 SQLite 持久化任务、版本、关系、run、Session 绑定、Context Package、Handoff、Snapshot、事件和产物引用；通过 Repository 隔离存储实现；使用事务性 Outbox 保证状态与事件一致；重启后可识别中断任务和合法恢复上下文。

### FR-012：本地图形管理页与内部管理接口

- 状态：已决策；Phase 4.2 产品需求与交互原型已收口
- 来源：用户于 2026-08-11 连续确认本地 Web 形态、首页结构、详情交互、页面职责、阶段式进度与 v2 原型，并于原型验收后确认拒绝审批的重新规划语义。
- 优先级：Must（Phase 4.2）
- 用户价值：打开页面后立即形成运行态认知，并看清需要人工处理的事项；无需依赖原始 SQLite、Artifact 或 MCP 调试信息即可完成日常观察和处置。
- FR-012-A（已决策；来源：用户确认汇总信息候选方案）：页面第一屏先展示总体运行摘要，再展示当下运行任务和风险项。摘要默认时间范围为“今日”，可切换“本次会话 / 今日 / 最近 7 天”；显示任务总数、运行中、需处理和 Token 消耗，并提供任务耗时区间占比与 Token 构成。
- FR-012-B（已决策；来源：用户确认首页候选方案）：首页主结构采用“运行与处置仪表盘”，优先展示“运行中、待审批、异常”三个区域；全部历史任务进入独立列表页，不占据首页主结构。
- FR-012-C（已决策；来源：用户确认侧边详情与风险分级）：点击任务、审批或异常项后打开右侧详情面板，先展示上下文、影响、建议和最近权威事件。普通批准或拒绝可在面板内完成；重试、取消、清理必须进入包含作用范围与影响的二次确认。
- FR-012-D（已决策；来源：用户明确否定百分比进度）：只展示阶段式进度，不显示百分比。至少呈现当前阶段、当前步骤、最近事件、已耗时和等待原因；无权威事实时显示“未知”或“等待中”，不得估算完成度。展示阶段映射为“准备上下文 → Agent 执行 → 等待审批 → 独立验证 → Review → 完成”，但必须由既有权威状态与事件派生，不能建立平行状态机。
- FR-012-E（已决策；来源：用户确认页面只负责观察、审批及运行控制）：需求设计、TaskContract 生成和任务下发仍由 Codex/MCP 完成；页面不创建任务、不编辑合同，只观察、审批和控制已经存在的任务。
- FR-012-F（已决策；来源：用户完成 v2 原型验证并确认无问题）：Token 缺失时显示“— / 未上报”，不得记作零；加载、空状态、接口错误与事件流重连必须有可区分反馈，重连期间不得提交管理写操作。
- FR-012-G（已决策；来源：用户确认拒绝审批后的行为）：拒绝只否决当前方案或动作，不取消整个任务。拒绝必须携带反馈，Bridge 记录并将任务返回 Codex 的重新规划路径；新路径在原 TaskContract 与权限范围内可继续执行，超出范围或再次触发高风险动作时必须重新审批。不得绕过拒绝，以不同形式继续执行实质相同的动作。
- 接口边界（已决策；来源：用户确认本地 Web 方案）：页面及其内部 localhost HTTP/JSON + SSE 接口复用 Bridge 应用服务与权威状态；首版不提供面向用户的通用管理 CLI 或公共平台 API，仅保留启动与诊断所需的内部命令。
- 一致性规则（已决策；来源：既有 Bridge 权威状态边界与用户确认页面职责）：页面、内部接口和 MCP 不得建立旁路状态、私有状态名称或绕过 Repository/Outbox/审计；同一任务必须呈现一致的状态、事件顺序和错误分类。
- 安全规则（已决策；来源：既有凭据与审计安全合同）：不得把 Provider 凭据、完整 transcript、内部推理、未脱敏日志或本地敏感路径暴露给 HTTP 响应、页面、命令输出或前端持久化。
- 当前边界（已决策；来源：用户确认轻量本地浏览器方案）：继续以本地单用户为首个交付范围；不要求 macOS 双击启动，不采用 Electron/Tauri 首版封装；远程 Worker、云控制面、多租户和公网暴露不随内部 HTTP 接口自动进入范围。
- 技术方案（已决策；来源：[ADR-0003](../adr/0003-local-dashboard-technical-and-security-contract.md)）：首版使用原生 TypeScript/HTML/CSS、Node.js 22 内置 `node:http` 与 SSE，不采用 React/Vite/Hono，不新增外部运行时依赖；内部接口遵循已冻结的 [HTTP/JSON + SSE v1 合同](../contracts/phase-4-2-management-http-sse-v1.md)。
- 澄清：Phase 4.1 的 preflight 与 content-hash 是窄范围、只读启动辅助入口，不提供通用任务管理，因此不代表 FR-012 已实现。

### FR-013：审计与脱敏

- 状态：已决策
- 来源：权限、密钥和运行可追溯要求；用户于 2026-07-19 接受结构化日志和 OpenTelemetry 接口建议。
- 优先级：Must
- 主要行为：记录调用者、时间、任务版本、run、Session 绑定链、Context Package/Handoff 哈希、滚动事件、角色、模型标识、状态、commit 和验证结果；凭据必须脱敏。

### FR-014：任意 Agent Driver 扩展

- 状态：已决策
- 来源：用户明确要求考虑后续支持任意 Agent 扩展，并于 2026-07-19 接受 Driver 协议建议。
- 优先级：Must
- 主要行为：Bridge Core 仅依赖版本化 Agent Driver 协议；具体 Agent 通过独立 Driver 包或进程接入；Driver 必须声明能力、健康状态并实现任务准备、启动、稳定 Session 标识、上下文用量或可估算输入、后继 Session、事件、反馈、取消和结果收集生命周期。
- 兼容规则：不具备某项能力的 Driver 必须显式声明不支持，Bridge 不得猜测或静默降级。

### FR-015：跨机与云端演进边界

- 状态：已决策
- 来源：用户明确要求考虑跨机调度和云端环境，并于 2026-07-19 接受本地到云端的分层演进建议。
- 优先级：Must（架构边界）；Won't（MVP 远程运行能力）
- 主要行为：任务存储、事件投递、Artifact、Worker 传输和身份认证通过接口隔离；MVP 使用本地实现，但不得把绝对路径、SQLite 事务或本地进程句柄泄漏到领域协议中。
- 后续替换：SQLite→PostgreSQL、本地 Outbox Dispatcher→消息系统、本地 Artifact→对象存储、stdio Driver→远程 Worker、子进程→OCI/Kubernetes 执行单元。

### FR-016：需求级 Session 隔离与上下文交接

- 状态：已决策
- 来源：用户于 2026-07-19 接受“任务会话隔离 + 结构化交接包”方案并确认写入原 PRD。
- 优先级：Must
- 用户价值：避免不同需求长期复用同一上下文造成指令干扰，同时保留关联任务已经确认的接口、决策、代码状态和验证结果。
- 前置条件：当前需求已经创建 `Task` 与不可变 `TaskVersion`；关联任务已经具有可引用的版本和产物。
- 主要行为：Bridge 强制校验 `TaskVersion → AgentRun → AgentSessionBinding`；新需求和新需求版本必须创建新 Session；同一需求返工可续用原 Session；达到上下文阈值时在同一 run 内生成检查点并滚动 Session。
- 上下文组装：新 Session 只接收当前版本的 Project Baseline、TaskContract、显式选择的 Handoff 及适用的 Continuation Snapshot，不接收完整历史会话。
- 异常及恢复：跨需求复用返回 `SESSION_SCOPE_CONFLICT`；强依赖 Handoff 与代码基线不一致时返回 `STALE_HANDOFF`；上下文滚动失败时保留旧 Session、检查点和审计事件并将 run 标记失败。
- 权威边界：UI 中是否打开新窗口不作为判断依据；Bridge 持久化绑定关系和 Context Package 才是权威来源。Bridge 无法强制控制的 Codex GUI 窗口必须通过“新需求新建 Codex 任务”的操作规范配合，但所有受管 Agent Session 仍由 Bridge 强制隔离。

## 10. 业务规则

| 编号 | 状态 | 来源 | 规则 |
|---|---|---|---|
| BR-001 | 已决策 | 双方职责分工 | Codex 拥有任务定义和最终集成权；受管 Agent 拥有合同范围内的执行权；Bridge 拥有状态流转权。 |
| BR-002 | 已确认 | 用户于 2026-07-19 明确确认部署形态 | MVP 采用本地、单用户、单机部署。 |
| BR-003 | 已决策 | 用户要求独立 App 协作 | 双方只交换任务合同、事件和可验证产物，不交换完整会话和内部思考。 |
| BR-004 | 已决策 | 防止循环编排 | 仅允许 Codex 经 Bridge 调用受管 Agent；执行 Agent 不得反向调用 Codex。 |
| BR-005 | 已决策 | 用户确认 OQ-004 | 同一任务版本同一时间只能有一个写入租约；冲突请求直接拒绝并返回 `LEASE_CONFLICT`，不自动排队。 |
| BR-006 | 已决策 | 用户确认 OQ-004 | 同一文件同一时间只能有一个写入 Owner。 |
| BR-007 | 已决策 | 用户确认 OQ-004 | 未显式声明的路径、工具和命令默认拒绝。 |
| BR-008 | 已决策 | 用户确认 OQ-004 | Agent 自述通过不能替代 Bridge 或 CI 的实际验证结果。 |
| BR-009 | 已决策 | 用户确认 OQ-004 | 任务运行后当前 task version 不可变；需求变化必须创建新版本。 |
| BR-010 | 已决策 | 最终集成职责 | MVP 不自动合并 `main`，必须由 Codex 或用户完成。 |
| BR-011 | 已决策 | 用户确认 OQ-004 | Tester 不得修改产品代码，Reviewer 和 Coordinator 默认只读。 |
| BR-012 | 已决策 | 用户确认 OQ-004 | 模型凭据不得写入任务、结果、本地数据库和普通日志。 |
| BR-013 | 已决策 | 用户接受技术栈建议 | MVP 使用 Node.js 22+、TypeScript 和 pnpm monorepo。 |
| BR-014 | 已决策 | 用户接受 Agent 扩展建议 | Bridge Core 不得直接依赖具体 Agent SDK，只依赖版本化 Driver 协议。 |
| BR-015 | 已决策 | 用户确认 Driver 中立化 | 具体 Agent SDK、Server 或 CLI 只能存在于独立 Driver 边界内；主 Driver 与降级 Driver 必须通过统一选型门禁。 |
| BR-016 | 已决策 | 用户接受接口分层建议 | Codex 通过 MCP 调用 Bridge；Bridge 内部 Worker/Driver 通信不得直接复用 Codex MCP 工具协议。 |
| BR-017 | 已决策 | 用户接受云端演进建议 | MVP 使用本地实现，但存储、事件、Artifact 和 Worker 传输必须通过可替换接口隔离。 |
| BR-018 | 已决策 | 用户确认 Driver 中立化 | 正常运行不得依赖 Agent 或 IDE 的可见 UI；Bridge 持有权威事件和状态，多客户端由 Bridge 扇出而非依赖特定 Hub。 |
| BR-019 | 已决策 | 用户确认 OQ-004 | 整个 Agent 任务失败后不自动重跑；仅 Provider 瞬时错误可在单次 run 内有限重试。 |
| BR-020 | 已决策 | 用户确认 OQ-004 | MVP 默认 `timeout_seconds=3600`、`max_review_cycles=3`、`max_agent_count=4`；任务合同可降低限制，提升限制必须显式审批。 |
| BR-021 | 已决策 | 用户确认会话隔离方案 | 一个 Agent Session 只能绑定一个 `task_id + task_version`；任何跨需求或跨版本复用均返回 `SESSION_SCOPE_CONFLICT`。 |
| BR-022 | 已决策 | 用户确认会话隔离方案 | 新的独立需求创建新 `Task`；目标、范围、业务规则或验收标准变化时创建新 `TaskVersion`；两种情况都必须创建新 Session。 |
| BR-023 | 已决策 | 用户确认会话隔离方案 | 同一 `TaskVersion` 的测试修复和 Review 返工可以续用当前 Session；手工重跑失败任务必须产生新 `run_id` 和新 Session。 |
| BR-024 | 已决策 | 用户确认上下文滚动方案 | 默认滚动阈值为上下文窗口的 70%；有效阈值取 TaskContract、Project、Driver 配置与 70% 上限中的最小值。达到阈值时，在安全边界生成 `ContinuationSnapshot` 并滚动到同一 run 下的新 Session。 |
| BR-025 | 已决策 | 用户确认结构化交接方案 | 不同需求之间只通过版本化 Context Package 传递信息，禁止默认复制完整聊天记录、模型内部思考或全部历史 Handoff。 |
| BR-026 | 已决策 | 用户确认结构化交接方案 | 新任务 Context Package 仅由当前 Project Baseline、TaskContract 和显式选择的 Handoff 组成；同一任务滚动时额外加入最新 Continuation Snapshot。 |
| BR-027 | 已决策 | 用户确认任务关系方案 | 任务关系仅支持 `depends_on`、`related_to`、`supersedes` 和 `follow_up_of`；关系必须关联具体 TaskVersion。 |
| BR-028 | 已决策 | 用户确认结构化交接方案 | Handoff 一经发布不可原地修改，必须包含来源任务版本、来源 commit、验证摘要和内容哈希；修正时发布新版本。 |
| BR-029 | 已决策 | 用户确认结构化交接方案 | `depends_on` 的来源 commit 未包含在目标任务 base commit 中时拒绝启动并返回 `STALE_HANDOFF`；`related_to` 不满足时警告但不阻塞。 |
| BR-030 | 已决策 | 用户确认权威边界方案 | UI 窗口不是 Session 隔离权威来源；Bridge 中的任务版本、运行、Session 绑定和审计记录为权威来源。 |
| BR-031 | 已决策 | 用户确认 Phase 4.2 页面职责 | 本地管理页只观察、审批和控制既有任务；任务设计、合同生成和下发仍由 Codex/MCP 完成。 |
| BR-032 | 已决策 | 用户确认运行态仪表盘 | 首页先提供指定时间范围的总体摘要，再提供运行中、待审批、异常三个高优先级区域；历史任务使用独立列表页。 |
| BR-033 | 已决策 | 用户确认阶段式进度 | 页面不得展示推测性完成百分比；阶段、步骤、耗时和等待原因必须由权威状态或事件派生。 |
| BR-034 | 已决策 | 用户确认侧边详情交互 | 任务处置先展示上下文、影响和建议；批准/拒绝可在详情面板完成，重试、取消、清理必须二次确认。 |
| BR-035 | 已决策 | 用户确认拒绝审批语义 | 拒绝审批只否决当前方案或动作，并携带反馈返回 Codex 重新规划；不得继续等价动作，超出原合同或权限的新路径必须再次审批。 |
| BR-036 | 已决策 | 用户确认 Token 汇总并通过 v2 原型 | Token 未上报时显示“— / 未上报”，不得按零参与消费统计。 |
| BR-037 | 已决策 | 用户通过 v2 断线场景验证 | 管理事件流重连期间页面保持可观察，但不得提交审批、重试、取消或清理等写操作。 |

## 11. 核心对象与数据

### 11.1 核心对象

- Project：受控 Git 项目。
- TaskContract：任务目标、规则、范围、验收和限制。
- Task：任务的权威状态对象。
- TaskVersion：不可变需求版本；冻结目标、范围、业务规则和验收标准。
- AgentRun：一次具体执行尝试。
- AgentSessionBinding：外部 Agent Session 与 TaskVersion、AgentRun、Driver 和角色的不可变绑定段。
- TaskRelation：两个具体 TaskVersion 之间的依赖或关联关系。
- ProjectBaseline：项目级长期约束、架构约定、通用验证规则及其版本。
- ContextPackage：Bridge 为某个 Session 组装并记录哈希的实际输入清单。
- HandoffPackage：跨任务传递的版本化、不可变成果摘要。
- ContinuationSnapshot：同一 TaskVersion 上下文滚动时使用的执行检查点。
- RoleTemplate：角色 Prompt、模型、工具和权限集合。
- Lease：写入任务的并发租约。
- Event：追加式状态和审计事件。
- Artifact：commit、diff、日志、报告等引用。
- ReviewFinding：Codex 或 Reviewer 提交的结构化问题。
- VerificationResult：Bridge 或 CI 运行的验收结果。

### 11.2 任务合同示例

```json
{
  "task_id": "AUTH-123",
  "task_version": 1,
  "project_id": "example-project",
  "base_commit": "8f34b21",
  "policy_version": "1.0",
  "objective": "实现登录失败锁定机制",
  "role": "developer",
  "business_rules": [
    {
      "id": "BR-AUTH-004",
      "description": "连续失败 5 次后锁定 30 分钟"
    }
  ],
  "scope": {
    "read": ["src/auth/**", "tests/auth/**"],
    "write": ["src/auth/**"],
    "deny": ["infra/**", ".github/**", "secrets/**"]
  },
  "acceptance_commands": [
    "npm run typecheck",
    "npm test -- auth"
  ],
  "git": {
    "branch": "agent/AUTH-123/developer"
  },
  "relations": [
    {
      "type": "depends_on",
      "task_id": "AUTH-100",
      "task_version": 2
    }
  ],
  "selected_handoff_ids": ["handoff-AUTH-100-v2-001"],
  "context_policy": {
    "project_baseline_version": 3,
    "rollover_ratio": 0.7,
    "inherit_full_transcript": false
  },
  "limits": {
    "timeout_seconds": 3600,
    "max_review_cycles": 3,
    "max_agent_count": 4
  },
  "required_output": [
    "commit_sha",
    "changed_files",
    "test_results",
    "known_risks",
    "unresolved_items"
  ]
}
```

示例中的超时、审查轮次和 Agent 数量是已确认的 MVP 默认值；任务合同可以降低限制，提升限制必须显式审批。

### 11.3 结果示例

```json
{
  "task_id": "AUTH-123",
  "task_version": 1,
  "run_id": "run-001",
  "session_ids": ["session-001", "session-002"],
  "status": "submitted",
  "base_commit": "8f34b21",
  "commit_sha": "abc123",
  "changed_files": [],
  "acceptance_results": [
    {
      "command": "npm test -- auth",
      "exit_code": 0,
      "duration_ms": 12000,
      "log_artifact": "artifacts/test-auth.log"
    }
  ],
  "review_findings": [],
  "known_risks": [],
  "unresolved_items": [],
  "provider": "configured-provider",
  "model": "configured-model",
  "started_at": "",
  "finished_at": ""
}
```

### 11.4 Session、上下文与 Handoff 数据契约

关系约束：

```text
Project 1 ── N Task 1 ── N TaskVersion 1 ── N AgentRun 1 ── N AgentSessionBinding
                              │                    │
                              ├── N TaskRelation   └── N ContinuationSnapshot
                              └── N HandoffPackage

每个 AgentSessionBinding 只属于一个 TaskVersion 和 AgentRun；滚动时新增绑定段，不修改旧绑定。
```

上下文组装矩阵：

| 场景 | 必须注入 | 可选注入 | 明确禁止 |
|---|---|---|---|
| 新 Task | Project Baseline、当前 TaskContract | 显式选择且关系合法的 Handoff | 最近会话、完整聊天记录、全部项目历史 |
| 新 TaskVersion | Project Baseline、新版本 TaskContract | 旧版本发布的 Handoff | 旧 Session 直接复用、旧版本临时讨论 |
| 同版本 Review/测试返工 | 当前 Context Package、结构化 finding/测试结果 | 当前 Session 已有上下文 | 无关任务内容 |
| 同版本上下文滚动 | Project Baseline、当前 TaskContract、最新 Continuation Snapshot | 仍有效的已选 Handoff | 旧 Session 完整 transcript |
| 手工重跑失败任务 | Project Baseline、当前 TaskContract、已持久化失败摘要 | 用户重新选择的有效 Handoff | 失败 Session 直接复用 |

`ProjectBaseline` 仅保存经确认的长期架构、编码规范、安全约束、通用验证命令和禁止修改范围；任何变更必须创建新版本。`ContinuationSnapshot` 至少包含当前步骤、已完成事项、未完成计划、Git base/head、changed files、最近验证结果、当前错误/阻塞、下一步动作及权威 Artifact 引用。

`AgentSessionBinding` 至少包含：

```ts
interface AgentSessionBinding {
  bindingId: string
  sessionId: string
  taskId: string
  taskVersion: number
  runId: string
  driverId: string
  role: string
  predecessorSessionId?: string
  status: 'CREATED' | 'ACTIVE' | 'ROLLOVER_PENDING' | 'SUPERSEDED' | 'CLOSED' | 'FAILED'
  contextPackageId: string
  createdAt: string
  closedAt?: string
}
```

`HandoffPackage` 至少包含：

```yaml
handoff_id: handoff-AUTH-100-v2-001
handoff_version: 1
source_task:
  task_id: AUTH-100
  task_version: 2
  final_run_id: run-008
code_state:
  repository: example-project
  base_commit: 8f34b21
  head_commit: abc123
completed:
  - 已实现登录接口
decisions:
  - Token 格式保持不变
contracts:
  - POST /api/login
changed_files:
  - src/auth/routes.ts
verification:
  status: passed
  artifact_ids:
    - artifact-test-auth
known_issues:
  - 暂未实现找回密码
downstream_notes:
  - 找回密码应复用 UserRepository
content_hash: sha256:example
generated_at: 2026-07-19T00:00:00+08:00
```

数据来源规则：任务、版本、commit、changed files、验证结果和 Artifact 引用由 Bridge 从权威存储生成；Agent 仅能建议 `completed`、`known_issues` 和 `downstream_notes` 等叙述字段，Bridge 必须标记字段来源并在发布前校验。所有包必须脱敏，不得包含完整聊天记录、模型内部思考、凭据或未经选择的无关任务内容。

本节状态：已决策；来源为用户于 2026-07-19 确认任务会话隔离、分层上下文和结构化交接方案。

## 12. 状态机

### 12.1 任务状态机

```text
DRAFT
  ↓
VALIDATED
  ↓
QUEUED
  ↓
RUNNING
  ├──→ WAITING_APPROVAL
  ├──→ INTERRUPTED
  ├──→ FAILED
  └──→ CANCELLED
  ↓
SUBMITTED
  ↓
VERIFYING
  ├──→ FAILED
  ↓
REVIEW_REQUIRED
  ├──→ CHANGES_REQUESTED ──→ RUNNING
  ↓
READY_FOR_MERGE
  ↓
COMPLETED
```

上述任务状态机及状态名称已决策，来源为用户于 2026-07-19 确认 OQ-004。实现不得新增、删除或合并任务状态；若技术实现需要改变状态含义或转换关系，必须先修订 PRD。

### 12.2 Agent Session 生命周期

```text
CREATED
  ↓
ACTIVE
  ├──→ ROLLOVER_PENDING ──→ SUPERSEDED
  ├──→ CLOSED
  └──→ FAILED
```

- 创建新任务、新 TaskVersion 或手工重跑失败任务时创建新的 `CREATED` Session。
- Driver 建立成功并记录 Context Package 后进入 `ACTIVE`。
- 达到上下文阈值时进入 `ROLLOVER_PENDING`；检查点和后继 Session 创建成功后，旧 Session 进入 `SUPERSEDED`，后继 Session 进入 `ACTIVE`。
- 正常完成或取消后进入 `CLOSED`；无法建立、恢复或滚动时进入 `FAILED`。
- 同一 `AgentRun + role` 最多存在一个 `ACTIVE` Session；`SUPERSEDED` Session 只读保留，不得再次接收输入。

本节状态：已决策；来源为用户于 2026-07-19 确认会话隔离与上下文滚动计划。

## 13. Codex 控制接口

MVP 使用 MCP stdio，暴露以下工具：

```text
bridge_create_task(contract)
bridge_create_task_version(task_id, contract)
bridge_link_task_versions(source, target, relation_type)
bridge_validate_task(task_id, task_version)
bridge_prepare_context(task_id, task_version, selected_handoff_ids)
bridge_start_task(task_id, task_version, idempotency_key)
bridge_get_task(task_id)
bridge_list_tasks(filters)
bridge_get_events(task_id, cursor)
bridge_get_result(task_id)
bridge_list_handoffs(task_id, task_version)
bridge_get_context_package(context_package_id)
bridge_rollover_session(task_id, task_version, run_id, reason)
bridge_send_feedback(task_id, findings)
bridge_cancel_task(task_id, reason)
bridge_mark_completed(task_id, merge_commit)
```

接口约束：

- 参数使用严格 JSON Schema。
- 所有写操作支持幂等键。
- 不提供“执行任意 Shell”接口。
- 高风险操作需要显式审批。
- 返回稳定错误码。
- 所有调用记录审计事件。
- `bridge_start_task` 不接受任意外部 `session_id`；Bridge 根据 TaskVersion 创建或选择合法的当前 Session。
- `bridge_send_feedback` 只能续接 finding 所关联 TaskVersion、commit 和当前有效 Session。
- `bridge_prepare_context` 只解析显式选择且关系合法的 Handoff，并返回实际注入清单与内容哈希。

本节整体状态：已决策；来源为用户于 2026-07-19 接受 MCP 控制接口建议，并确认会话隔离与上下文交接计划。工具字段的完整 JSON Schema 在研发阶段通过接口评审固化。

## 14. 隔离与安全要求

### 14.1 Git 隔离

- 每个写入任务使用独立分支和 worktree。
- 受管 Agent 不得直接写主工作区。
- 启动前记录 base commit，完成后验证实际 diff。
- MVP 不自动合并主分支。

### 14.2 进程隔离

- 每个 Agent run 使用可追踪的独立 Driver 子进程；具体 SDK、Server 连接和 Session 客户端只能存在于对应 Driver 边界中。
- 支持超时、取消和退出码捕获。
- Bridge 退出后不得遗留无法识别的后台任务。

### 14.3 权限隔离

- 路径在执行前校验，并在执行后通过 Git diff 再校验。
- Reviewer 和 Coordinator 默认只读。
- Tester 不得修改产品代码。
- 命令分为允许、需审批和禁止三类。

### 14.4 密钥隔离

- 模型凭据通过环境或系统密钥存储注入。
- Codex 不读取执行 Agent 凭据，执行 Agent 不读取 Codex 凭据；不同 Driver 的凭据也必须隔离。
- 日志、错误和事件输出必须脱敏。

### 14.5 上下文隔离

- Session ID 在首次绑定后不可转移到其他 TaskVersion、AgentRun 或角色。
- Context Package 使用允许列表组装，不得通过“最近任务”“同一模块”或“同一项目”隐式继承历史内容。
- Project Baseline、Handoff、Continuation Snapshot 和最终 Context Package 必须版本化并记录内容哈希。
- Handoff 发布前执行敏感字段扫描；完整会话、模型内部思考和凭据不得进入交接包。
- Bridge 管理的所有 Driver Session 必须执行硬隔离；Codex GUI 无法由 Bridge 强制新开窗口时，通过新 Codex 任务操作规范和 Bridge 协议拒绝共同降低污染风险。

本节全部要求已决策，来源为用户确认 Driver 中立化、按推荐方案定稿 OQ-004，并确认会话隔离与上下文交接计划。路径规范化、符号链接逃逸防护、命令策略和上下文白名单组装作为强制安全验收项。

## 15. 异常与边界

| 场景 | 已决策处理 |
|---|---|
| 非法任务合同 | 拒绝校验，返回字段级错误 |
| 重复启动 | 根据幂等键返回既有 run |
| 并发写入 | 直接拒绝后发写入请求并返回 `LEASE_CONFLICT`，不自动排队 |
| base commit 过期 | 拒绝启动，要求重新基线 |
| Driver 或 Agent 异常退出 | 保存事件和日志，将 run 标记失败；整个任务不自动重跑 |
| 验收失败 | 不进入待合并状态，返回验证结果 |
| 越权文件修改 | 任务失败，报告越权路径 |
| 用户取消 | 终止执行，保留已有产物 |
| 用户拒绝当前审批 | 记录拒绝理由，阻止当前方案或动作，任务返回 Codex 重新规划；不把拒绝等同于取消，不允许继续等价动作 |
| 拒绝后的新路径超出 TaskContract 或权限 | 保持等待，不执行新路径并发起新的显式审批 |
| Bridge 崩溃 | 重启后将未知运行标记为中断 |
| 模型 API 断网或限流 | 仅在单次 run 内对 Provider 瞬时错误有限重试；达到上限后 run 失败，不重跑整个任务 |
| 反馈针对旧 commit | 拒绝反馈并要求刷新结果 |
| 超过返工上限 | 停止自动循环，等待用户决定 |
| 新需求复用旧 Session | 拒绝启动或续接，返回 `SESSION_SCOPE_CONFLICT` |
| Session 绑定信息缺失或不一致 | 不向 Agent 发送输入，记录审计事件并返回 `SESSION_BINDING_INVALID` |
| `depends_on` Handoff 的来源 commit 不在目标 base commit 中 | 拒绝启动并返回 `STALE_HANDOFF`，要求更新基线或重新生成 Handoff |
| `related_to` Handoff 的来源 commit 不在目标 base commit 中 | 允许准备上下文但返回非阻塞陈旧警告，并在 Context Package 中标记 |
| Handoff 内容哈希不匹配 | 拒绝注入并返回 `HANDOFF_INTEGRITY_ERROR` |
| 上下文达到 70% | 在安全边界生成检查点并滚动到新 Session，旧 Session 只读保留 |
| Provider 提前返回上下文长度错误 | 从持久化状态生成降级检查点并尝试一次 Session 滚动；失败则 run 失败 |

本节整体状态：已决策；来源为用户于 2026-07-19 按推荐方案定稿 OQ-004，并确认会话隔离、上下文滚动和 Handoff 异常规则。

## 16. 非功能需求

### 16.1 安全

- 默认拒绝未声明的工具、路径和命令。
- 防止路径穿越和符号链接逃逸。
- 不在普通日志中记录凭据和完整环境变量。
- 所有高风险动作具有审计记录。

### 16.2 一致性

- 状态转换采用事务或等效原子机制。
- 每个结果关联 task version、run ID 和 base commit。
- 每次 Agent 输入都能追溯到唯一 Session Binding 和 Context Package 哈希。
- 创建后继 Session、写入 Continuation Snapshot 与标记旧 Session `SUPERSEDED` 必须使用事务或可恢复的 Outbox 流程，避免同时存在两个有效 Session。
- 创建、启动、反馈和取消支持幂等。

### 16.3 可恢复性

- Bridge 重启后能读取历史任务。
- 中断任务不得自动视为成功。
- 重试必须产生新 run ID。
- Bridge 重启后能够恢复 Session 绑定链、最新检查点和已选 Handoff；不得通过猜测最近会话恢复。

### 16.4 可观测性

至少记录：task ID、task version、run ID、session ID、predecessor session ID、Context Package ID/哈希、上下文使用比例、滚动原因、Handoff ID/版本、Agent 角色、Provider、模型标识、状态、工具结果、命令退出码、持续时间、commit SHA 和错误类型。

### 16.5 配置与文档

- 配置说明、协作规范和使用文档优先使用中文。
- 配置提供示例文件，不包含真实凭据。
- 本地数据库、日志、临时 worktree、运行产物和凭据必须加入 `.gitignore`。

本节整体状态：已决策；来源为用户于 2026-07-19 按推荐方案定稿 OQ-004，并确认会话隔离与上下文交接计划。具体技术库和实现方式由研发选择，但不得降低本节可验证行为。

## 17. 集成与依赖

| 系统 | 输入/输出 | 权威来源 | 候选接口 | 失败补偿 |
|---|---|---|---|---|
| Codex | 任务版本、关系、Handoff 选择、反馈、完成确认 | Codex 用户和任务合同 | MCP stdio | 保留任务、Context Package 和审计事件；新 Codex 任务可重新加载 |
| 受管 Code Agent | Session、上下文用量、执行事件、commit、结果 | Bridge run、Session Binding 与事件日志 | 选型通过的独立 Driver；显式降级 Driver | 检查点滚动、终止、切换降级路径；失败任务仅允许人工触发新 run |
| Git | base commit、branch、diff | Git 仓库 | Git CLI | 拒绝过期基线或冲突任务 |
| CI/验证器 | 测试和检查结果 | CI 或 Bridge 进程 | 命令接口 | 保存失败日志，不放行 |
| 模型提供商 | 模型响应和用量 | Provider API | 选定 Driver 的 Provider 配置 | 限流重试或失败 |

## 18. 用户故事与验收标准

### US-001：创建并执行任务

- 状态：已决策
- 来源：用户要求 Codex 与 Code Agent 通过 Bridge 协作。

> 作为使用 Codex 的开发者，我希望 Codex 能向 Bridge 提交结构化任务并由受管 Agent 执行，从而无需手工复制完整上下文。

```gherkin
场景：合法任务正常执行
假如任务合同合法且 Git 基线可用
当 Codex 启动任务
那么 Bridge 创建隔离工作区并通过选定 Driver 启动执行 Agent
并且保存运行事件、commit 和验证结果
并且任务进入待 Codex 审查状态
```

### US-002：阻止越权修改

- 状态：已决策
- 来源：用户明确提出隔离和业务约束需求。

```gherkin
场景：Agent 修改禁止目录
假如任务只允许写入 src/auth
当执行 Agent 修改 infra 目录
那么 Bridge 检测并报告越权路径
并且任务不得进入待合并状态
```

### US-003：独立验证结果

- 状态：已决策
- 来源：用户于 2026-07-19 确认 OQ-004 的独立验证规则。

```gherkin
场景：Agent 声称测试通过但实际失败
假如任务合同包含可执行验收命令
当 Bridge 独立运行命令并获得非零退出码
那么任务不得标记为成功
并且 Codex 能读取失败摘要和日志引用
```

### US-004：结构化返工

- 状态：已决策
- 来源：Codex 最终审查、受管 Agent 执行的职责分工。

```gherkin
场景：Codex 要求修改
假如执行 Agent 已提交可审查 commit
当 Codex 提交结构化 finding
那么 Bridge 将 finding 关联到当前任务版本和 commit
并且执行 Agent 在隔离分支继续修改
并且新结果重新执行完整验证
```

### US-005：取消与恢复

- 状态：已决策
- 来源：用户于 2026-07-19 确认 OQ-004 的取消与恢复规则。

```gherkin
场景：取消运行中任务
假如执行 Agent 正在执行
当用户或 Codex 请求取消
那么 Bridge 终止对应执行
并且保留审计事件和已有产物
并且任务进入取消状态
```

```gherkin
场景：Bridge 崩溃后重启
假如 Bridge 在任务运行期间异常退出
当 Bridge 重新启动
那么历史任务仍可查询
并且未知运行不得自动报告成功
并且用户可以选择恢复、重试或取消
```

### US-006：Driver 无 UI 运行与事件观察

- 状态：已决策
- 来源：用户于 2026-07-19 确认 Driver 中立化和 Bridge 权威事件边界。

```gherkin
场景：Agent UI 或 IDE 未运行
假如 Bridge 已通过选定 Driver 创建运行中 Session
并且没有打开该 Agent 的 UI 或 IDE 插件
当执行 Agent 处理任务
那么任务能够继续运行
并且 Bridge 持久化结构化事件、权限决策和完成状态
```

```gherkin
场景：多个观察端订阅同一任务
假如 Bridge 已保存某个 run 的权威事件流
当两个观察端订阅该 run
那么 Bridge 向两者提供一致的已持久化事件和后续事件
并且任何观察端退出都不影响 Driver 任务生命周期
```

### US-007：需求级会话隔离与结构化交接

- 状态：已决策
- 来源：用户于 2026-07-19 确认会话隔离、上下文滚动和关联任务交接计划并要求更新原 PRD。

> 作为使用多个 Agent 开发项目的开发者，我希望每个新需求在独立会话中执行，并让相关需求只继承经过筛选的成果摘要，从而避免上下文污染且不丢失必要信息。

```gherkin
场景：新需求尝试复用旧 Session
假如 Session S1 已绑定 TASK-A 的版本 1
当 TASK-B 或 TASK-A 的版本 2 尝试使用 S1 启动或继续执行
那么 Bridge 拒绝请求并返回 SESSION_SCOPE_CONFLICT
并且不得向 S1 发送新需求内容
```

```gherkin
场景：同一需求的 Review 返工续用当前 Session
假如 finding 关联 TASK-A 版本 1 的当前 commit 和有效 Session
并且目标、范围、业务规则和验收标准均未变化
当 Codex 提交结构化返工意见
那么 Bridge 允许当前 Session 继续执行
并且事件仍关联 TASK-A 版本 1 和原 run
```

```gherkin
场景：上下文达到滚动阈值
假如当前 Session 的上下文使用比例达到 70%
当 Agent 完成当前工具调用或原子步骤
那么 Bridge 生成可追溯的 ContinuationSnapshot
并且创建绑定同一 TaskVersion 和 run 的后继 Session
并且旧 Session 进入 SUPERSEDED 且不能再接收输入
```

```gherkin
场景：相关新需求仅接收显式选择的交接包
假如 TASK-B 关联 TASK-A 和 TASK-C
并且 Coordinator 只选择 TASK-A 的 Handoff
当 Bridge 为 TASK-B 创建新 Session
那么 Context Package 只包含 Project Baseline、TASK-B 合同和已选 TASK-A Handoff
并且不包含 TASK-A 完整聊天记录、TASK-C 内容或模型内部思考
```

```gherkin
场景：强依赖交接包与代码基线不一致
假如 TASK-B depends_on TASK-A 的 Handoff
并且 TASK-B 的 base commit 不包含该 Handoff 声明的来源 head commit
当 Bridge 校验 TASK-B
那么 Bridge 拒绝启动并返回 STALE_HANDOFF
并且提示更新基线或重新生成 Handoff
```

```gherkin
场景：不依赖聊天记录恢复上下文
假如原 Agent UI 会话不可访问
并且 Bridge 保存了 TaskContract、Session 绑定链、ContinuationSnapshot、Git 状态和 Artifact
当用户恢复同一 TaskVersion
那么 Bridge 能组装新的 Context Package 并创建后继 Session
并且恢复结果不依赖原完整聊天记录
```

### US-008：通过本地管理页观察和处置任务

- 状态：已决策
- 来源：用户于 2026-08-11 确认 Phase 4.2 产品决策并完成 v2 可操作原型验证；以下场景均属于该已确认范围。

> 作为在本机使用 Agent Bridge 的开发者，我希望先理解总体运行态，再处理审批和异常，从而不必直接检查 SQLite、Artifact 或原始日志。

```gherkin
场景：查看总体运行态和当前处置项
假如 Bridge 中存在本次会话、今日和最近 7 天的任务与用量事实
当用户打开本地管理页并切换时间范围
那么页面先显示该范围的任务总数、运行中、需处理和 Token 汇总
并且显示耗时区间占比和 Token 构成
并且随后显示运行中、待审批和异常三个高优先级区域
```

```gherkin
场景：缺少 Token 用量事件
假如一个或多个任务没有权威 Token 用量事件
当页面计算和展示 Token 汇总
那么缺失值显示为“— / 未上报”
并且不得把缺失值按零参与消费统计
```

```gherkin
场景：拒绝当前审批并重新规划
假如任务正在等待对当前方案或动作的审批
当用户填写反馈并选择拒绝
那么 Bridge 记录拒绝决定和反馈并阻止当前方案或动作
并且任务返回 Codex 的重新规划路径而不是继续原路径或直接取消整个任务
并且新路径超出原 TaskContract、权限或再次触发高风险动作时必须重新审批
```

```gherkin
场景：拒绝审批但未填写反馈
假如任务正在等待审批
当用户未填写反馈便选择拒绝
那么页面不提交拒绝决定
并且明确提示需要填写反馈
```

```gherkin
场景：执行高风险运行控制
假如用户在详情面板选择重试、取消或清理
当页面准备提交操作
那么先显示动作作用范围、影响和不可逆风险
并且只有用户二次确认后才提交幂等写请求
```

```gherkin
场景：事件流正在重连
假如页面与 Bridge 的管理事件流断开并进入重连
当用户尝试批准、拒绝、重试、取消或清理
那么页面拒绝提交写操作并显示重连状态
并且不得以陈旧页面状态猜测操作结果
```

## 19. 测试要求

至少覆盖：

- JSON Schema 校验。
- 状态机合法与非法转换。
- 幂等创建和启动。
- 写入租约和并发冲突。
- 路径匹配、路径穿越和符号链接逃逸。
- 命令允许、审批和禁止策略。
- Git diff 越权检测。
- Fake Driver 集成测试和正式 Driver Contract 测试。
- OpenCode 主 Driver 的 Headless 启动、健康检查、Session、事件、取消、权限、恢复和结果收集兼容性测试。
- Claude Agent SDK 降级 Driver 的能力声明、独立启动、写入降级和只读复核兼容性测试。
- Bridge 权威事件持久化、多个观察端扇出和观察端断开后任务继续运行测试。
- FR-012 时间范围、汇总口径、阶段映射、Token 未上报、空状态、加载、接口错误和事件流重连的页面/Contract 测试。
- 审批批准、携带反馈的拒绝、无反馈拒绝、拒绝后重新规划，以及拒绝后新路径再次越界的状态与审计测试。
- 重试、取消和清理的二次确认、幂等、权限、审计与陈旧页面拒绝写入测试。
- Agent UI、IDE 插件和降级 Driver 缺失时主 Driver 继续运行的测试。
- 主 Driver 不可用时显式切换降级 Driver 的能力检查和审计测试；不得静默切换正在运行的任务。
- Session 到 TaskVersion 的单一作用域绑定，以及一个 TaskVersion 多次合法滚动的关系校验。
- 新 Task、新 TaskVersion、同版本返工和手工重跑的 Session 选择矩阵测试。
- 上下文使用比例达到、低于和超过 70% 的滚动边界测试。
- Driver 无上下文用量时的估算与 Provider 提前报错降级滚动测试。
- Continuation Snapshot 生成、后继 Session 创建和旧 Session `SUPERSEDED` 的原子性/恢复测试。
- Project Baseline、TaskContract、已选 Handoff 和 Snapshot 的 Context Package 白名单组装测试。
- Handoff 版本、内容哈希、敏感字段扫描和字段来源测试。
- `depends_on` 的陈旧 commit 阻断与 `related_to` 的非阻塞警告测试。
- UI 会话不可用时依赖持久化对象恢复上下文的端到端测试。
- 超时、取消和异常退出。
- Bridge 重启和中断恢复。
- 日志脱敏。
- 临时 Git 仓库端到端流程。

默认 CI 不依赖真实付费模型调用；真实模型端到端测试应作为可选测试。

本节整体状态：已决策；来源为已确认功能需求、OQ-004 和 OQ-005；使用 Vitest、假 Driver 和临时 Git 仓库 E2E。具体测试目录和覆盖率阈值由实施计划确定。

## 20. 已决策项目结构方向

```text
agent-bridge/
├── apps/
│   ├── bridge-cli/
│   └── bridge-mcp/
├── packages/
│   ├── core/                    # 任务、状态机、关系、上下文策略和调度
│   ├── schemas/                 # JSON Schema 与协议版本
│   ├── driver-protocol/         # Agent Driver 生命周期协议
│   ├── driver-opencode/         # OpenCode 主 Driver
│   ├── driver-claude-agent/     # Claude Agent SDK 降级 Driver
│   ├── worker-runtime/          # worktree、进程、超时、取消和隔离
│   ├── storage-sqlite/          # SQLite Repository 与 Outbox
│   ├── artifacts-local/         # 本地 Artifact Repository
│   └── observability/           # 结构化日志与 OpenTelemetry 接口
├── schemas/
│   ├── task-contract.schema.json
│   ├── task-result.schema.json
│   ├── agent-session-binding.schema.json
│   ├── context-package.schema.json
│   ├── handoff-package.schema.json
│   └── driver-protocol.schema.json
├── config/
│   └── agent-bridge.example.yaml
├── tests/
│   ├── integration/
│   └── e2e/
├── docs/
├── pnpm-workspace.yaml
├── package.json
├── README.md
└── .gitignore
```

本节状态：已决策；实施时允许在不改变包边界和依赖方向的前提下调整具体目录名称。

## 21. 研发阶段

### Phase 1：领域内核

- 任务与结果 Schema。
- TaskVersion、TaskRelation、Session Binding、Context Package、Handoff 和 Snapshot Schema。
- 状态机。
- Session 生命周期和绑定约束。
- 策略校验。
- 存储和审计事件。
- 单元测试。

### Phase 2：本地执行 Harness

- Agent Driver 协议。
- OpenCode `1.18.3` 主 Driver 子进程。
- Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 降级 Driver 子进程。
- 两个 Driver 的能力声明、统一事件映射和 Contract 测试。
- Driver 级显式降级；不把共用 DeepSeek 描述为 Provider 级灾备。
- Coordinator、Developer、Tester、Reviewer、Docs/Research 固定角色模板，以及 Prompt、模型、工具和路径权限映射；Reviewer 与 Coordinator 默认只读，Tester 不得修改产品代码。
- 进程和 session 管理。
- 上下文用量采集/估算、检查点生成和 Session 滚动。
- Handoff 生成、完整性校验、陈旧依赖检查和 Context Package 组装。
- Git/worktree 管理。
- 验收执行。
- 超时、取消和恢复。
- 将工程初始化时期的历史 Cline 配置字段迁移为 OpenCode 主 Driver、Claude 降级 Driver 的运行时配置与无凭据示例，并提供严格校验；历史 Spike 配置不得作为 MVP 运行时契约。
- 集成测试。

### Phase 3：Codex 接入

- Codex 控制接口。
- MCP stdio Server。
- 任务版本、关系、Handoff 查询、上下文准备和人工滚动工具。
- 审批策略。
- 反馈和返工循环。
- 端到端测试。

状态：已完成。`fd3537b` / PR #6 已交付 MCP stdio 生命周期、任务控制、审批/反馈、持久查询和重启观察自动化证据。

### Phase 4：可靠性与文档

- 幂等和租约。
- 崩溃恢复。
- 日志脱敏。
- 示例项目、与正式 Driver/权限模型一致的配置样例和中文使用文档。

状态：已完成。`4b89e5d` / PR #7 已交付恢复、Outbox、脱敏、清理审计、无凭据 E2E 和交付材料，并合并到 `main@dbc2b11`。

### Phase 4.1：真实可用性验收与运行闭环

- 严格、版本化的非敏感 Provider 配置和公开运行时 Schema。
- Driver 专属 allowlist 环境变量与可选安全 JSON 凭据文件；秘密不得进入 JSONL、SQLite、Artifact、事件、日志、错误详情或 argv。
- 启动前配置/Git/目录/可执行权限/Provider 完整性诊断与确定性 `content_hash`。
- Codex MCP 注册、精确 Driver bin、完整任务流程和安全配置示例。
- Service → Bridge → 正式 stdio Worker → 正式 Driver Runtime → loopback Provider → worktree → 权限审批 → 独立验证 → Review/完成，以及重启恢复与取消。
- B-simulated、Phase 4.1 集成模拟和真实 Provider 验收分别报告，禁止互相替代。

状态：已完成。代码与无凭据 E2E 已通过完整交付门禁；2026-08-11 在普通 macOS 宿主完成 OpenCode 4 项、Claude fallback 5 项正式 B-simulated，真实 Provider 请求数为 0。随后经独立授权使用 OpenCode 主 Driver 和 `deepseek-v4-pro` 完成最小全 Bridge B-real：3 次真实请求全部返回 `200`，输入 21,930 tokens、输出 331 tokens、费用 `$0.009828`，任务 `COMPLETED`、Run `succeeded`，仅修改范围内文件，独立验证、27 个权威事件的一致性、脱敏和资源清理均通过。

### Phase 4.2：通用管理面

- 以同一 Bridge 应用服务为基础提供由项目命令或 Codex 启动、自动打开浏览器的本地 Web 管理页；HTTP/JSON + SSE 只作为页面内部 localhost 接口。
- 页面先提供“本次会话 / 今日 / 最近 7 天”运行摘要，默认“今日”；随后采用“运行与处置仪表盘”，以运行中、待审批、异常为三个高优先级区域；历史任务使用独立列表页。
- 详情使用右侧面板呈现上下文、影响、建议和权威事件。普通审批可直接处理；重试、取消、清理必须二次确认。
- 运行进度使用阶段、步骤、最近事件、耗时和等待原因表达，禁止展示缺少事实基础的百分比。
- 拒绝审批必须携带反馈，阻止当前方案并返回 Codex 重新规划；不得继续等价动作，越出原合同或权限的新路径必须再次审批。
- 页面只观察、审批和控制既有任务；任务设计、合同生成和下发继续由 Codex/MCP 负责。
- 所有观察与写操作复用既有状态机、权限、幂等、Repository、Outbox、Driver Protocol 和审计，不直接读写 SQLite。
- 首版不提供用户侧通用管理 CLI、公共 API、任务创建、桌面封装、远程 Worker、云控制面、多租户或公网部署。
- v2 原型已验证：总体运行态识别、阶段识别、普通批准/拒绝、拒绝理由校验、异常定位、高风险二次确认、Token 未上报、加载/空/错误/重连状态。
- OQ-006 已通过 ADR、接口合同和测试矩阵关闭；技术合同确认不自动授权进入实现。

状态：产品范围、信息架构、核心交互、可操作原型和技术安全合同均已完成；Phase 4.2 研发就绪，尚未获得正式实现授权。

## 22. 风险、假设与验证计划

| 类型 | 内容 | 影响 | 状态 | 验证方式 |
|---|---|---|---|---|
| 技术 | 候选 Agent 的 Session、事件、取消或权限能力可能不足 | 影响 Driver 选择和适配设计 | 已验证 | OpenCode 与 Claude Agent SDK 已通过 A 层、B-simulated 和 B-real 适用硬门禁；正式实现继续运行 Contract 测试 |
| 可用性 | OpenCode 与 Claude Agent SDK 共用 DeepSeek Provider 故障域 | Provider 故障时主/降级 Driver 可能同时不可用 | 已接受缺口 | MVP 明确仅提供 Driver 级降级；后续通过 Driver Protocol 接入独立 Provider 灾备 |
| 技术 | Codex MCP 与本地 Bridge 的进程生命周期 | 影响启动和恢复 | 已验证 | Phase 3/4 MCP stdio、持久恢复、Phase 4.1 正式 Driver loopback E2E 与最小全 Bridge B-real 均通过 |
| 可用性 | macOS 嵌套 `sandbox-exec` 可能返回 EPERM/code 126 | 影响历史 B-simulated Harness | 已闭合 | 受限宿主继续 fail closed；普通 macOS 宿主已完成 OpenCode 与 Claude fallback 全部正式 B-simulated，正式产品 loopback E2E 独立通过 |
| 安全 | 路径规则可能被符号链接绕过 | 产生越权写入 | 已识别 | 规范化路径并做逃逸测试 |
| 一致性 | 多 Agent 可能争用同一文件 | 产生冲突和覆盖 | 已识别 | 路径 Owner、租约和 diff 校验 |
| 运营 | 本机资源不足时并发 Agent 影响开发体验 | 性能下降 | 待验证 | 配置并发上限并记录资源情况 |
| 成本 | 自动返工可能产生循环调用 | 费用和时间失控 | 已识别 | 最大审查轮次、超时和人工审批 |
| 技术 | Driver 可能无法准确上报模型上下文使用量 | 滚动过早或触发过晚 | 待验证 | Spike 对比 Provider/Driver 遥测与本地估算；阈值只允许调低 |
| 质量 | Agent 生成的交接叙述可能遗漏或失真 | 下游任务基于错误上下文执行 | 已识别 | 权威字段由 Bridge/Git/验证器生成，叙述字段标记来源并接受审查 |
| 隔离 | Bridge 无法控制部分 Codex GUI 是否新开窗口 | 规划阶段仍可能受到旧 UI 上下文影响 | 已识别 | 新需求新建 Codex 任务操作规范；Bridge 对受管 Session 执行协议级硬隔离 |
| 容量 | 关联任务过多导致 Context Package 再次膨胀 | 消耗上下文并引入无关信息 | 已识别 | 只允许显式选择 Handoff，记录包清单和哈希，不自动遍历全部关系 |
| 可用性 | 仪表盘信息密度或侧边详情层级不足 | 用户仍需回到日志定位阶段、审批或异常 | 已验证 | 用户完成 v2 可操作原型验证并确认核心行为符合预期；拒绝语义已补充为返回 Codex 重新规划 |
| 安全 | localhost 页面或管理写操作被非预期来源调用 | 产生越权审批、取消或清理 | 待决策 | 技术评审同源限制、CSRF 防护、启动令牌/本地会话及写操作幂等与审计 |

## 23. 决策记录

| 日期 | 决策 | 来源 | 影响 |
|---|---|---|---|
| 2026-07-19 | 开发独立 Agent Bridge 连接 Codex 与 Code Agent | 用户明确要求并确认中立化调整 | 建立中立协作控制层 |
| 2026-07-19 | Codex 负责项目级协调和最终集成，受管 Agent 负责合同范围内执行 | 用户接受前序设计并确认中立化调整 | 禁止双 Coordinator 平级竞争 |
| 2026-07-19 | MVP 采用本地、单用户、单机部署 | 用户明确确认 | 不开发账号、多租户和远程 Worker |
| 2026-07-19 | 不共享完整会话，只交换合同、事件和产物 | 前序方案被用户接受 | 降低上下文污染和敏感数据暴露 |
| 2026-07-19 | 使用 Node.js 22+、TypeScript 和 pnpm monorepo | 用户接受技术栈建议 | 通过独立 Driver 包边界接入候选并保留云端演进能力 |
| 2026-07-19 | Bridge Core 仅依赖 Agent Driver 协议 | 用户接受任意 Agent 扩展建议 | 新 Agent 通过 Driver 接入，不修改领域核心 |
| 2026-07-19 | 具体 Agent SDK、Server 或 CLI 只存在于独立 Driver 子进程 | 用户确认 Driver 中立化 | 保持协议控制和进程隔离，不让供应商 SDK 泄漏到 Core |
| 2026-07-19 | Codex 使用 MCP stdio 调用 Bridge，内部 Worker 使用独立 Driver 协议 | 用户接受接口分层建议 | 避免将 MCP 强行作为调度和远程 Worker 协议 |
| 2026-07-19 | 本地 SQLite/Outbox/文件 Artifact 通过接口抽象 | 用户接受云端演进建议 | 后续可替换为 PostgreSQL、消息系统和对象存储 |
| 2026-07-19 | 主 Driver 与降级 Driver 通过统一 Spike 门禁选定，Bridge 提供权威事件扇出 | 用户确认调整边界 | 移除 Cline Hub 和 IDE 插件硬依赖，保持产品语义供应商中立 |
| 2026-07-19 | 按推荐方案定稿 OQ-004 全部规则 | 用户明确确认 | 权限、租约、版本、独立验证、状态机、失败恢复和默认限制具备确定行为 |
| 2026-07-19 | 新需求强制独立 Session，同需求允许续接或滚动，相关需求仅通过版本化 Handoff 传递上下文 | 用户确认本次 PRD 更新计划 | 将上下文隔离从操作习惯升级为 Bridge 强制规则，并保留任务间必要知识 |
| 2026-07-19 | Cline SDK/Hub `0.0.65` 保留为历史阻塞候选，不再作为 MVP 唯一主路径 | Cline Spike 结果和用户确认调整边界 | 选型必须依据运行时 Contract 证据，不依据产品名称或官方说明 |
| 2026-07-22 | OpenCode `1.18.3` 选为 MVP 主 Driver，Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 选为 MVP 降级 Driver | A 层、B-simulated、B-real 证据及用户确认 | OQ-002 关闭，正式 Driver Contract 与实现解除阻塞 |
| 2026-07-22 | Codex App 保持用户交互、规划、授权和最终审查入口；Codex SDK B 层延期 | B 层候选范围与用户确认 | 保留 Codex SDK A 层证据，不把延期解释为失败 |
| 2026-07-22 | OpenCode 与 Claude Agent SDK 共用 DeepSeek，仅提供 Driver 级降级 | Provider 预检、B-real 证据及用户风险接受 | Provider 级灾备作为后续能力，不纳入 MVP 已承诺范围 |
| 2026-08-11 | Phase 4.1 宿主外 B-simulated 与最小全 Bridge B-real 两项验收均通过 | 正式 Driver、真实 Provider、状态/事件、脱敏和清理证据 | Phase 4.1 完成；付费验证继续保持逐次授权且不进入默认回归 |
| 2026-08-11 | 启动 Phase 4.2，首版采用项目命令或 Codex 启动的本地 Web 管理页 | 用户明确确认轻量浏览器方案 | 不开发首版桌面封装；内部 HTTP 接口服务于页面 |
| 2026-08-11 | 页面只观察、审批和控制既有任务，不承担任务创建 | 用户明确说明任务先在 Codex 中完成初版设计再下发 | Codex/MCP 继续负责 TaskContract 生成与任务下发 |
| 2026-08-11 | 首页采用运行中、待审批、异常三个高优先级区域 | 用户确认候选首页结构 | 首页定位为运行与处置仪表盘，历史任务独立展示 |
| 2026-08-11 | 审批和异常使用右侧详情面板，高风险动作二次确认 | 用户确认交互决策 | 普通审批可在面板完成；重试、取消、清理不得一键执行 |
| 2026-08-11 | 运行进度只使用阶段式表达，不显示百分比 | 用户明确否定百分比进度 | UI 必须展示阶段、步骤、事件、耗时和等待原因 |
| 2026-08-11 | 总体运行摘要默认“今日”，可切换本次会话和最近 7 天 | 用户确认汇总信息候选方案并通过 v2 原型 | 汇总任务数、运行中、需处理、Token、耗时区间和 Token 构成先于运行与处置区展示 |
| 2026-08-11 | 拒绝审批阻止当前方案并带反馈返回 Codex 重新规划 | 用户确认拒绝后的期望行为 | 不取消整个任务、不继续等价动作；越出合同或权限的新路径再次审批 |
| 2026-08-11 | Phase 4.2 v2 可操作原型通过 | 用户完成验证并确认无其他问题 | 产品需求与交互原型收口；下一门槛为 OQ-006 技术与安全合同 |
| 2026-08-11 | OQ-006 本地管理页技术与安全合同关闭 | 用户确认 ADR-0003、HTTP/JSON + SSE v1 合同与 Contract 测试矩阵 | 冻结原生 TypeScript、Node 内置 HTTP、SSE、localhost 会话防护、写入并发和实施门禁；Phase 4.2 研发就绪 |

## 24. 开放问题

### OQ-001：实现技术栈（已关闭）

- 状态：已决策
- 决策：Node.js 22+、TypeScript、pnpm monorepo。
- 来源：用户于 2026-07-19 接受技术栈建议。
- 影响：使用 TypeScript 领域核心、MCP Server、Driver 子进程和 JSON Schema 工具链。

### OQ-002：Agent Driver 接入方式（已关闭）

- 状态：已决策
- 决策：OpenCode `1.18.3` 为 MVP 主 Driver；Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 为 MVP 降级 Driver；具体 SDK、Server 或 CLI 运行在独立 Driver 子进程；Bridge Core 只依赖 Driver Protocol；Agent UI 和 IDE 插件不是执行依赖；Bridge 提供权威事件扇出。
- 边界：Codex App 是用户交互、规划、授权和最终审查入口；Codex SDK 保留 A 层通过证据但本轮 B 层延期。两个正式 Driver 共用 DeepSeek，只提供 Driver 级降级，不构成 Provider 级灾备。
- 来源：Cline Spike、Agent Driver A 层/B-simulated/B-real 结果，以及用户于 2026-07-22 对最终选型和不重复付费运行的确认。
- 持续验证：默认 CI 使用 Fake Driver、Contract 测试和无凭据兼容性测试；真实 Provider 测试必须逐次单独授权。硬门禁失败不得通过评分或 Prompt 约定补偿。

### OQ-003：GitHub 是否作为 MVP 强依赖

- 状态：开放问题
- 是否阻塞研发：否
- 推荐默认：MVP 只强依赖本地 Git；GitHub PR 和 Actions 作为后续可插拔集成。
- 影响：远程审计、CI 和 PR 交接能力。

### OQ-004：权限、状态与失败策略（已关闭）

- 状态：已决策
- 决策：按本文 BR-005 至 BR-009、BR-011 至 BR-012、BR-019 至 BR-020、状态机、第 14 至 16 节以及 US-003、US-005 定稿。
- 来源：用户于 2026-07-19 确认 OQ-004 全部规则；后续 Driver 中立化不改变这些产品行为。
- 影响：研发不得自行改变默认拒绝、租约冲突、任务版本、独立验证、角色隔离、凭据保护、状态转换和失败恢复行为。

### OQ-005：需求会话隔离与上下文交接（已关闭）

- 状态：已决策
- 决策：按 FR-016、BR-021 至 BR-030、第 7.4 至 7.5 节、11.4 节、12.2 节、14.5 节和 US-007 定稿。
- 来源：用户于 2026-07-19 表示认可完整分析，并确认将会话隔离、上下文滚动与结构化交接计划更新到原 PRD。
- 影响：研发不得使用 UI 窗口或最近会话推断任务作用域；必须实现 TaskVersion、Run、Session 绑定、70% 滚动阈值、白名单 Context Package 和 Handoff 完整性校验。

### OQ-006：Phase 4.2 本地管理页技术与安全合同（已关闭）

- 状态：已决策；用户于 2026-08-11 确认。
- 技术来源：[ADR-0003](../adr/0003-local-dashboard-technical-and-security-contract.md)、[HTTP/JSON + SSE v1 合同](../contracts/phase-4-2-management-http-sse-v1.md)和 [Contract 测试矩阵](../testing/phase-4-2-management-contract-test-matrix.md)。
- 技术栈：原生 TypeScript/HTML/CSS、Node.js 22 内置 `node:http`、SSE；不采用 React/Vite/Hono，不新增外部运行时依赖。
- 进程与权威边界：同一 `runtime_root` 只允许一个 Bridge 应用实例，共享 MCP、HTTP/SSE、Runtime、应用服务与事件扇出；页面和内部接口不得直读写 SQLite、Artifact、Driver 或 Worker 私有状态。
- 访问保护：只监听 `127.0.0.1` 随机端口；使用一次性 fragment 启动秘密、实例隔离 host-only Cookie、精确 Host/Origin、同源读取标记和 CSRF；不开放 CORS。
- 一致性：SSE 只发送安全投影失效通知，使用持久事件游标恢复；断线或未追平期间服务端强制禁止管理写操作。
- 写入合同：审批、重试、取消和清理必须同时验证幂等键、ETag、当前事件游标和活动 stream；重试、取消和清理还需要绑定目标修订的 60 秒确认 Token。
- 状态语义：拒绝持久化反馈并以既有 `interrupted/INTERRUPTED` 语义阻止当前方案，返回 Codex 重新规划；重试保留旧 Run，并基于同一冻结 TaskVersion 创建新 Run 与 Session；清理不得删除 Task、事件、审计、Artifact 或保留 worktree。
- 安全与测试：响应和日志使用严格白名单及脱敏；静态资源固定 manifest；自动 opener 只在恢复和监听成功后执行；105 项 Unit/Contract/Security/Integration/Startup/E2E 用例作为实施门禁。
- 实施授权：OQ-006 关闭仅表示研发无需自行猜测合同，不自动授权实现、安装依赖、真实 Provider、提交、推送或 PR。

## 25. 研发交付检查

- [x] 问题、用户、场景和结果清楚。
- [x] MVP、非目标和方案取舍清楚。
- [x] 核心流程和职责边界清楚。
- [x] 本地、单用户、单机部署已确认。
- [x] 核心对象、数据合同和状态方向已定义。
- [x] 正常、失败、取消、返工和恢复路径已覆盖。
- [x] 验收场景可以转化为自动化测试。
- [x] 技术栈已确认。
- [x] 主 Driver 与降级 Driver 已通过统一 Spike 并确认。
- [x] 任意 Agent 扩展、跨机和云端演进边界已确认。
- [x] 权限、状态和失败策略已确认并转为已决策。
- [x] 所有阻塞正式 Driver 实现的开放问题已关闭。
- [x] Agent UI/IDE 非执行依赖、Bridge 权威事件扇出和独立 Driver 边界已确认。
- [x] 新需求、同需求返工、新 TaskVersion 和手工重跑的 Session 选择规则已确认。
- [x] 上下文检查点、70% 滚动阈值和降级恢复路径已确认。
- [x] Project Baseline、Context Package、Handoff、任务关系和陈旧依赖规则已确认。
- [x] 核心流程、权限、状态、规则、数据契约、异常和验收行为可追溯。
- [x] Phase 4.2 用户任务、MVP、非目标、页面职责和高风险边界已确认。
- [x] Phase 4.2 可操作原型已验证并将反馈回写 FR、BR、异常和验收场景。
- [x] OQ-006 localhost、HTTP/SSE、幂等、断线恢复、错误映射和技术栈合同已关闭。
- [x] Phase 4.2 Contract 测试矩阵已完成，研发无需自行猜测安全或接口行为。

当前结论：PRD 更新为 `v1.8 / Phase 4.1 已完成、Phase 4.2 研发就绪但尚未授权实现`。FR-012 已定稿产品行为，ADR-0003、HTTP/JSON + SSE v1 合同和 Contract 测试矩阵已关闭 OQ-006。Phase 4.2 不再存在阻塞研发的开放问题；OQ-003 继续为非阻塞项。进入实现、安装依赖、真实 Provider 或 Git 发布仍需各自遵循授权边界。

## 26. 新研发任务启动指令

将本 PRD、已验证的 v2 原型、ADR-0003、HTTP/JSON + SSE v1 合同和 Contract 测试矩阵作为 Phase 4.2 实现上下文。开始任何实现前仍需获得用户单独授权：

1. 检查目标工作区、Git 状态和已有技术栈。
2. 使用已确认的 Node.js 22+、TypeScript 和 pnpm monorepo，不重新选择主技术栈。
3. 保持 Bridge Core、Driver Protocol、OpenCode Driver、Claude Agent Driver、Worker Runtime 和 Storage 的依赖边界。
4. 正常运行不得依赖 Agent UI 或 IDE；Bridge 负责权威状态、事件持久化和观察端扇出。
5. 使用已经通过统一选型 Spike 的 OpenCode 主 Driver 和 Claude Agent SDK 降级 Driver；未经逐次单独授权不得执行真实 Provider 测试。
6. 复用已完成的 TaskVersion、TaskRelation、AgentSessionBinding、ContextPackage、HandoffPackage 和 ContinuationSnapshot，不允许旁路这些权威对象。
7. 新需求和新 TaskVersion 必须创建新 Session；同版本返工可续接；达到 70% 阈值必须在安全边界滚动；任何跨版本复用必须返回稳定错误码。
8. 按测试矩阵 Slice A 至 E 顺序实施；先完成管理读模型与 usage 事实，再修正共享管理命令，之后才实现 HTTP/SSE 与页面。
9. 正式 Driver 已实现；后续 Provider 配置和凭据只在 Worker/Driver 边界扩展，不得让具体 Provider SDK 或秘密泄漏到 Bridge Core/Driver Protocol。不得重新开放已关闭的产品决策，除非新的兼容性证据证明当前方案技术上不可行。
10. 不得提交模型凭据、本地数据库、Agent 运行记录、临时 worktree、本地 Agent 规则和过程规划文件。
11. 严格实现已冻结的 localhost 访问保护、同源/CSRF、HTTP/JSON + SSE Schema、游标恢复、幂等/并发、错误映射、脱敏、自动 opener 和静态资源合同，不得在实现中自行改口径。
12. 使用已决定的原生 TypeScript/HTML/CSS、Node.js 22 内置 HTTP 与 SSE；不得自行引入 React、Vite、Hono、公共 API、通用管理 CLI、桌面封装或任务创建。
13. 默认不新增外部运行时依赖，预期 `pnpm-lock.yaml` 不变化；实现、依赖、真实 Provider、提交、推送和 PR 分别遵循明确授权门禁。
