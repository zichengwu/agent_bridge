# ADR-0003：Phase 4.2 本地管理页技术与安全合同

- 状态：已接受
- 日期：2026-08-11
- 决策范围：PRD OQ-006；本地管理页的进程拓扑、前端与服务端技术、localhost 防护、实时事件和实现边界
- 关联接口合同：[Phase 4.2 HTTP/JSON + SSE v1](../contracts/phase-4-2-management-http-sse-v1.md)
- 关联测试矩阵：[Phase 4.2 Contract 测试矩阵](../testing/phase-4-2-management-contract-test-matrix.md)

## 1. 状态说明

本文严格区分：

- **已确认**：用户已经确认的产品范围和行为。
- **已决策**：仓库既有架构、状态机、安全 ADR 和持久化边界。
- **已接受技术决定**：用户已经确认、用于约束 Phase 4.2 实现与验收的技术合同；它是技术来源，不改写用户原始产品事实。
- **开放问题**：会改变实现或验收、且本文尚未给出答案的问题。

用户已于 2026-08-11 接受本文、关联接口合同和测试矩阵。OQ-006 已关闭，不存在需要研发自行猜测的阻塞技术项；进入实现仍需要单独授权。

## 2. 背景与已确认边界

### 2.1 已确认产品边界

- 首版是本地、单用户、单机 Web 管理页，由项目命令或 Codex 启动并自动打开浏览器。
- 页面不创建任务、不编辑 TaskContract；需求设计、合同生成和任务下发继续由 Codex/MCP 完成。
- 首页先展示“本次会话 / 今日 / 最近 7 天”摘要，默认“今日”，再展示运行中、待审批和异常。
- 页面只展示由权威状态与事件派生的阶段、当前步骤、最近事件、耗时和等待原因，不显示百分比。
- 拒绝审批必须携带反馈，阻止当前方案并返回 Codex 重新规划；不得继续实质等价动作。
- 重试、取消和清理必须展示作用范围与影响并二次确认。
- Token 缺失显示“— / 未上报”，不得按零统计。
- SSE 重连期间保持只读，禁止批准、拒绝、重试、取消和清理。

### 2.2 已决策架构与安全边界

- BridgeControlService、Bridge Core 状态机、Repository/Outbox 和权威领域事件是唯一状态与写入边界。
- 页面和内部接口不得直接读写 SQLite、Artifact、Driver 或 Worker 私有状态。
- MCP、页面和内部接口不得发明私有任务状态或改变公开状态语义。
- OpenCode/Claude SDK、Provider 映射和秘密继续限定在独立 Driver/Worker 边界。
- Provider 凭据、完整 transcript、内部推理、未脱敏日志和本地敏感路径不得进入 HTTP 响应、页面、前端持久化或命令输出。

## 3. 现状审计结论

当前 apps/bridge-mcp 已经是应用组合根：它创建 Repository、Artifact Repository、ActiveRunRegistry、LocalBridgeRuntime、BridgeControlService、Outbox pump 和 PersistentEventFanout。MCP stdio 只是该应用服务的一个传输适配器。

当前实现存在四个 Phase 4.2 前置缺口，页面不得自行补偿：

1. AgentResult.usage 尚未写入 TaskResult，usage.updated 中包含 token 的字段还会被通用凭据脱敏规则移除，无法形成持久、可汇总的 Token 事实。
2. 当前 respondToApproval(deny) 会把 Task/Run 恢复为运行中再向 Worker 发送 deny，不符合“阻止当前方案并返回 Codex 重新规划”。
3. 当前没有“基于同一冻结 TaskVersion 创建新 Run 和新 Session”的手工重试应用服务入口。
4. 当前终态资源清理是内部自动收口，没有面向用户二次确认的预览、幂等和显式安全清理命令。

## 4. 已接受技术决定

### 4.1 前端与构建

首版采用原生 TypeScript、HTML 和 CSS，不采用 React。

- 页面交互范围仅包含摘要、列表、三条处置泳道、详情抽屉、状态反馈和确认对话框，原生 DOM 状态模型足以保持清晰边界。
- 使用现有 TypeScript 编译器和最小 Node 构建脚本生成浏览器资产。
- 不依赖锁文件中的传递依赖；不把 Vitest 间接带入的 Vite 当作项目可用依赖。
- 不生成或交付 source map，不引入 CDN、外部字体、Service Worker 或远程脚本。

### 4.2 本地服务

首版使用 Node.js 22 内置 node:http，不采用 Hono。

- 路由集合固定且规模有限，Node 内置 HTTP 足以实现 JSON、SSE、安全头、体积限制和静态资源交付。
- 不新增外部运行时依赖，预期 pnpm-lock.yaml 不变化。
- HTTP 适配器只能调用共享应用服务和安全 Management Projection，不持有 SQLite 或 Artifact 实现。

### 4.3 实时传输

采用 SSE，不采用 WebSocket 或纯轮询。

- 管理页只需要服务端到浏览器的单向权威变化通知。
- SSE 原生支持浏览器断线重连和 Last-Event-ID，可直接沿用 event-cursor:<sequence>。
- SSE 仅发送安全的“投影失效通知”，不发送原始领域事件、Driver payload 或完整状态；浏览器收到通知后重新读取安全投影。

### 4.4 单进程、单实例所有权

同一 runtime_root 同一时间只能有一个 Bridge 应用实例。该实例共同拥有 MCP stdio、HTTP/SSE、运行时和事件扇出。

启动模式：

1. 项目命令启动 dashboard-only 模式；或
2. Codex 启动 MCP + dashboard 组合模式。

两种模式互斥。第二个实例必须返回稳定错误 BRIDGE_INSTANCE_CONFLICT，不得接管、终止或并行操作已有实例。

原因：审批、取消、反馈和恢复依赖进程内 ActiveRunRegistry。若 MCP 与页面由两个进程分别启动，即使共享 SQLite，也会形成两个不一致的活动运行所有者，无法满足页面/MCP 状态一致性。

### 4.5 localhost 与本地会话保护

- 只监听数值回环地址 127.0.0.1，默认请求系统分配随机端口。
- 禁止 0.0.0.0、局域网地址、主机名监听和隐式 IPv4/IPv6 双栈监听。
- 每个请求校验精确 Host；状态变更和会话交换校验精确同源 Origin。浏览器同源安全 GET 不保证携带 Origin，因此 SSE 与 run action preview 在 Origin 存在时要求精确同源，缺失时必须由 `Sec-Fetch-Site: same-origin` 及各自的会话、媒体类型或客户端标记、当前 stream 门禁共同证明浏览器上下文；JSON 读取继续校验同源客户端标记与 Fetch Metadata；不返回 CORS 允许头。
- 自动打开浏览器时使用 256-bit 一次性启动秘密，放入 URL fragment；成功交换后立即从地址栏删除。
- 启动秘密单次使用、60 秒失效，不写入日志、命令输出、持久化对象或前端存储。
- 交换后建立进程内 host-only 会话 Cookie：每个服务实例使用独立随机 Cookie 名，HttpOnly; SameSite=Strict; Path=/internal/v1，不设置 Domain；HTTP loopback 下不使用要求 Secure 的 __Host- 前缀。
- CSRF Token 独立生成，只保存在页面内存中；所有写请求必须提供精确 Origin、会话 Cookie 和 CSRF Header。
- 服务重启时会话、CSRF Token、确认 Token 和 SSE stream ID 全部失效。

### 4.6 写操作的新鲜度与二次确认

所有写请求必须同时具备：

- Idempotency-Key
- 目标 If-Match ETag
- X-Agent-Bridge-CSRF
- 当前 X-Agent-Bridge-Stream-ID
- 当前 X-Agent-Bridge-Event-Cursor

服务端必须确认 SSE stream 仍处于连接状态、请求游标等于当前事件头、目标修订未变化。页面断线时即使绕过按钮禁用，服务端也会拒绝写入。

重试、取消和清理必须先调用只读 preview 接口。preview 返回作用范围、影响说明和短期 confirmation_token；确认 Token 绑定服务实例、操作、目标、修订和过期时间。最终 POST 缺少或伪造 Token 时 fail closed。

### 4.7 拒绝、重试、取消和清理语义

- approve：允许当前审批动作，沿既有 Driver Permission 合同恢复。
- reject：持久化拒绝和反馈，向 Worker 明确 deny，并把当前 AgentRun 与 Task 安全收口为既有 INTERRUPTED 语义；不得复用当前“deny 后恢复运行”的实现。页面从既有 Task/Run/Approval 事实派生“等待 Codex 重新规划”，不新增领域状态。
- retry：只允许对最新且可重跑的终态或中断 Run 操作；保留旧 Run，使用同一冻结 TaskVersion 创建新 run_id 和新 Session。若目标、范围、业务规则或权限需要变化，返回 TASK_VERSION_REQUIRED，由 Codex 创建新版本。
- cancel：请求当前活动 Run 确定取消；保留 worktree、事件、审计和已存在 Artifact 引用。
- cleanup：只处理确认属于目标 Run 的残留子进程、租约和 runtime 临时目录；不得删除 Task、事件、审计、Artifact 或保留 worktree。

### 4.8 安全读模型与 Token 事实

HTTP 不返回 Repository 原始对象，而由 Management Projection 生成严格白名单 DTO。

允许公开：稳定 ID、权威状态、记录修订、脱敏标题、阶段、等待原因、安全事件摘要、验证结论和 Token 计数。

禁止公开：Context 内容、TaskResult 原始输出、output.delta、工具输入输出、Artifact URI/内容、恢复 checkpoint、绝对路径和未分类错误详情。

Token 消耗以现有 Driver Protocol 的 AgentResult.usage 为首要来源；ContextUsage 只在明确标记 driver_estimate 或 bridge_estimate 时作为估算来源，不把上下文窗口占用伪装成精确账单。持久结构使用不与凭据扫描器冲突的字段：

    {
      "usage": {
        "unit": "token",
        "input_units": 1200,
        "output_units": 300,
        "cache_read_units": 100,
        "cache_write_units": 20,
        "source": "driver_exact",
        "measured_at": "2026-08-11T10:00:00.000Z"
      }
    }

缺失 usage 的 Task 保持 unreported，不得产生零值。与已通过 v2 原型的 Token 构成一致，total_units 定义为 input_units + output_units + cache_read_units + cache_write_units；缺失的可选缓存分量可按零参与单条已上报 usage 的求和，但不得据此把整条缺失 usage 记为零。

### 4.9 时间范围定义

- “本次会话”：当前 Bridge 应用实例从 server_started_at 到当前时间的权威活动，不指浏览器标签页或 Agent Session。
- “今日”：服务端配置时区中当日 00:00 到当前时间。
- “最近 7 天”：同一时区中包含今天的七个自然日。
- 时区由服务端确定并随响应返回，浏览器不得自行改变统计边界。

## 5. 静态资源与浏览器启动边界

- 静态文件从编译产物固定目录读取，不依赖调用进程当前目录。
- 只允许固定资源清单；拒绝目录列表、dotfile、source map、符号链接和路径穿越。
- HTML 使用 Cache-Control: no-store；内容哈希 JS/CSS 可使用 immutable。
- 使用严格 CSP、nosniff、no-referrer 和禁止 frame 的响应头。
- 服务完成 preflight、实例锁、恢复和监听后才自动打开浏览器。
- 浏览器打开失败时撤销一次性秘密并停止本次 HTTP 服务；错误输出不包含秘密 URL。

## 6. 未采用方案

- **React + Vite**：当前交互规模不足以抵消新增浏览器运行时和构建依赖；未来页面复杂度显著增长时可另立 ADR 评估。
- **Hono**：固定内部路由不需要外部 Web 框架；未来公共 API、插件中间件或远程认证不属于本期。
- **纯轮询**：能够实现但会丢失明确的连接健康和游标恢复语义，不利于重连期间写保护。
- **WebSocket**：双向协议能力过剩，增加连接状态和安全面。
- **独立 dashboard 进程与 MCP 进程共享 SQLite**：无法共享活动 Driver/Run 所有权，拒绝采用。
- **无本地会话、仅依赖 loopback**：不能抵抗浏览器跨源请求和 localhost 攻击，拒绝采用。
- **向浏览器发送原始 Outbox/Driver 事件**：会扩大敏感信息泄漏和兼容面，拒绝采用。

## 7. 实施切片

1. **管理读模型与 usage 事实**：增加安全投影、稳定摘要口径、Token 持久化和 snapshot/cursor 一致性；不实现 HTTP。
2. **共享管理命令**：修正 reject/replan，增加 retry 和 cleanup preview/confirm；MCP 与 HTTP 共用服务。
3. **本地服务安全层**：实例锁、会话交换、Host/Origin/CSRF、错误映射和静态资源。
4. **SSE 与并发合同**：stream ID、游标恢复、reset、慢消费者、断线写保护、ETag 和幂等重放。
5. **正式页面**：按已验证 v2 产品行为实现原生 TypeScript 页面，不扩展产品范围。
6. **集成与安全门禁**：Fake Driver/loopback、Contract、E2E、脱敏和资源清理审计；不运行真实 Provider。

## 8. 影响与风险

- 原生 TypeScript 降低依赖面，但需要维持明确的客户端状态归约器和 DOM 安全规范。
- 一次性 fragment 能避免秘密进入 HTTP，但自动打开浏览器时秘密会短暂作为系统 opener 参数存在；通过单次、60 秒 TTL、不记录和交换后立即撤销降低风险。
- 严格全局事件游标可能使无关任务更新导致写冲突；首版接受刷新后重试，以换取不在陈旧页面上执行高风险动作。
- 当前 deny、retry、cleanup 和 usage 均需要先修正应用层；这些工作是页面实现的硬前置，不得延后到 UI 内处理。
- SSE 仅发失效通知会增加少量本地读取，但可显著缩小浏览器事件 Schema 和敏感信息面。
- Cookie 不按端口隔离，因此使用实例随机 Cookie 名避免不同 runtime_root 的本地服务互相覆盖。本合同抵抗非预期跨源网页、陈旧页面和误调用；已控制同一系统用户的恶意本地进程、浏览器扩展或操作系统不在本地 Web 会话能够可靠防御的范围内。

## 9. 后续实施门禁

OQ-006 的文档门禁已于 2026-08-11 经用户确认关闭。后续仍需获得进入实现的明确授权；接受技术合同不自动授权安装依赖、真实 Provider、提交、推送或 PR。实现必须按第 7 节切片推进，并以关联测试矩阵作为退出条件。
