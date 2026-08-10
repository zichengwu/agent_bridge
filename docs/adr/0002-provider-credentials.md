# ADR-0002：Provider 配置与 Driver 凭据边界

- 状态：已接受
- 日期：2026-08-11
- 决策范围：Phase 4.1 本地运行时 Provider 配置、凭据来源与子进程注入

## 决策

1. `schema_version: 2` 只版本化非敏感 Provider 字段：Provider ID、base URL、model、工具权限、轮次和预算。运行时配置、argv 和 Driver Protocol JSONL 禁止 Token、API Key、Cookie、登录态和 Authorization 值。
2. OpenCode 只允许 `AGENT_BRIDGE_OPENCODE_API_KEY`；Claude 只允许 `AGENT_BRIDGE_CLAUDE_AUTH_TOKEN`。Bridge 构造完全替换的最小子进程环境，不透传父进程环境。
3. 可选 JSON 凭据文件必须由用户配置绝对路径，位于产品仓库、worktree、`runtime_root` 和 Artifact 根之外；必须是当前用户所有、无符号链接的普通文件，Unix 权限为 `0400` 或 `0600`。
4. JSON 文件使用严格 Driver 专属 Schema。环境与文件冲突、缺少凭据、宽松权限、错误 owner、未知字段或路径越界均 fail closed，并返回稳定、脱敏、不可重试的配置错误。
5. Bridge 只在 preflight/Driver 创建时最小读取文件；秘密注入子进程后不进入 SQLite、Artifact、事件、日志、错误详情、命令参数或 stdio 初始化对象。

## 结果

- Bridge Core 和 Driver Protocol 保持供应商与秘密无关。
- B-simulated、正式 loopback E2E 和真实 Provider 验收可以复用同一公开非敏感配置合同，但凭据来源和授权等级彼此独立。
- 若未来 Driver 只能通过 stdio 或持久化对象接收秘密，该 Driver 的文件凭据分支必须停止，不得降低本 ADR 的边界。
