# Phase 4.2 本地管理页 Contract 测试矩阵

- 状态：已确认，实施门禁
- 日期：2026-08-11
- 适用范围：PRD OQ-006 技术与安全合同
- 技术来源：[ADR-0003](../adr/0003-local-dashboard-technical-and-security-contract.md)
- 接口来源：[HTTP/JSON + SSE v1](../contracts/phase-4-2-management-http-sse-v1.md)

## 1. 状态说明

- **已确认**：产品行为来自 PRD v1.7 与 v2 原型。
- **已决策**：既有 Bridge Core、Driver Protocol、Repository/Outbox、审计和公开状态语义。
- **已接受技术决定**：本文的测试分层、用例编号、文件落点和门禁已经用户确认；进入实现仍需单独授权。
- **开放问题**：当前没有阻塞 OQ-006 的测试问题。

本文是实现前合同矩阵，不代表测试已经存在或通过。所有测试必须使用 Fake Driver、临时 runtime_root、假浏览器 opener 和本地 loopback；禁止读取真实 Agent 配置/凭据、调用真实 Provider 或产生费用。

## 2. 分层与建议落点

| 层级 | 目的 | 建议落点 |
| --- | --- | --- |
| Unit | 安全投影、Schema、游标、ETag、幂等和脱敏的纯逻辑 | apps/bridge-mcp/tests/unit/management/ |
| Contract | HTTP/JSON、SSE、静态资源和稳定错误合同 | apps/bridge-mcp/tests/contract/management/ |
| Security | localhost、同源、CSRF、秘密、路径和输出泄漏 | tests/security/management-dashboard.test.ts |
| Integration | MCP、HTTP、应用服务、Repository/Outbox 与运行时一致性 | tests/integration/management-dashboard.test.ts |
| Startup | 单实例、恢复、监听、opener 和关闭顺序 | apps/bridge-mcp/tests/integration/dashboard-startup.test.ts |
| E2E | v2 产品行为的浏览器级无 Provider 验收 | tests/e2e/management-dashboard.test.ts |

建议复用仓库现有 Vitest、Fake Driver、临时目录与编译测试方式，不引入新运行时或测试依赖。浏览器交互若现有依赖不能安全覆盖，首轮以 HTTP/DOM contract harness 完成；任何新增浏览器自动化依赖需另行确认。

## 3. 核心矩阵

### 3.1 架构与应用边界

| ID | 层级 | 场景 | 预期 |
| --- | --- | --- | --- |
| ARCH-001 | Integration | HTTP 读取任务详情 | 只经 Management Projection/应用服务，不直接访问 SQLite 或 Artifact 实现 |
| ARCH-002 | Integration | HTTP 审批，随后 MCP 读取 | MCP 立即观察到同一权威状态、事件与审计 |
| ARCH-003 | Integration | MCP 改变任务，页面已连接 SSE | 页面收到安全 invalidate，重新 GET 后与 MCP 一致 |
| ARCH-004 | Unit | display_stage 生成 | 仅由 Task/Run/Approval 权威事实确定性派生，不产生新领域状态 |
| ARCH-005 | Integration | Repository 写入和 Outbox 发布发生故障 | 维持既有原子性，不出现 HTTP 成功但事件缺失 |
| ARCH-006 | Integration | 活动 Run 所有权无法安全恢复 | 服务保持只读并返回 RECOVERY_IN_PROGRESS，不旁路 ActiveRunRegistry |
| ARCH-007 | Contract | HTTP DTO 取样 | 不包含 Repository 原始对象、Driver payload 或 Worker 私有字段 |
| ARCH-008 | Unit | 新增管理命令 | 权限、状态机和审计由共享应用层执行，不在路由中复制 |

### 3.2 会话、localhost 与 CSRF

| ID | 层级 | 场景 | 预期 |
| --- | --- | --- | --- |
| SEC-001 | Startup | 默认启动 | 只监听 127.0.0.1 随机端口，不绑定 0.0.0.0、主机名或双栈 |
| SEC-002 | Security | Host 与实际地址不一致 | 返回 HOST_REJECTED，且请求不触达业务服务 |
| SEC-003 | Security | 写操作、会话交换或 SSE 的 Origin 缺失、伪造或跨源 | 返回 ORIGIN_REJECTED，不返回 CORS 允许头 |
| SEC-004 | Security | 首次 fragment 启动 | HTTP 访问日志和 Referer 中没有 launch_secret |
| SEC-005 | Contract | 正确启动秘密首次交换 | 设置实例随机名称、host-only、HttpOnly、SameSite=Strict、Path=/internal/v1 Cookie，返回内存 CSRF |
| SEC-006 | Security | 启动秘密重复交换、超时或连续失败 | fail closed；秘密被撤销，响应不回显秘密 |
| SEC-007 | Security | 写请求缺 Cookie、CSRF 或精确 Origin；读请求缺同源标记 | 分别稳定拒绝，业务状态不变化 |
| SEC-008 | Security | 页面存储扫描 | localStorage、sessionStorage、IndexedDB 不含秘密、会话或 DTO |
| SEC-009 | Integration | 服务重启后复用旧会话 | 返回 SESSION_EXPIRED，旧 CSRF/stream/确认 Token 全部失效 |
| SEC-010 | Contract | DELETE session 重放 | 相同幂等请求返回相同安全结果，当前 stream 被撤销 |
| SEC-011 | Security | 常见 localhost DNS rebinding 请求 | Host/Origin 双检查拒绝 |
| SEC-012 | Security | OPTIONS 预检和跨源 fetch | 不开放 CORS，不执行写操作 |
| SEC-013 | Integration | 两个不同 runtime_root 管理页同时运行 | 随机 Cookie 名不同，会话不会互相覆盖或被错误实例接受 |

### 3.3 JSON、读模型与时间口径

| ID | 层级 | 场景 | 预期 |
| --- | --- | --- | --- |
| READ-001 | Contract | GET dashboard 不传 range | 使用 today，响应返回服务器时区与明确 from/to |
| READ-002 | Unit | session 范围 | 从 server_started_at 计算，不从浏览器 tab 或 Agent Session 计算 |
| READ-003 | Unit | today 跨夏令时/自然日边界 | 由服务端时区日历计算，不固定减 24 小时 |
| READ-004 | Unit | 7d 范围 | 包含今天的七个自然日，边界稳定 |
| READ-005 | Contract | usage 全部缺失 | reported 为 0、unreported 正确，数值字段为 null/未上报而非 0 |
| READ-006 | Unit | usage 部分上报 | 只汇总已上报项；total_units 为输入、输出、缓存读和缓存写四个互斥分量之和 |
| READ-007 | Unit | AgentResult.usage 持久化 | 使用 unit/input_units/output_units 等安全字段，不被凭据脱敏器误删 |
| READ-008 | Contract | 任务列表分页 | limit 默认 50、最大 200，page cursor 与 event cursor 不混用 |
| READ-009 | Contract | 非法 range、status、limit、未知字段 | 返回 VALIDATION_ERROR，不容错猜测 |
| READ-010 | Contract | JSON 超过 16 KiB | 解析前返回 REQUEST_BODY_TOO_LARGE |
| READ-011 | Unit | 快照期间事件头变化 | 有界重试，不返回混合时点数据 |
| READ-012 | Contract | 快照持续繁忙 | 返回 SNAPSHOT_BUSY 和当前安全游标 |
| READ-013 | Unit | 多个异步 GET 乱序完成 | 客户端归约器拒绝旧 server_instance_id 或 revision 倒退结果 |
| READ-014 | Contract | 详情与列表同一 Task | authoritative_status、revision、etag 一致 |
| READ-015 | Contract | Token 未上报的详情 | 明确 status=unreported，所有计数字段为 null |
| READ-016 | Contract | 标题、事件摘要和验证摘要含敏感模式 | 返回脱敏白名单文本或 fail closed |

### 3.4 SSE 游标、恢复与写保护

| ID | 层级 | 场景 | 预期 |
| --- | --- | --- | --- |
| SSE-001 | Contract | 用有效 after 建立连接 | 首条为 bridge.ready，含当前 instance、stream_id 和 head_cursor |
| SSE-002 | Contract | Last-Event-ID 恢复 | 从下一持久事件继续，ID 沿用 event-cursor:<sequence> |
| SSE-003 | Contract | after 与 Last-Event-ID 不一致 | 返回 CURSOR_CONFLICT，不猜测哪个更可信 |
| SSE-004 | Contract | 游标过旧或不可用 | 发送 bridge.reset 后关闭，客户端进入只读并全量刷新 |
| SSE-005 | Contract | 重复事件 | at-least-once 允许重复；客户端按 event ID 去重 |
| SSE-006 | Contract | 原始领域事件含敏感 payload | SSE 只发 resources 失效集合，不泄漏 payload |
| SSE-007 | Integration | 单个持久事件影响多个投影 | invalidate 合并资源但 head_cursor 不倒退 |
| SSE-008 | Contract | 15 秒无业务事件 | 服务端发送 comment heartbeat，不制造领域事件 |
| SSE-009 | Integration | 慢消费者超过安全队列 | 关闭连接并撤销 stream_id，不无限积压内存 |
| SSE-010 | Contract | 同一会话建立第 3 条连接 | 返回 SSE_CONNECTION_LIMIT |
| SSE-011 | E2E | 网络断开进入 reconnecting | 所有写按钮立即禁用 |
| SSE-012 | Security | 断线后手工构造写请求 | 服务端返回 STREAM_NOT_CURRENT，状态不变化 |
| SSE-013 | E2E | 重连后尚未追平 head | 保持只读；ready + 刷新追平后才恢复 |
| SSE-014 | Integration | server_instance_id 改变 | 丢弃旧投影和写令牌，重新交换会话 |
| SSE-015 | Contract | SSE 响应头 | text/event-stream、no-store、禁缓冲，不允许跨源 |
| SSE-016 | Unit | 事件修订乱序或重复 | 聚合 revision 不回退，最终投影一致 |

### 3.5 写入幂等、并发与确认

| ID | 层级 | 场景 | 预期 |
| --- | --- | --- | --- |
| WRITE-001 | Contract | 写请求缺 Idempotency-Key | 拒绝且不进入应用服务 |
| WRITE-002 | Contract | 同 key、同目标、同规范请求重放 | 返回首次结果，不重复领域副作用或审计 |
| WRITE-003 | Contract | 同 key 但请求体不同 | 返回 IDEMPOTENCY_KEY_REUSED |
| WRITE-004 | Contract | X-Agent-Bridge-Event-Cursor 落后 | 返回 STALE_EVENT_CURSOR，不写入 |
| WRITE-005 | Contract | If-Match 落后 | 返回 ETAG_MISMATCH，不写入 |
| WRITE-006 | Integration | 游标检查后目标并发变化 | 应用 transaction 再验证修订，只有一个命令成功 |
| WRITE-007 | Contract | preview Token 缺失、伪造、过期或已使用 | 返回 CONFIRMATION_EXPIRED，不执行操作 |
| WRITE-008 | Contract | preview 后目标 revision 变化 | 旧 Token 失效，要求重新预览 |
| WRITE-009 | Security | Token 用于不同 action/run/session/instance | fail closed |
| WRITE-010 | Contract | preview 本身 | 只读、不改 revision，返回完整 effects/warnings/expiry |
| WRITE-011 | Integration | 成功写入响应丢失后重试 | 幂等重放返回同一领域结果 |
| WRITE-012 | Unit | 稳定错误映射 | 内部异常不泄漏，公开 code/category/retryable 保持合同 |

### 3.6 审批、重试、取消与清理语义

| ID | 层级 | 场景 | 预期 |
| --- | --- | --- | --- |
| ACT-001 | Contract | approve pending approval | 通过共享应用服务恢复既有权限路径并记录审计 |
| ACT-002 | Contract | reject 缺失或空 feedback | VALIDATION_ERROR，不改变审批 |
| ACT-003 | Contract | reject feedback 超过 2000 code point | VALIDATION_ERROR |
| ACT-004 | Integration | reject 有效 feedback | 持久化拒绝与反馈、deny 当前动作，并以既有 interrupted/INTERRUPTED 语义安全收口 |
| ACT-005 | Integration | reject 后 Worker 尝试实质等价动作 | 当前方案不可继续，投影显示等待 Codex 重新规划 |
| ACT-006 | Unit | 等待重新规划投影 | 使用既有事实派生，不添加公开 Task/Run 状态 |
| ACT-007 | Integration | retry 合法终态 Run | 保留旧 Run，同一 TaskVersion 创建新 run_id 与新 Session |
| ACT-008 | Contract | retry 需要改变目标/范围/规则/权限 | 返回 TASK_VERSION_REQUIRED，不修改冻结版本 |
| ACT-009 | Contract | retry 非最新或不可重跑 Run | ACTION_NOT_ALLOWED |
| ACT-010 | Integration | cancel 活动 Run | 确定取消落盘；保留 worktree、事件、审计和 Artifact 引用 |
| ACT-011 | Contract | cancel 已终态 Run | ACTION_NOT_ALLOWED 或已定义幂等 no-op，不产生第二终态 |
| ACT-012 | Security | cleanup 包含无所有权进程/目录 | 预览标记并拒绝清理该对象 |
| ACT-013 | Integration | cleanup 有已验证残留 | 只移除目标 Run 的进程、租约、runtime 临时目录 |
| ACT-014 | Integration | cleanup 无残留 | 成功 no-op，审计可证明未删除业务数据 |
| ACT-015 | Security | cleanup 后持久数据核对 | Task、TaskVersion、Run、事件、审计、Artifact、保留 worktree 均存在 |
| ACT-016 | Integration | approve/reject/cancel 与 MCP 同时发生 | 状态机与 ETag 保证唯一有效决定，其余稳定冲突 |

### 3.7 静态资源、启动与脱敏

| ID | 层级 | 场景 | 预期 |
| --- | --- | --- | --- |
| OPS-001 | Startup | preflight、锁或恢复失败 | 不监听、不打开浏览器、不生成可用会话 |
| OPS-002 | Startup | 恢复与监听成功 | 仅此时生成秘密并调用一次假 opener |
| OPS-003 | Startup | opener 失败 | 撤销秘密并停止 HTTP，输出不含秘密 URL |
| OPS-004 | Startup | 同 runtime_root 启动第二实例 | 返回 BRIDGE_INSTANCE_CONFLICT，不接管或终止第一实例 |
| OPS-005 | Contract | 固定 manifest 中资源 | 正确 MIME、nosniff；HTML no-store，哈希资产 immutable |
| OPS-006 | Security | ../、编码穿越、dotfile、source map、symlink、NUL | 全部拒绝，不能读取 manifest 外文件 |
| OPS-007 | Contract | /internal 未知路由 | JSON 404，不回退 index.html |
| OPS-008 | Security | 响应头扫描 | CSP 无 inline/eval/remote，禁止 frame、referrer 和嗅探 |
| OPS-009 | Security | JSON/SSE/日志全量秘密扫描 | 不含凭据、Cookie、CSRF、stream、确认 Token、绝对路径或原始 payload |
| OPS-010 | Security | feedback、错误和标题含控制字符/HTML | 安全编码；前端只用文本节点，不形成脚本或标记注入 |
| OPS-011 | Integration | 正常关闭 | 先停接收写入，再关 SSE/HTTP，最后释放实例锁和运行资源 |
| OPS-012 | Contract | HTTP 方法不在允许集合 | 返回稳定 METHOD_NOT_ALLOWED/404，不执行隐式路由 |

## 4. 产品验收路径

以下浏览器级路径直接覆盖已确认的 v2 行为，不扩大产品范围：

| ID | 场景 | 验收结果 |
| --- | --- | --- |
| UX-001 | 首次打开 | 第一屏先显示本次会话/今日/最近 7 天，默认今日 |
| UX-002 | 摘要下方 | 按运行中、待审批、异常三类展示，不出现创建任务入口 |
| UX-003 | 打开右侧详情 | 状态、阶段、当前步骤、等待原因、最近事件、耗时与 Token 口径一致 |
| UX-004 | 任务运行 | 阶段式进度，无百分比或虚假精确度 |
| UX-005 | Token 缺失 | 显示“— / 未上报”，不显示 0 |
| UX-006 | 拒绝审批 | feedback 必填；成功后当前方案被阻止并等待 Codex 重新规划 |
| UX-007 | 重试/取消/清理 | 先看到作用范围和影响，明确二次确认后才发送命令 |
| UX-008 | SSE 重连 | 页面保留只读信息，但所有写动作禁止；追平后恢复 |
| UX-009 | 并发变化 | 操作返回冲突，页面刷新权威事实，不乐观覆盖 |
| UX-010 | 刷新或服务重启 | 不从浏览器持久化恢复秘密或陈旧可写状态 |
| UX-011 | 页面源码/网络检查 | 无 Provider 凭据、内部推理、原始事件、绝对路径或 Artifact 内容 |
| UX-012 | 页面操作全集 | 不创建 Task、不编辑合同、不旁路 Codex/MCP |

## 5. 实施切片与退出条件

### Slice A：管理读模型与 usage 事实

范围：

- 安全白名单 DTO 和 display_stage 派生。
- usage 持久事实与未上报口径。
- dashboard 时间范围和一致快照。

退出条件：

- ARCH-001、ARCH-004、ARCH-007、READ-001 至 READ-016 通过。
- 不存在 HTTP 服务和正式页面。
- 现有公开状态及 Repository/Outbox 测试无回归。

### Slice B：共享管理命令

范围：

- reject/replan 行为修正。
- retry 新 Run/新 Session。
- cancel 与 cleanup preview/confirm。
- 统一 ETag、幂等和审计边界。

退出条件：

- WRITE-001 至 WRITE-012、ACT-001 至 ACT-016 通过。
- MCP 与未来 HTTP 均调用同一应用服务。
- 不开发页面。

### Slice C：本地 HTTP 安全层与静态交付

范围：

- 单实例、127.0.0.1、会话交换、Host/Origin/CSRF。
- JSON Schema、错误映射、安全头、manifest 静态资源。
- 注入式 browser opener。

退出条件：

- SEC-001 至 SEC-013、OPS-001 至 OPS-010、OPS-012 通过。
- pnpm-lock.yaml 未变化。
- 不启动真实浏览器做自动化测试，不安装依赖。

### Slice D：SSE 与一致性

范围：

- PersistentEventFanout 到安全 invalidate 的适配。
- Last-Event-ID、reset、heartbeat、慢消费者和 stream 写门禁。
- MCP/HTTP 双向可见性。

退出条件：

- ARCH-002、ARCH-003、ARCH-005、ARCH-006、SSE-001 至 SSE-016 通过。
- 原始事件 payload 不进入浏览器。
- 断线期间服务端与客户端均禁止写操作。

### Slice E：正式页面与最终验收

范围：

- 按 v2 原型实现原生 TypeScript 页面。
- 摘要、泳道、详情、审批、二次确认和重连状态。
- 无 Provider E2E 与关闭审计。

退出条件：

- UX-001 至 UX-012、OPS-011 通过。
- 全部测试使用 Fake Driver/临时数据。
- 依赖、凭据、费用和 Git 发布门禁继续满足。

每个 Slice 都需要单独实施授权；本文确认只关闭技术合同，不自动授权 Slice A 或后续工作。

## 6. 验收门禁

OQ-006 技术合同已满足并关闭的文档门禁：

- ADR、HTTP/JSON + SSE 合同和本矩阵互相引用且无冲突。
- React + Vite、Hono、SSE 的取舍和依赖边界已明确。
- localhost、会话、CSRF、游标恢复、幂等、并发、错误、脱敏、静态资源和 opener 合同已冻结。
- 页面/MCP 共享应用服务，不改变 Bridge Core、Driver Protocol、Repository/Outbox、审计和公开状态。
- 当前实现前置缺口已列明，不由 UI 临时补偿。
- 用户已于 2026-08-11 明确确认技术决定。

未来实现的合并门禁：

- 上表适用用例全部通过，现有测试无回归。
- git diff --check 和仓库既有 format/typecheck/test 门禁通过。
- pnpm-lock.yaml 不变化；若变化必须有单独批准。
- 无真实 Agent 配置/凭据读取，无真实 Provider 调用，无费用。
- 构建产物不含 source map、远程依赖或敏感内容。
- 变更仅包含已确认 Slice 的代码、测试和必要文档。

## 7. 风险与覆盖关系

| 风险 | 主要测试 |
| --- | --- |
| 两个进程争夺活动 Run 所有权 | ARCH-006、OPS-004 |
| localhost 被跨源网页调用 | SEC-002、SEC-003、SEC-007、SEC-011、SEC-012 |
| 不同本地实例的 Cookie 冲突 | SEC-005、SEC-009、SEC-013 |
| 断线页面执行陈旧写入 | SSE-011 至 SSE-014、WRITE-004 至 WRITE-008 |
| 原始事件或错误泄露敏感信息 | ARCH-007、SSE-006、OPS-009、OPS-010 |
| reject 实际继续当前方案 | ACT-004 至 ACT-006 |
| retry 修改冻结 TaskContract | ACT-007 至 ACT-009 |
| cleanup 误删业务数据 | ACT-012 至 ACT-015 |
| Token 缺失被统计为零 | READ-005 至 READ-007、READ-015 |
| 多次点击产生重复副作用 | WRITE-001 至 WRITE-003、WRITE-011 |
| 静态服务器读取仓库任意文件 | OPS-005 至 OPS-007 |
| 自动 opener 泄露启动秘密 | SEC-004、SEC-006、OPS-001 至 OPS-003 |
