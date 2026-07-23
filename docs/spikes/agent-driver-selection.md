# Agent Driver 选型 Spike 报告

## 1. 文档状态

- 日期：2026-07-19 至 2026-07-22
- Node.js：`v24.14.0`（项目最低要求为 Node.js 22）
- pnpm：`11.9.0`
- 验证范围：OpenCode、Claude Agent SDK、Codex SDK
- 授权层级：A 层无费用验证；B-simulated 无费用验证；B-real 经用户单次明确授权执行
- 暂缓候选：Gemini CLI、OpenHands、Aider、Cline
- 最终结论：**OpenCode `1.18.3` 选为 MVP 主 Driver，Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 选为 MVP 降级 Driver；两者均通过适用的 A 层、B-simulated 和 B-real 硬门禁。Codex SDK 保留 A 层通过证据但本轮 B 层延期。**

### 1.1 后续 B 层候选调整（2026-07-21）

上述阶段结论是 2026-07-19 A 层完成时的历史判断，A 层证据和排序依据保持不变。经后续 Provider、协议和费用预检，用户确认本轮活动 B 层候选调整为：

- OpenCode 继续作为主 Driver 候选，通过 DeepSeek OpenAI 兼容接口使用 `deepseek-v4-pro`。
- Claude Agent SDK 调整为降级 Driver 候选，通过 DeepSeek Anthropic 兼容接口使用 `deepseek-v4-pro[1m]`，并在网关证据中核验没有静默映射到其他模型。
- Codex App 继续作为用户下发任务、规划、授权和最终审查的交互入口。
- Codex SDK 保留本报告中的 A 层通过证据和固定版本 Harness，但本轮不进入活动 B 层；这是延期，不是失败结论。

OpenCode 与 Claude Agent 共用 DeepSeek 这一 Provider 故障域，因此当前降级只覆盖 Driver、SDK、运行时和 Session 路径问题，不覆盖 DeepSeek 平台级故障。B-real 已于 2026-07-22 完成，真实 Session、工具、权限、取消、恢复、用量和清理证据见 1.4 节。

### 1.2 B 层本地模拟 Harness 结果（2026-07-21）

已使用无凭据 loopback Provider 完成 `B-simulated` 验证。OpenCode `1.18.3` 和 Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 均通过本地控制面检查，报告中的 `realProviderRequests` 为 `0`，未访问 DeepSeek 或其他外网，未调用真实模型，未产生费用。

验证证据包括：

- OpenCode 在隔离环境和 `opencode-exec` worktree 中建立 Session，产生结构化文本、工具调用与结果，经历权限等待和允许，完成 Git 修改；权限拒绝、执行中取消、OpenCode Server 退出后的同 Session 恢复均通过。
- Claude 在完全替换环境、独立 `HOME` / `TMPDIR` / `CLAUDE_CONFIG_DIR`、`settingSources: []` 和独立 worktree 中完成降级写入、权限等待与拒绝、执行中取消、同 Session 恢复，以及对 OpenCode patch 的独立只读复核。
- 一次性最小 Git 仓库包含 `opencode-exec`、`claude-review`、`claude-fallback` 三个 worktree；Handoff 只传递 patch、文件列表和哈希，不共享私有 Session 或配置。
- 本地网关固定监听 `127.0.0.1`，只接受一次性合成 Token、白名单 Host/路径/模型和 JSON 请求；请求数、输入/输出 token、模拟费用及熔断状态均进入审计。Claude 配置模型为 `deepseek-v4-pro[1m]`，本地协议线上观测到的模型字段为 `deepseek-v4-pro`；该线上模型证据随后在 1.4 节的 B-real 中得到确认。
- OpenCode 与 Claude 子进程均由 macOS 网络沙箱限制为 loopback；写入范围由独立 worktree、Driver 权限和运行后 Git 文件白名单共同验证。所有隔离目录均被删除，最终后代进程残留数为 `0`。
- 日志脱敏覆盖 Provider 错误、Bearer Token、常见凭据字段、显式合成 Token 和隔离路径。

可复现的无费用命令：

```bash
pnpm spike:drivers:b:preflight
pnpm spike:drivers:b:check
pnpm spike:drivers:b:report
pnpm spike:drivers:b:cleanup
```

以下命令是受保护的真实验证入口。缺少显式环境授权、TTY、价格确认或临时 Key 时默认失败关闭；2026-07-22 仅对协作命令完成了一次有效授权执行：

```bash
pnpm spike:driver:opencode:b
pnpm spike:driver:claude:b
pnpm spike:drivers:b:collaboration
```

本地模拟通过不构成最终 Driver 选型。Codex SDK 的 A 层证据继续保留且本轮 B 层延期，不得据此判定失败。

### 1.3 B-real 受控传输层（2026-07-22）

B-real 传输层已经在 Spike 边界内实现并完成一次有效授权运行。实现将 OpenCode 和 Claude 候选继续限制在 loopback，并为两者分别启动只允许访问固定 DeepSeek HTTPS Origin 和路径的网关子进程。真实 Key 通过独立文件描述符交给网关，不进入候选环境、命令参数、普通日志或报告；两个候选使用不同临时 Key。

官方文档只读核验确认：OpenAI兼容入口使用 `https://api.deepseek.com`，Anthropic兼容入口使用 `https://api.deepseek.com/anthropic`；Anthropic接口接受 `x-api-key`，且不支持的模型名可能被自动映射为 `deepseek-v4-flash`。因此网关同时校验请求模型和响应证据，任何缺失或非 `deepseek-v4-pro` 模型都使真实 B 层失败。

2026-07-22 官方美元价格快照为：V4 Pro 缓存命中输入 `$0.003625`、缓存未命中输入 `$0.435`、输出 `$0.87`/百万 token。网关按缓存未命中价格预留费用，并执行单候选 `$0.12`、协作总计 `$0.24` 的应用层熔断。DeepSeek 未提供账户级硬预算设置；用户明确接受缺少 Provider 侧硬上限及单个在途请求可能轻微超出应用层预估的风险后，授权了本次执行。

### 1.4 B-real 真实 Provider 结果（2026-07-22）

用户通过 TTY 明确授权 `B_LAYER_AUTHORIZED=1 pnpm spike:drivers:b:collaboration`，提供两个不同的临时 DeepSeek Key，并确认单候选 `$0.12`、总计 `$0.24` 的应用层费用上限。执行只允许访问 `api.deepseek.com`，未读取真实 Agent 配置、系统钥匙串或登录状态。

| 候选         | 真实请求 | 输入 token | 输出 token |        费用 | 路径                     | 结果 |
| ------------ | -------: | ---------: | ---------: | ----------: | ------------------------ | ---- |
| OpenCode     |        4 |     24,988 |        541 | `$0.011341` | `/chat/completions`      | 通过 |
| Claude Agent |        9 |      4,245 |        825 | `$0.002565` | `/anthropic/v1/messages` | 通过 |
| 合计         |       13 |     29,233 |      1,366 | `$0.013906` | 仅白名单路径             | 通过 |

真实执行证据：

- 13 个请求全部返回 HTTP `200`；网关线上观测模型均为 `deepseek-v4-pro`，没有映射到 Flash 或其他模型。
- 两个候选的 Session、结构化事件、权限等待/允许/拒绝、执行中取消、进程退出后恢复、独立 worktree 写入和验证均通过。
- OpenCode 完成执行与 Handoff；Claude 在独立 worktree 完成降级写入和只读复核，没有共享私有 Session、配置或凭据。
- `rejectedRequests=0`、`errorClasses=[]`、`circuitOpen=false`；单候选和总费用均低于应用层上限。
- 报告记录 `temporaryRootRemoved=true`、`finalResidualProcessCount=0`。脱敏报告位于本地 `tmp/driver-selection-b/real-report.json`，本次报告 SHA-256 为 `82a08e0cee1e7ebc9f09248f723a72c81a4a1469a1262a86c2052c2cd694872f`。
- 报告写入后，外层 CLI 因 TTY 输入句柄仍被引用而未自然退出；此时 Provider、网关和候选子进程已经退出，报告已经完整写入。该 Spike 范围缺陷随后通过显式释放 TTY 引用修复，并通过伪 TTY 双 Key 读取/自然退出测试及完整 `pnpm verify`。用户接受不再次付费重跑，因此该问题记录为运行后编排缺陷，不否定已经形成的真实 Provider 能力证据。

## 2. 固定依赖版本

| 候选             | SDK                                      | 随包运行时              |
| ---------------- | ---------------------------------------- | ----------------------- |
| OpenCode         | `@opencode-ai/sdk@1.18.3`                | `opencode-ai@1.18.3`    |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.215` | Claude Code `2.1.215`   |
| Codex SDK        | `@openai/codex-sdk@0.144.6`              | `@openai/codex@0.144.6` |

依赖使用精确版本并写入 `pnpm-lock.yaml`。OpenCode 安装脚本会执行运行时版本检查；若不隔离安装环境，会尝试创建真实用户 `~/.local`。因此安装和 CI 必须提供临时 `HOME`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME` 和 `XDG_CACHE_HOME`。

## 3. 安全边界

Harness 在每次候选运行前创建全新的临时目录，并替换而非继承 Agent 子进程环境：

- `HOME`、`TMPDIR`、XDG 配置/数据/缓存目录均为临时目录。
- Claude 使用独立 `CLAUDE_CONFIG_DIR`，且 `settingSources: []`。
- Codex 使用独立 `CODEX_HOME`。
- OpenCode 使用独立配置文件和配置目录，关闭插件、MCP、formatter、LSP、自动更新和共享。
- A 层和 B-simulated 不向候选子进程传递真实 Provider 凭据；B-real 临时 DeepSeek Key 仅通过独立文件描述符传给本地网关，不进入候选环境、argv、普通日志或报告。
- A 层的 Claude 和 Codex Provider Base URL 指向仅监听 `127.0.0.1` 的固定 401 sink；B 层 OpenCode 和 Claude 只访问各自的 loopback 网关。
- Codex 关闭 apps、plugins、remote plugin、plugin sharing、更新、分析和反馈；否则 `0.144.6` 会在启动时尝试同步 `https://github.com/openai/plugins.git`。
- Codex 任务配置为只读 Sandbox、禁用任务网络和 Web Search、`approvalPolicy=never`。
- A 层 OpenCode 拒绝编辑、Shell、Web Fetch、循环和工作目录外访问；B 层只允许独立 worktree 内的受控编辑，继续拒绝 Shell、Web Fetch 和越界路径。
- 每轮结束追踪全部后代进程，等待正常退出后再检查；最终均为零残留。
- 报告错误会替换隔离路径，并对合成 API Key、Bearer Token 和常见凭据字段执行脱敏测试。

本轮没有读取真实 `~/.codex`、`~/.claude`、OpenCode 用户配置、系统钥匙串或登录状态。B-real 仅从 TTY 无回显读取用户提供的两个临时 DeepSeek Key，并在使用后清零内存缓冲。

## 4. 能力矩阵

| 验证项                   | OpenCode `1.18.3`                   | Claude Agent SDK `0.3.215`                | Codex SDK `0.144.6`                       |
| ------------------------ | ----------------------------------- | ----------------------------------------- | ----------------------------------------- |
| 固定版本安装与运行时加载 | 通过                                | 通过                                      | 通过                                      |
| Headless 启动/健康边界   | HTTP 健康检查通过                   | Headless query 启动通过                   | Headless CLI 启动通过                     |
| 本地 Session ID          | 创建、查询通过                      | 无 Provider 错误流中取得 ID               | `thread.started` 取得 ID                  |
| A 层恢复接口             | Server 重启后按 ID 读取同一 Session | `resume` 接口存在；B-real 恢复已通过      | `resumeThread` 保留 ID；B 层延期          |
| 结构化事件               | SSE 事件通过                        | `system`、`assistant`、`result`           | `thread.started`、`turn.started`、`error` |
| 取消                     | 空 Session abort 通过               | 预取消在超时内收敛                        | 预取消在超时内收敛                        |
| 权限                     | B-real 等待/允许/拒绝通过           | B-real `canUseTool` 等待/允许/拒绝通过    | 审批配置存在；B 层延期                    |
| 工作目录和配置隔离       | 通过                                | 通过                                      | 通过                                      |
| A 层 Provider 边界       | 未提交 Prompt                       | 本地 401 sink，成功结果为 false、费用为 0 | 本地 401 sink，无完成 turn                |
| B-real                   | 4 请求；费用 `$0.011341`；通过      | 9 请求；费用 `$0.002565`；通过            | 延期                                      |
| 退出后无残留进程         | 通过                                | 通过                                      | 通过                                      |
| 连续两次协议结论一致     | 通过                                | 通过                                      | 通过                                      |

`b-layer-required` 不计为 A 层失败，但不得被解释为相关生产能力已经通过。

## 5. 候选结论

### 5.1 OpenCode：MVP 主 Driver

OpenCode 在不调用模型的情况下提供了本轮最完整的本地控制面：可启动独立 Headless Server、读取健康状态、创建稳定 Session ID、订阅 SSE、取消 Session、调用权限响应接口，并在 Server 重启后读取同一 Session。其 Provider 中立定位也更符合 Agent Bridge 的 Driver 中立目标。

B-real 已验证真实工具事件、权限允许/拒绝/等待、执行中取消、结果与用量、Driver 进程退出后的同 Session 恢复，以及 worktree 写入边界。OpenCode 因控制面完整、Provider 中立接口清晰且真实执行证据通过，选为 MVP 主 Driver。

### 5.2 Codex SDK：A 层原暂定降级 Driver 候选

Codex SDK 的 TypeScript API 和 JSONL 事件边界清晰，`resumeThread`、取消信号、工作目录、Sandbox、网络和审批策略均可由 Bridge 显式传入。它适合作为 Agent Bridge 内部的 Headless Driver；Codex 图形界面是面向人的任务入口，不应被当作 Agent Bridge 的进程内 SDK。

已确认 `0.144.6` 在默认稳定特性开启时会尝试远程同步插件。Spike 必须显式关闭 apps/plugins/remote plugin/plugin sharing，Bridge 的正式 Codex Driver 也应把这组配置作为隔离基线并添加网络回归测试。

该定位只记录 A 层完成时的原始排序。根据 1.1 节的后续决定，Codex SDK 本轮 B 层延期，不再是当前活动降级候选。

### 5.3 Claude Agent SDK：MVP 降级 Driver

Claude Agent SDK 能在替换环境、空设置源和本地 401 Provider sink 下启动随包 Claude Code，产生结构化错误流、Session ID 和零费用结果，并能在预取消后收敛。B-real 进一步验证了真实 Session 恢复、权限回调、取消、独立降级写入和只读复核，因此选为 MVP 降级 Driver。它与 OpenCode 共用 DeepSeek，只提供 Driver 级降级，不构成 Provider 级灾备。

## 6. 可复现命令

安装时隔离真实用户目录：

```bash
env \
  CI=true \
  HOME=/private/tmp/agent-bridge-install-home \
  XDG_CONFIG_HOME=/private/tmp/agent-bridge-install-home/config \
  XDG_DATA_HOME=/private/tmp/agent-bridge-install-home/data \
  XDG_CACHE_HOME=/private/tmp/agent-bridge-install-home/cache \
  pnpm install --frozen-lockfile
```

运行 A 层探针：

```bash
pnpm spike:drivers:check
pnpm spike:driver:opencode
pnpm spike:driver:claude
pnpm spike:driver:codex
pnpm spike:drivers:repeat
pnpm spike:drivers:report
pnpm verify
```

候选运行会启动受控子进程和本地 loopback Server；受限命令沙箱需要允许这些进程，但不需要真实 Provider 网络访问。

## 7. B 层结论与后续授权门禁

本轮 B 层活动范围为 OpenCode + DeepSeek V4 Pro 主 Driver，以及 Claude Agent SDK + DeepSeek V4 Pro 降级 Driver。两者已经完成适用硬门禁，详细实施边界见 `docs/development/agent-driver-selection-b-layer-plan.md`。

本轮已经形成以下真实证据：

1. 每候选一个最小真实任务并验证稳定 Session/Thread ID。
2. 状态、文本、工具调用、结果、错误、完成和用量事件映射。
3. 执行中的取消与确定终态。
4. 权限允许、拒绝和等待。
5. Driver/Worker 进程重启后的真实 Session 恢复。
6. 独立 worktree 写入、越界阻止和 Git 结果采集。
7. 日志中真实 Provider 错误的脱敏复核。
8. 网关记录的目标域名、API 路径和模型字段与计划一致，且 Claude 路径未静默映射到 Flash 或其他模型。
9. OpenCode 执行、Claude 独立只读复核，以及 OpenCode 失败后 Claude 在另一 worktree 执行降级任务的 Handoff 流程。

B-real 通过解除正式 Driver 选型门禁，但不把付费测试变成默认回归。后续任何真实 DeepSeek 调用仍需用户逐次明确授权费用、Provider、模型、超时和凭据注入方式；默认 CI 只运行无凭据的 A 层、B-simulated 和 Contract 测试。

## 8. 本轮文件边界

Spike 实现只新增独立 `spikes/driver-selection/` Harness、测试和报告，并修改根工作区脚本、TypeScript/Vitest 引用及依赖锁文件。选型收口另外更新 PRD、实施计划并新增 ADR。整个阶段没有修改 `packages/core`、领域 Schema、状态机、存储或正式 Driver 包。
