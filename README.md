# Agent Bridge

Agent Bridge 是运行在开发者本机的单用户、单机协作控制层，用于在 Codex 与 Cline 之间传递结构化任务、执行事件和可验证产物。

当前仓库处于 MVP 工程初始化阶段。产品行为以 `docs/prd/agent-bridge-prd.md` 为基线。

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
