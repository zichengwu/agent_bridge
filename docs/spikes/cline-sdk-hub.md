# Cline SDK / Hub 技术 Spike 报告

## 1. 文档状态

- 日期：2026-07-19
- SDK：`@cline/sdk@0.0.65`
- Core：`@cline/core@0.0.65`
- Node.js：`v24.14.0`（项目最低要求为 Node.js 22）
- pnpm：`11.9.0`
- 测试类型：无真实 Provider、无模型调用、无费用
- 结论：**Local 模式通过；Hub 主路径被上游发布包缺陷阻塞；真实 Session 能力待授权验证。**

## 2. 验证目标

本 Spike 验证 PRD 中 Cline Driver 主路径所依赖的以下能力：

1. SDK 能否在 Node.js 22+ 工程中安装和加载。
2. `ClineCore` 是否暴露 Session、事件、用量、取消、恢复和检查点相关接口。
3. `backendMode: local` 是否能在隔离目录初始化并查询空 Session 历史。
4. `backendMode: hub` 是否能自动启动或连接 Hub。
5. 两个 SDK 客户端是否能连接同一个 Hub runtime。
6. 无凭据场景是否会污染用户目录或泄漏敏感信息。

真实模型调用、有效 Session 创建、事件内容、取消、真实用量和恢复需要 Provider 凭据，不属于本轮授权范围。

## 3. 可复现命令

```bash
pnpm spike:cline:check
pnpm spike:cline:local
pnpm spike:cline:hub
```

`local` 和 `hub` Spike 都将 `HOME`、`CLINE_DATA_DIR` 指向独立临时目录，退出后清理。默认命令不读取用户的 `~/.cline`，也不发起模型请求。

## 4. 能力矩阵

| 能力                       | 结果            | 证据或说明                                                                                                                                                           |
| -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK 安装与运行时加载       | 通过            | `@cline/sdk@0.0.65` 可导入，`CORE_BUILD_VERSION=0.0.65`                                                                                                              |
| `ClineCore.create`         | 通过            | 运行时导出存在                                                                                                                                                       |
| Driver 生命周期 API 面     | 通过            | 实例具有 `start`、`send`、`subscribe`、`get`、`list`、`readMessages`、`getAccumulatedUsage`、`abort`、`stop`、`dispose`、`restore`、`compareCheckpoint` 等 15 个方法 |
| Local runtime 初始化       | 通过            | 无 Provider 时可创建 Local runtime 并查询空历史                                                                                                                      |
| Local 数据隔离             | 通过            | 只在临时 `CLINE_DATA_DIR` 创建 `db/sessions.db` 及 WAL 文件                                                                                                          |
| 不存在 Session 的用量查询  | 通过            | `getAccumulatedUsage` 返回 `undefined`                                                                                                                               |
| SDK detached Hub 自动启动  | 阻塞            | 自动启动尝试执行不存在的 `@cline/core/dist/entry.js`                                                                                                                 |
| `@cline/core/hub` 聚合入口 | 阻塞            | 模块加载时报 `ReferenceError: h00 is not defined`                                                                                                                    |
| 官方 Hub daemon entry      | 阻塞            | 沙箱外运行仍报 `ReferenceError: A20 is not defined`                                                                                                                  |
| Hub 多客户端               | 未验证          | Hub 无法启动，因此不能建立两个客户端连接                                                                                                                             |
| 稳定 Session ID            | 待真实 Provider | 必须创建真实 Session                                                                                                                                                 |
| 事件完整性                 | 待真实 Provider | 必须执行真实或可注入 Fake Provider 的 Session                                                                                                                        |
| 真实用量精度               | 待真实 Provider | 当前仅确认 API 和空值行为                                                                                                                                            |
| 取消、停止和恢复           | 待真实 Provider | 需要运行中的 Session                                                                                                                                                 |
| VS Code Cline 附着         | 待 Hub 修复     | 本机当前也未安装 Cline 扩展                                                                                                                                          |

## 5. 已确认的上游发布问题

### 5.1 Detached Hub 入口路径错误

`ClineCore.create({ backendMode: "hub" })` 会尝试启动：

```text
@cline/core/dist/entry.js
```

但 `@cline/core@0.0.65` 发布包中实际存在的是：

```text
@cline/core/dist/hub/daemon/entry.js
```

最终错误：

```text
Error: Cannot find module '@cline/core/dist/entry.js'
Error: No compatible hub runtime is available.
```

### 5.2 Hub 聚合 Bundle 变量缺失

直接加载官方 `@cline/core/hub` 导出时，在模块初始化阶段失败：

```text
ReferenceError: h00 is not defined
```

因此不能通过 `ensureHubServer` 在进程内启动 Hub。

### 5.3 Daemon Entry Bundle 变量缺失

通过 package exports 解析并运行 `@cline/core/hub/daemon-entry`，在沙箱外仍然失败：

```text
ReferenceError: A20 is not defined
```

沙箱内曾额外出现第三方异常处理器调用 `uv_uptime` 被拒绝，但沙箱外复测仍稳定出现 `A20`，因此系统权限不是主因。

### 5.4 SDK 聚合声明差异

`@cline/sdk` 的运行时确实重导出了 `ClineCore`，但其聚合声明在 typed ESLint 中退化为 error type。Spike 通过一个窄适配边界完成运行时导出校验，并让其余代码依赖本地明确接口；没有全局关闭类型检查。

## 6. 阶段门禁判断

本 Spike 当前不能标记为“通过”或“带降级通过”，原因是 PRD 明确规定正常运行必须使用 Hub，而当前稳定发布包无法启动 Hub。Local 模式仅可用于测试，不能替代 MVP 主运行模式。

以下工作不依赖 Hub，可以在明确接受并行推进后继续：

- JSON Schema 和 Driver Protocol。
- Task、TaskVersion、状态机和 Session Binding 领域规则。
- Repository 接口、Fake Driver 和内存测试替身。
- Context Package、Handoff 和 Continuation Snapshot 数据契约。
- 路径、命令和 Git 隔离策略测试。

以下工作应在 Hub 解除阻塞前保持未完成：

- Cline SDK Driver 的 Hub 主路径验收。
- Hub Session 恢复、多客户端和 VS Code 附着。
- 真实上下文用量和 Session 滚动验证。
- MVP 全链路完成判定。

## 7. 建议处理路径

优先级从高到低：

1. 等待或升级到修复 Hub 发布问题的 `@cline/sdk` / `@cline/core` 版本，然后重跑本 Spike。
2. 若必须立即推进，单独评审“固定 Cline 官方源码 commit 并自行构建 package”的方案；该方案会改变依赖供应链和维护责任，不能由研发自行决定。
3. 在 Hub 修复前仅并行开发与 Hub 无关的 Phase 1 领域内核；不得把 Local runtime 宣称为生产主路径。
4. Generic CLI Driver 继续保留为诊断和降级路径，但不能在未经决策的情况下替代 PRD 已确认的 SDK/Hub 主路径。

## 8. 后续重跑通过标准

Hub 修复后至少需要满足：

- `backendMode: hub` 能在干净环境启动或连接兼容 Hub。
- 两个客户端连接同一 runtime，并获得一致 Session 历史。
- 创建客户端退出后，Hub/Spoke 中运行不被中止。
- Hub 重启后可读取既有 Session。
- 真实 Session 的事件、用量、取消、结果和恢复行为可映射到 Driver Protocol。
- 无凭据、异常和日志路径均保持脱敏。
