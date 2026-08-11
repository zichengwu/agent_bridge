# Phase 4.2 本地管理页 HTTP/JSON + SSE v1 合同

- 状态：已确认，v1 冻结
- 日期：2026-08-11
- 适用范围：PRD OQ-006
- 技术来源：[ADR-0003](../adr/0003-local-dashboard-technical-and-security-contract.md)
- 测试来源：[Contract 测试矩阵](../testing/phase-4-2-management-contract-test-matrix.md)

## 1. 合同状态与原则

本文严格使用四种标记：

- **已确认**：PRD v1.7 和 v2 原型已经确认的产品行为。
- **已决策**：Bridge Core、Driver Protocol、Worker Runtime、Repository/Outbox、审计和公开状态已经确定的语义。
- **已接受技术决定**：用户已经确认、用于约束内部 HTTP/JSON、SSE 和安全实现的合同；它不改写产品事实。
- **开放问题**：需要用户或后续 ADR 决定的内容。

用户已于 2026-08-11 确认本文；版本、字段和错误码按 v1 冻结，OQ-006 已关闭。

服务前缀为 /internal/v1。该接口只服务同一 Bridge 应用实例自动打开的本地页面，不是公开 API，不承诺跨版本客户端兼容。页面、MCP 和内部接口必须调用相同应用服务；不得直读写 SQLite、Artifact、Driver 或 Worker 私有状态。

## 2. 进程、监听与传输

### 2.1 单实例

同一 runtime_root 同时只有一个 Bridge 应用实例。server_instance_id 在进程启动时生成，重启即变化。第二实例必须在启动 HTTP 前失败：

    {
      "code": "BRIDGE_INSTANCE_CONFLICT"
    }

dashboard-only 与 MCP + dashboard 是同一组合根的两种互斥启动模式，不允许两个进程共享 Repository 后分别管理活动 Run。

### 2.2 监听

- 仅绑定 127.0.0.1，端口默认由操作系统分配。
- advertised_origin 必须是 http://127.0.0.1:<port>。
- 请求 Host 必须精确等于 127.0.0.1:<port>。
- 会改变状态的请求、会话交换和 SSE 必须具有精确 Origin。
- JSON 读取请求必须携带同源页面才能设置的 X-Agent-Bridge-Client: dashboard；Host、会话和 Fetch Metadata 同时校验。缺失或跨站的 Sec-Fetch-Site 取值 fail closed。
- 不返回 Access-Control-Allow-Origin、Access-Control-Allow-Credentials 或其他 CORS 允许头。
- 不接受 HTTP Upgrade、代理转发身份头或外部 base URL 覆盖。

### 2.3 通用安全响应头

所有响应至少包含以下安全头：

    Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer
    Cross-Origin-Opener-Policy: same-origin

HTML、JSON、SSE、会话和错误响应使用 Cache-Control: no-store。静态内容哈希 JS/CSS 使用 Cache-Control: public, max-age=31536000, immutable。

## 3. 本地会话与 CSRF

### 3.1 启动秘密交换

启动器生成至少 256-bit 随机秘密，在以下 URL 的 fragment 中传给浏览器：

    http://127.0.0.1:<port>/#launch_secret=<base64url>

fragment 不会出现在 HTTP 请求中。页面启动脚本读取后立即使用 history.replaceState 移除，再调用：

    POST /internal/v1/session/exchange
    Content-Type: application/json
    Origin: <advertised_origin>

    {
      "schema_version": 1,
      "launch_secret": "<secret>"
    }

启动秘密：

- 单次使用，生成后 60 秒失效。
- 只保存在服务端内存和浏览器启动内存。
- 不进入日志、错误详情、URL query、localStorage、sessionStorage 或 IndexedDB。
- 交换成功、超时、失败次数达到 3 次或服务停止时立即撤销。

成功响应设置 host-only Cookie：

    Set-Cookie: agent_bridge_session_<instance_tag>=<opaque>; HttpOnly; SameSite=Strict; Path=/internal/v1

该 Cookie 不设置 Domain，因此是 host-only。Cookie 不按端口隔离，instance_tag 必须由每个服务实例随机生成，使不同 runtime_root 的管理页不会覆盖同名 Cookie；服务只读取自己的精确 Cookie 名。由于本期使用 HTTP loopback，实现不得错误使用要求 Secure 的 __Host- 前缀，也不得设置 Secure 后导致 Cookie 无法送达。若未来改为 HTTPS，再单独评估 __Host- 前缀、Path=/ 与路由边界。

响应体：

    {
      "schema_version": 1,
      "server_instance_id": "<uuid>",
      "event_cursor": "event-cursor:42",
      "data": {
        "csrf_token": "<opaque>",
        "server_started_at": "2026-08-11T10:00:00.000Z",
        "timezone": "Asia/Shanghai"
      }
    }

CSRF Token 只保存在页面运行内存，不得落入浏览器持久化存储。页面重载后若 host-only Cookie 仍有效，启动脚本通过 GET /session 重新领取当前会话的 CSRF；不存在有效 Cookie 时必须使用新的启动秘密建立会话。服务端主动轮换时必须原子失效旧 Token。

### 3.2 会话端点

- GET /internal/v1/session：验证 Cookie 与同源读取标记，返回当前会话的内存 CSRF、服务实例、时区和当前游标。
- DELETE /internal/v1/session：撤销当前会话、CSRF、确认 Token 和 SSE stream；需要 Origin、CSRF 和 Idempotency-Key。
- 服务重启后旧 Cookie 一律返回 SESSION_EXPIRED。

## 4. JSON 通用规则

### 4.1 媒体类型与限制

- 请求和响应使用 application/json; charset=utf-8。
- 除 SSE 外不接受其他媒体类型。
- JSON 请求体上限 16 KiB；超限在解析前返回 REQUEST_BODY_TOO_LARGE。
- 严格 Schema：未知字段、重复语义字段、错误类型、非有限数字和非法枚举均返回 VALIDATION_ERROR。
- ID、时间、游标和 ETag 均是不透明字符串，客户端不得解析或构造。
- 列表 limit 默认 50，最大 200；分页 cursor 与事件 event_cursor 不是同一种游标。

### 4.2 成功信封

    {
      "schema_version": 1,
      "server_instance_id": "<uuid>",
      "event_cursor": "event-cursor:42",
      "data": {}
    }

每个读响应都携带生成该投影时的事件头。客户端只接受同一 server_instance_id 且 revision 不倒退的结果。

### 4.3 错误信封

    {
      "schema_version": 1,
      "server_instance_id": "<uuid-or-null>",
      "event_cursor": "event-cursor:42",
      "error": {
        "code": "STALE_EVENT_CURSOR",
        "category": "conflict",
        "message": "页面状态已变化，请刷新后重试。",
        "retryable": true,
        "request_id": "<opaque>"
      }
    }

错误响应不得包含 stack、SQL、绝对路径、Driver/Provider payload、秘密、原始工具参数或未脱敏异常。message 是安全、稳定的用户提示；客户端逻辑只依赖 code。

## 5. 读模型

### 5.1 摘要

    GET /internal/v1/dashboard?range=session|today|7d

默认 range=today。

    {
      "schema_version": 1,
      "server_instance_id": "<uuid>",
      "event_cursor": "event-cursor:42",
      "data": {
        "range": {
          "kind": "today",
          "from": "2026-08-11T00:00:00.000+08:00",
          "to": "2026-08-11T18:00:00.000+08:00",
          "timezone": "Asia/Shanghai"
        },
        "counts": {
          "total": 12,
          "running": 2,
          "needs_attention": 2,
          "waiting_approval": 1,
          "abnormal": 1,
          "completed": 8
        },
        "duration": {
          "reported_task_count": 12,
          "unreported_task_count": 0,
          "buckets": [
            { "key": "lt_5m", "task_count": 4, "share_basis_points": 3333 },
            { "key": "5m_to_lt_15m", "task_count": 5, "share_basis_points": 4167 },
            { "key": "15m_to_lt_30m", "task_count": 2, "share_basis_points": 1667 },
            { "key": "gte_30m", "task_count": 1, "share_basis_points": 833 }
          ]
        },
        "usage": {
          "reported_task_count": 6,
          "unreported_task_count": 2,
          "input_units": 1200,
          "output_units": 300,
          "cache_read_units": 100,
          "cache_write_units": 20,
          "total_units": 1620
        },
        "lanes": {
          "running_task_ids": ["task_1"],
          "approval_task_ids": ["task_2"],
          "abnormal_task_ids": ["task_3"]
        }
      }
    }

时间口径：

- session：server_started_at 至当前时间。
- today：服务端时区当日 00:00 至当前时间。
- 7d：服务端时区中包含今天的七个自然日。

范围成员是满足以下任一条件的去重 Task：在 [from, to] 内产生持久领域事件，或在 to 时仍处于非终态且 created_at < to。所有状态计数取 to 时的权威 TaskStatus；同一 Task 只计一次。latest_event 只选择 occurred_at <= to 的安全事件。Token 只汇总 measured_at 位于 [from, to] 的 usage 事实，避免把历史消耗重复归入每次查看；任务计数与 usage 上报计数因此可以不同。

摘要计数使用互斥分类：

- running：RUNNING、SUBMITTED、VERIFYING。
- waiting_approval：WAITING_APPROVAL。
- abnormal：INTERRUPTED、FAILED、CHANGES_REQUESTED。
- completed：COMPLETED。
- needs_attention：waiting_approval + abnormal。

QUEUED、REVIEW_REQUIRED、READY_FOR_MERGE、CANCELLED 等状态仍计入 total，但不被强行放入上述三个首页泳道；独立历史列表保留权威状态。若未来产品希望这些状态进入某个泳道，必须先更新投影合同，不由浏览器猜测。

duration 使用范围内任务的已结束总耗时或活动任务截至响应时刻的已耗时。四个互斥区间为 [0, 5m)、[5m, 15m)、[15m, 30m)、[30m, +∞)；缺少可靠起止事实的任务计入 unreported。share_basis_points 以已上报耗时任务为分母，使用最大余数法使四档合计恰为 10000。

Token 缺失不写零值。usage 汇总只包含已上报任务；reported_task_count 和 unreported_task_count 必须同时返回。与已通过 v2 原型的构成一致，total_units 等于 input_units + output_units + cache_read_units + cache_write_units。已上报 usage 中缺失的可选缓存分量可按零求和；整条 usage 缺失仍是 unreported。

### 5.2 任务列表

    GET /internal/v1/tasks?status=<enum>&cursor=<page-cursor>&limit=<n>

status 可重复，允许值为公开 TaskStatus；不传表示全部。返回：

    {
      "items": [TaskCard],
      "next_cursor": "<opaque-or-null>"
    }

TaskCard：

    {
      "task_id": "task_1",
      "run_id": "run_1",
      "title": "脱敏后的标题",
      "authoritative_status": "RUNNING",
      "display_stage": "executing",
      "current_step": "执行验证",
      "wait_reason": null,
      "elapsed_ms": 42000,
      "latest_event": {
        "kind": "safe_summary",
        "message": "开始验证",
        "occurred_at": "2026-08-11T10:00:00.000Z"
      },
      "revision": 7,
      "etag": "\"task-task_1-r7\""
    }

display_stage 是由权威 Task/Run/Approval 事实确定性派生的页面投影，不是领域状态。禁止百分比、推测性阶段和客户端自行推进。

### 5.3 任务详情

    GET /internal/v1/tasks/{task_id}

返回白名单 TaskDetail：

    {
      "task": TaskCard,
      "task_version_id": "task_version_1",
      "approval": {
        "approval_id": "approval_1",
        "status": "pending",
        "summary": "允许写入当前任务工作树",
        "feedback_required_on_reject": true,
        "etag": "\"approval-approval_1-r2\""
      },
      "result": {
        "outcome": null,
        "verification_summary": null,
        "usage": {
          "status": "unreported",
          "input_units": null,
          "output_units": null,
          "total_units": null,
          "cache_read_units": null,
          "cache_write_units": null
        }
      },
      "available_actions": ["approve", "reject", "cancel"]
    }

不得返回 Context 内容、TaskResult 原始输出、output.delta、内部推理、Artifact URI/内容、工具输入输出、恢复 checkpoint、绝对路径或未分类错误。

### 5.4 一致快照

每个聚合读遵循：

1. 读取 cursor_before。
2. 从共享应用服务/Repository 读取构成投影的权威事实。
3. 读取 cursor_after。
4. 仅在两个游标相等时返回；否则有界重试。
5. 重试耗尽返回 SNAPSHOT_BUSY，绝不拼接不同时间点的数据。

## 6. SSE 合同

### 6.1 连接

    GET /internal/v1/events?after=event-cursor:42
    Accept: text/event-stream
    Origin: <advertised_origin>
    Cookie: <session>

浏览器自动重连时也可发送 Last-Event-ID。若 query after 与 Last-Event-ID 同时存在且不相等，返回 CURSOR_CONFLICT。未知、过旧或不属于当前事件流的游标发送 bridge.reset 后关闭。

每个会话最多 2 条 SSE 连接。超限返回 429 SSE_CONNECTION_LIMIT。响应禁止代理缓冲和缓存。

### 6.2 事件

事件 ID 使用持久 event-cursor:<sequence>；投递为 at-least-once，客户端按 id 去重。

连接建立：

    id: event-cursor:42
    event: bridge.ready
    data: {"schema_version":1,"server_instance_id":"<uuid>","stream_id":"<opaque>","head_cursor":"event-cursor:42"}

安全失效通知：

    id: event-cursor:43
    event: bridge.invalidate
    data: {"schema_version":1,"server_instance_id":"<uuid>","resources":["dashboard","task:task_1"],"head_cursor":"event-cursor:43"}

需要完全刷新：

    id: event-cursor:43
    event: bridge.reset
    data: {"schema_version":1,"server_instance_id":"<uuid>","reason":"cursor_unavailable","head_cursor":"event-cursor:43"}

SSE 不发送原始 DomainEvent、Outbox payload、Driver 消息或 DTO 全量数据。收到 invalidate 后客户端重新 GET 对应资源。

### 6.3 连接健康与恢复

- 服务端至少每 15 秒发送 SSE comment heartbeat。
- 慢消费者越过现有安全队列界限时关闭连接并撤销 stream_id。
- 连接关闭、网络中断、页面进入 reconnecting 或 reset 后，客户端立即进入只读。
- 重连完成、收到 ready、重新读取投影且 event_cursor 追平 head_cursor 后才恢复写按钮。
- server_instance_id 变化表示服务重启：清空内存状态并重新交换会话，不得沿用旧 ETag、stream_id、CSRF 或 confirmation_token。

## 7. 写操作通用合同

所有审批、重试、取消和清理管理写请求都必须携带：

    Origin: <advertised_origin>
    X-Agent-Bridge-CSRF: <csrf-token>
    X-Agent-Bridge-Stream-ID: <connected-stream-id>
    X-Agent-Bridge-Event-Cursor: event-cursor:43
    Idempotency-Key: <client-generated-opaque>
    If-Match: "<target-etag>"

服务端按以下顺序 fail closed：

1. Host、Origin、会话和 CSRF。
2. server_instance_id 与活动 SSE stream。
3. 请求事件游标等于当前 head。
4. If-Match 等于目标当前修订。
5. Idempotency-Key 语义。
6. confirmation_token（需要时）。
7. 应用服务权限、状态机和命令前置条件。

Idempotency-Key 在单个服务实例内按“会话 + 路由 + 目标 + key”缓存。相同 key 和相同规范请求体返回第一次结果；相同 key 不同请求体返回 IDEMPOTENCY_KEY_REUSED。缓存 TTL 为 24 小时或实例终止，以先到者为准。

任何写接口都不得直接执行 Repository transaction；必须调用共享管理命令，由应用服务维持 Repository/Outbox/审计原子性。

DELETE /session 是会话撤销而不是领域管理写入，只要求精确 Origin、Cookie、CSRF 和 Idempotency-Key；即使 SSE 已断开也必须允许用户安全退出。它不要求目标 ETag、事件游标或 stream_id。

## 8. 审批合同

    POST /internal/v1/approvals/{approval_id}/decision

    {
      "schema_version": 1,
      "decision": "approve"
    }

拒绝时 feedback 必填，去除首尾空白后 1 至 2000 个 Unicode code point：

    {
      "schema_version": 1,
      "decision": "reject",
      "feedback": "当前方案会覆盖用户未提交文件，请重新规划隔离路径。"
    }

approve 恢复既有权限请求。reject 必须：

1. 持久化决定和脱敏后的反馈。
2. 明确 deny 当前 Worker 动作。
3. 通过既有 INTERRUPT 迁移把 AgentRun 收口为 interrupted、Task 收口为 INTERRUPTED；若 Driver/Worker 终止失败则 fail closed 并保持不可继续写，而不是恢复 running。
4. 保留事件与审计。
5. 让 Codex 从拒绝事实重新规划；不得继续实质等价动作。

页面显示的“等待 Codex 重新规划”是投影，不新增 Task/Run 状态。当前“deny 后恢复运行”的实现不得作为该接口实现。

## 9. 重试、取消与清理

### 9.1 预览

    GET /internal/v1/runs/{run_id}/actions/{retry|cancel|cleanup}/preview

预览是只读操作，但仍要求会话、Origin 和当前 SSE stream。返回：

    {
      "action": "cancel",
      "run_id": "run_1",
      "target_revision": 7,
      "effects": [
        "请求停止当前活动执行",
        "保留工作树、事件、审计和已有 Artifact 引用"
      ],
      "warnings": [],
      "confirmation_token": "<opaque>",
      "expires_at": "2026-08-11T10:01:00.000Z"
    }

confirmation_token 单次使用、TTL 60 秒，并绑定 server_instance_id、会话、action、run_id、target_revision 和 preview 内容摘要。目标变化后自动失效。

### 9.2 确认

    POST /internal/v1/runs/{run_id}/actions/{retry|cancel|cleanup}

    {
      "schema_version": 1,
      "confirmation_token": "<opaque>"
    }

retry：

- 只允许最新且可重跑的终态或中断 Run。
- 保留原 Run 和审计。
- 使用同一冻结 TaskVersion 创建新 run_id 和新 Agent Session。
- 若目标、范围、规则或权限需要变化，返回 TASK_VERSION_REQUIRED。

cancel：

- 只允许活动 Run。
- 请求 Worker/Driver 确定取消并等待权威状态落盘。
- 保留 worktree、事件、审计和已有 Artifact 引用。

cleanup：

- 只处理经所有权验证属于目标 Run 的残留子进程、租约和 runtime 临时目录。
- 不删除 Task、TaskVersion、Run、事件、审计、Artifact 或保留 worktree。
- 没有残留时返回成功的 no-op；不得把“不存在”当成失败。

## 10. 错误映射

| HTTP | code | category | retryable | 含义 |
| --- | --- | --- | --- | --- |
| 400 | VALIDATION_ERROR | validation | false | Schema、枚举或字段不合法 |
| 400 | REQUEST_BODY_TOO_LARGE | validation | false | 请求体超过 16 KiB |
| 400 | CURSOR_CONFLICT | validation | false | after 与 Last-Event-ID 冲突 |
| 400 | IDEMPOTENCY_KEY_REQUIRED | validation | false | 写请求缺少幂等键 |
| 401 | LAUNCH_SECRET_INVALID | authentication | false | 启动秘密无效、已用或已过期；不区分原因 |
| 401 | SESSION_REQUIRED | authentication | false | 缺少本地会话 |
| 401 | SESSION_EXPIRED | authentication | true | 服务重启或会话失效 |
| 403 | HOST_REJECTED | security | false | Host 不精确 |
| 403 | ORIGIN_REJECTED | security | false | Origin 不同源 |
| 403 | CLIENT_CONTEXT_REJECTED | security | false | 读取标记或 Fetch Metadata 不合法 |
| 403 | CSRF_REJECTED | security | false | CSRF 缺失或错误 |
| 403 | STREAM_NOT_CURRENT | security | true | SSE 未连接或已被替换 |
| 404 | RESOURCE_NOT_FOUND | not_found | false | 白名单资源不存在 |
| 405 | METHOD_NOT_ALLOWED | validation | false | 路由不支持该方法 |
| 409 | STALE_EVENT_CURSOR | conflict | true | 页面事件游标落后 |
| 409 | ETAG_MISMATCH | conflict | true | 目标已变化 |
| 409 | IDEMPOTENCY_KEY_REUSED | conflict | false | 同 key 不同请求 |
| 409 | CONFIRMATION_EXPIRED | conflict | true | 确认已过期或目标变化 |
| 409 | ACTION_NOT_ALLOWED | conflict | false | 当前权威状态不允许操作 |
| 409 | TASK_VERSION_REQUIRED | conflict | false | 重试需要修改 TaskContract |
| 409 | BRIDGE_INSTANCE_CONFLICT | conflict | true | runtime_root 已被占用 |
| 415 | UNSUPPORTED_MEDIA_TYPE | validation | false | 非 JSON 写请求 |
| 428 | PRECONDITION_REQUIRED | validation | false | 缺少 If-Match、事件游标或 stream 前置条件 |
| 429 | SSE_CONNECTION_LIMIT | capacity | true | 会话 SSE 连接过多 |
| 503 | SNAPSHOT_BUSY | availability | true | 无法得到一致快照 |
| 503 | RECOVERY_IN_PROGRESS | availability | true | 启动恢复尚未完成 |
| 500 | INTERNAL_ERROR | internal | false | 已脱敏的内部错误 |

领域/应用错误到 HTTP 的映射只能发生在适配器边界；公开 code 稳定，内部异常名称不构成合同。

## 11. 静态资源交付

- 只从编译输出固定根目录和固定 manifest 提供 index.html、内容哈希 JS/CSS、favicon。
- URL 必须先解码和规范化，再与 manifest 精确匹配。
- 拒绝目录列表、dotfile、source map、符号链接、百分号双重编码、NUL 和任何路径穿越。
- 不提供源 TypeScript、package metadata、数据库、日志、Artifact 或 runtime_root 文件。
- 禁止 inline script/style、eval、远程字体、CDN、Service Worker 和远程资源。
- API 未匹配路由返回 JSON 404；页面导航可回退 index.html，但 /internal/ 和带文件扩展名的路径不得回退。

## 12. 自动打开浏览器

顺序固定为：

1. 校验配置与 runtime_root。
2. 获取单实例锁。
3. 完成 Repository/Outbox/活动运行恢复。
4. 绑定 127.0.0.1 随机端口。
5. 生成一次性启动秘密。
6. 调用系统默认浏览器 opener。

任何前置步骤失败都不得打开浏览器。opener 失败时撤销启动秘密并停止本次 HTTP 服务；命令输出只给安全错误和手动重试建议，不打印完整秘密 URL。测试使用注入的假 opener，不启动真实浏览器。

## 13. 页面与 MCP 一致性

- MCP 和 HTTP 共享同一 BridgeControlService、管理命令、Repository/Outbox transaction 和 PersistentEventFanout。
- 两个适配器只改变表示层，不改变权限、状态迁移、幂等、审计或公开错误语义。
- MCP 写入产生的持久事件必须通过 SSE 使页面投影失效；HTTP 写入也必须对 MCP 后续读取立即可见。
- 页面显示阶段、异常和等待原因均由服务端安全投影产生；浏览器不从事件名称猜状态。
- 若活动 Run 的进程内所有权与持久状态不能一致恢复，服务保持只读并返回 RECOVERY_IN_PROGRESS 或安全失败，不允许页面旁路修复。

## 14. 脱敏与可观察性

### 14.1 威胁边界

本合同保护非预期跨源网页、DNS rebinding、陈旧页面、重放、路径穿越和普通误调用。已经控制同一操作系统用户的恶意本地进程、可读取浏览器流量的扩展、恶意浏览器或被攻陷的操作系统能够绕过 localhost Web 防护，不属于本期可声称抵抗的威胁；发现此需求时必须转向独立身份、HTTPS/mTLS 或原生受信通道并另立 ADR。

### 14.2 日志与响应

日志只允许记录 request_id、路由模板、状态码、耗时、server_instance_id 的安全短标识和稳定错误 code。以下内容不得记录：

- Cookie、启动秘密、CSRF、stream_id、confirmation_token、Idempotency-Key 原文。
- feedback 原文、Context、TaskResult 原始输出、Driver/Provider payload。
- Artifact 内容/URI、绝对路径、环境变量、进程 argv 和未分类异常详情。

反馈和用户可见事件摘要在进入持久化与 HTTP 投影前执行同一安全分类；脱敏失败时 fail closed，不返回原文。

## 15. 依赖清单

### 15.1 复用

- Node.js 22：node:http、crypto、URL、文件与进程 API。
- TypeScript 与仓库现有构建约定。
- BridgeControlService、DomainRepository、Repository/Outbox、ActiveRunRegistry、PersistentEventFanout。
- 现有测试框架和 Fake Driver。

### 15.2 不新增

- React、react-dom
- Vite
- Hono
- WebSocket 库
- Cookie、CSRF、路由或 Schema 外部运行时库
- CDN、远程字体、分析 SDK

预期 pnpm-lock.yaml 不变化。任何新增依赖必须单独说明用途、安全与维护成本，并另获用户确认。

## 16. 版本与开放问题

### 16.1 冻结规则

- Schema 主版本固定为 1；破坏性字段或语义变化使用新的路径版本。
- 同一 v1 中只允许新增客户端可忽略的事件 resource 值；JSON 因严格未知字段策略，新增字段也视为合同变更并须同步客户端与测试。
- 产品事实、公开领域状态和 Driver Protocol 不因本合同变化。

### 16.2 开放问题

无阻塞 OQ-006 的开放技术问题。以下均属于未来范围变化，需另立决策：

- 远程访问、多用户、HTTPS、账号认证。
- React/Hono 或其他框架迁移。
- 公共 API、第三方客户端或跨版本兼容。
- 浏览器通知、Service Worker、远程遥测。
