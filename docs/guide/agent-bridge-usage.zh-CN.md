# Agent Bridge 中文使用指南

## 1. 使用边界

Agent Bridge 是本机单用户控制层。它通过 MCP stdio、SQLite、Artifact 和独立 Git worktree 管理 Code Agent，不提供 HTTP、UI、远程 Worker、云控制面或多租户能力。默认验证不读取真实 Agent 配置、登录态、钥匙串或凭据，也不调用真实 Provider。

## 2. 启动前准备

1. 使用 Node.js 22.13+、pnpm 11.9 和 Git。
2. 执行 `pnpm install --frozen-lockfile` 与 `pnpm verify`。
3. 复制 `config/agent-bridge.example.yaml`，填写项目、runtime、项目基线以及两个正式 Driver Worker 的绝对路径。配置中不得写 Token、Cookie、密码或 Agent 登录信息。
4. runtime 目录必须独立于产品仓库；项目基线采用 `config/project-baseline.example.json` 的结构。
5. 从 `config/task-contracts/` 选择角色样例，替换项目事实后重新计算 `content_hash`。

启动：

```bash
pnpm build
pnpm bridge:mcp -- --config /absolute/path/to/agent-bridge.yaml
```

## 3. 角色与权限

| 角色        | 写入能力                       | 命令能力     | 典型用途           |
| ----------- | ------------------------------ | ------------ | ------------------ |
| `developer` | 合同允许的产品、测试和文档路径 | 允许         | 开发与修复         |
| `tester`    | 仅测试类路径                   | 允许         | 编写与执行测试     |
| `reviewer`  | 无                             | 禁止写入命令 | 只读审查与 finding |

任务合同的 `scope` 只能进一步收紧角色权限，不能扩大固定角色模板。Tester 不得以修改产品代码换取测试通过；Reviewer 即使合同误填写路径也不会获得写权限。

## 4. 标准流程

依次使用 `bridge_create_task`、`bridge_validate_task`、`bridge_prepare_context` 与 `bridge_start_task`。运行期间使用查询工具观察 Task、Run、事件、审批和结果；权限请求只能通过 `bridge_respond_to_approval` 响应。审查 finding 必须绑定当前 commit，同一 TaskVersion 最多返工三轮。最终 `bridge_mark_completed` 只记录完成事实，不自动合并 `main`。

## 5. 重启与部分文件

Bridge 在每个 Driver 事件后将脱敏恢复 checkpoint 写入 Artifact，并在 AgentRun 中保存 Artifact ID 与哈希。重启时只有以下条件全部满足才恢复同一非终态 Run：

- TaskVersion、唯一 ACTIVE Session、Driver ID 与 resume 能力一致；
- checkpoint 存在且哈希正确；
- 原 worktree、分支和 base commit 一致；
- SQLite 租约可由同一 Run 续接；
- worktree diff 未越过角色和 Task scope。

任一条件失败时，旧 Run、Session 和 Task 会被记录为失败或中断，错误分类和原因保存在持久化对象中。原 worktree 与已经修改的文件默认保留，不自动删除、不盲目重放外部副作用。后续应创建新的 TaskVersion/Run；经人工核对后接管保留 worktree，或把明确的 patch/Artifact 迁入干净 worktree。

## 6. 无 UI/IDE 观察

所有权威对象与事件保存在 `runtime_root/agent-bridge.sqlite`，恢复 checkpoint 和验证报告保存在 `runtime_root/artifacts`。重新连接 MCP 后可用 `bridge_get_task`、`bridge_list_tasks`、`bridge_get_events`、`bridge_get_result` 和审批查询恢复观察。事件使用持久游标；Outbox 在启动时重放未发布项，并以租约、严格顺序和退避避免并发重复发布。

不要直接编辑 SQLite 或 Artifact manifest。数据库和 Artifact 共同构成恢复证据，手工修改会使哈希或修订校验失败。

## 7. 错误与重试

MCP 错误返回稳定 `code`，并附 `category` 与 `retryable`。类别包括 `INPUT`、`NOT_FOUND`、`CONFLICT`、`POLICY`、`RECOVERY`、`TRANSIENT` 和 `INTERNAL`。只有明确的瞬态错误会标记 `retryable: true`；冲突、策略拒绝和恢复安全门失败不能靠无条件重试解决。

## 8. 脱敏与资源清理

凭据字段、完整 transcript、内部推理字段和常见 Token 形态在进入领域事件、错误详情与恢复 Artifact 前会被移除或遮蔽。验证日志也执行相同类型的 Token 脱敏。

失败、取消或最终完成后，Bridge 关闭 Driver 进程并释放租约，同时写入资源清理审计。为了支持核查和安全移交，worktree 与隔离目录默认保留；当前不会自动删除 Artifact，只提供临时文件清理和孤儿预览。需要释放磁盘时，应先核对持久化引用和保留策略，再执行显式清理。
