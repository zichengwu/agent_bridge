# ADR-0001：MVP Agent Driver 选型

- 状态：已接受
- 日期：2026-07-22
- 决策范围：Agent Bridge MVP 主 Driver、降级 Driver 与 Provider 故障域

## 背景

Agent Bridge 的领域核心必须保持 Driver 中立，不能直接依赖某个 Agent SDK、CLI 或可见 UI。Cline SDK/Hub `0.0.65` 的主路径曾受上游发布包阻塞，因此项目改用统一硬门禁比较 OpenCode、Claude Agent SDK 和 Codex SDK，并把具体 Agent 限制在独立 Driver 子进程中。

选型验证分为三层：

1. A 层：无真实 Provider、无费用，验证固定版本加载、Headless 启动、Session 标识、结构化事件、取消接口、配置隔离和进程清理。
2. B-simulated：使用 loopback 模拟 Provider，验证权限等待/允许/拒绝、执行中取消、Session 恢复、独立 worktree、Git Handoff、费用计数、网络与写入边界。
3. B-real：经用户逐次授权，通过受控 loopback 网关访问 DeepSeek，验证真实 Provider 下的相同能力、模型/路径白名单、usage、费用熔断和清理。

## 决策

1. OpenCode `1.18.3` 作为 MVP 主 Driver，通过 DeepSeek OpenAI 兼容接口使用 `deepseek-v4-pro`。
2. Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 作为 MVP 降级 Driver，并承担独立只读复核，通过 DeepSeek Anthropic 兼容接口请求 `deepseek-v4-pro[1m]`；网关线上模型证据必须为 `deepseek-v4-pro`。
3. Codex App 保持用户下发任务、规划、授权和最终审查的交互入口。Codex SDK `0.144.6` 保留 A 层通过证据，但本轮 B 层延期；延期不是失败结论。
4. OpenCode 与 Claude Agent SDK 共用 DeepSeek，因此本方案只提供 Driver、SDK、运行时和 Session 路径级降级，不提供 Provider 级灾备。
5. Bridge Core 只依赖版本化 Driver Protocol。OpenCode 和 Claude 的 SDK、Server、CLI、配置与 Provider 映射只能存在于各自的独立 Driver 包和子进程中。
6. 默认 CI 不调用真实付费模型。任何真实 Provider 兼容性测试继续要求显式环境授权、TTY 无回显临时凭据、价格新鲜度检查和费用确认。

## 证据

### A 层与 B-simulated

- OpenCode、Claude Agent SDK 和 Codex SDK 均通过 A 层固定版本、Headless、结构化事件、取消、隔离和零残留检查。
- OpenCode 与 Claude Agent SDK 均通过 B-simulated；`realProviderRequests=0`，临时目录清理完成，最终后代进程残留为 `0`。

### B-real

2026-07-22，用户授权协作命令使用两个不同的临时 DeepSeek Key，单候选应用层上限为 `$0.12`，总上限为 `$0.24`。结果如下：

| 候选             | 请求 | 输入 token | 输出 token |        费用 | HTTP/模型                      | 结果 |
| ---------------- | ---: | ---------: | ---------: | ----------: | ------------------------------ | ---- |
| OpenCode         |    4 |     24,988 |        541 | `$0.011341` | 全部 `200` / `deepseek-v4-pro` | 通过 |
| Claude Agent SDK |    9 |      4,245 |        825 | `$0.002565` | 全部 `200` / `deepseek-v4-pro` | 通过 |
| 合计             |   13 |     29,233 |      1,366 | `$0.013906` | 无拒绝、无错误、未熔断         | 通过 |

两个候选均通过 Session、结构化事件、权限等待/允许/拒绝、执行中取消、同候选 Session 恢复、独立 worktree 写入、Git 验证和 Handoff/复核。报告记录 `temporaryRootRemoved=true`、`finalResidualProcessCount=0`。

报告写入后，外层 CLI 曾因 TTY 输入句柄仍被引用而未自然退出；当时 Provider、网关和候选子进程已经退出，脱敏报告已经完整写入。该缺陷随后在 Spike 范围内修复，并通过伪 TTY 双 Key 读取/自然退出测试以及完整 `pnpm verify`。用户接受不再次付费重跑，因此此缺陷不否定已形成的真实 Provider 能力证据。

详细证据见 `docs/spikes/agent-driver-selection.md`。本次本地脱敏报告 `tmp/driver-selection-b/real-report.json` 的 SHA-256 为 `82a08e0cee1e7ebc9f09248f723a72c81a4a1469a1262a86c2052c2cd694872f`。

## 影响

### 正面影响

- 正式 Driver 实现解除选型阻塞，可围绕已经验证的 Session、事件、权限、取消、恢复和 Handoff 语义固化 Contract。
- 主 Driver 与降级 Driver 使用独立包、进程、配置、凭据和 worktree，保持 Bridge Core 供应商中立。
- Claude 可以在 OpenCode 路径故障时执行显式降级，也可以在独立 worktree 中进行只读复核。

### 代价与限制

- 两个 Driver 共用 DeepSeek，无法覆盖 DeepSeek 平台故障、区域故障、账户停用、余额耗尽、统一限流或模型下线。
- Claude 的 `deepseek-v4-pro[1m]` 请求依赖 DeepSeek Anthropic 兼容映射，正式兼容性测试必须继续核验线上模型证据，不能只相信配置名称。
- 真实 Provider 测试有费用且缺少 Provider 侧账户硬预算，不能成为默认 CI；应用层熔断仍可能被单个在途请求轻微超过。
- Codex SDK 的真实 Provider 能力尚未形成 B 层证据，不能把它声明为当前生产降级 Driver。

## 未采用方案

- **Codex SDK 作为当前降级 Driver**：A 层通过，但本轮 B 层延期，真实权限、恢复和 Provider 行为证据不足。
- **Cline Hub 作为主路径**：上游发布包阻塞，保留历史 Spike 证据但不作为 MVP 主执行路径。
- **在本轮同时引入第二个 Provider**：会扩大凭据、费用、兼容协议和故障矩阵；作为后续 Provider 灾备能力处理，不阻塞 MVP。
- **让 Bridge Core 直接导入候选 SDK**：会破坏 Driver 中立和未来远程 Worker 演进边界，因此拒绝。

## 后续工作

1. 固化正式 Driver Contract、能力声明、事件映射和 Contract 测试。
2. 创建独立 `driver-opencode` 与 `driver-claude-agent` 包，禁止供应商 SDK 泄漏到 `packages/core`。
3. 将可复现且无凭据的 Spike 场景迁移为正式兼容性测试。
4. 保留真实 Provider 测试的逐次授权、费用上限、网络白名单、脱敏和清理门禁。
5. 后续评估使用不同 Provider 的灾备 Driver，不把当前 Driver 级降级宣传为 Provider 级高可用。
