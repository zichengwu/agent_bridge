# Agent Bridge

Agent Bridge 是运行在开发者本机的单用户、单机协作控制层，用于在 Codex 与可替换 Code Agent 之间传递结构化任务、执行事件和可验证产物。

当前仓库已完成 MVP 工程初始化、Cline 技术 Spike 和 Agent Driver 选型。产品行为以 `docs/prd/agent-bridge-prd.md` 为基线；Bridge Core 只依赖版本化 Driver Protocol，不依赖具体 Agent SDK。

Phase 2 第一开发切片与切片 2A 已经完成：`packages/driver-protocol` 提供版本为 `1.0` 的供应商无关 Driver Contract、统一事件类型和运行时断言；`packages/driver-opencode` 已实现 OpenCode `1.18.3` 主 Driver，并通过 Fake Runtime Contract 测试和完全无 Provider 的 Headless 控制面兼容性测试。OpenCode B-simulated 场景迁移和 Claude Agent 降级 Driver 仍属于后续切片。

## 环境要求

- Node.js 22 或更高版本
- pnpm 11.9.0
- Git
- SQLite

## 本地验证

```bash
pnpm install
pnpm verify
```

默认验证不调用真实模型，也不产生模型费用。

## Agent Driver 选型状态

OpenCode `1.18.3` 已选为 MVP 主 Driver，Claude Agent SDK `0.3.215` / Claude Code `2.1.215` 已选为 MVP 降级 Driver。Codex SDK 保留 A 层证据，B 层验证延期。

OpenCode 与 Claude Agent SDK 当前共用 DeepSeek，只提供 Driver 级降级，不构成 Provider 级灾备。默认验证不得读取真实 Agent 配置或调用付费模型；任何真实 Provider 验证都必须逐次获得明确授权。

## 历史 Cline 技术验证

```bash
pnpm spike:cline:check
pnpm spike:cline:local
pnpm spike:cline:hub
```

`@cline/sdk@0.0.65` 的 Local 模式验证通过，Hub 模式被上游发布包缺陷阻塞，因此 Cline 不再是 MVP 唯一主路径。该代码暂时保留用于复现，详见 `docs/spikes/cline-sdk-hub.md`。
