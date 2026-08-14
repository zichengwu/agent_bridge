/// <reference lib="DOM" />

type RangeKind = "session" | "today" | "7d";
type DisplayStage =
  "preparing_context" | "executing" | "waiting_approval" | "verifying" | "review" | "completed";
type SnapshotKind = "dashboard" | "tasks" | "detail";
type ConnectionPhase =
  "booting" | "connecting" | "syncing" | "current" | "reconnecting" | "reset" | "error" | "fatal";
type RiskAction = "retry" | "cancel" | "cleanup";

interface SafeEvent {
  readonly kind: "safe_summary";
  readonly message: string;
  readonly occurred_at: string;
}

export interface DashboardTaskCard {
  readonly task_id: string;
  readonly run_id: string | null;
  readonly title: string;
  readonly authoritative_status: string;
  readonly display_stage: DisplayStage;
  readonly current_step: string;
  readonly wait_reason: string | null;
  readonly elapsed_ms: number | null;
  readonly latest_event: SafeEvent | null;
  readonly revision: number;
  readonly etag: string;
}

interface UsageView {
  readonly status: "reported" | "unreported";
  readonly input_units: number | null;
  readonly output_units: number | null;
  readonly cache_read_units: number | null;
  readonly cache_write_units: number | null;
  readonly total_units: number | null;
}

interface TaskDetail {
  readonly task: DashboardTaskCard;
  readonly task_version_id: string;
  readonly approval: {
    readonly approval_id: string;
    readonly status: string;
    readonly summary: string;
    readonly feedback_required_on_reject: true;
    readonly etag: string;
  } | null;
  readonly result: {
    readonly outcome: string | null;
    readonly verification_summary: "passed" | "failed" | "not_run" | null;
    readonly usage: UsageView;
  };
  readonly available_actions: readonly ("approve" | "reject" | "cancel")[];
}

interface DashboardData {
  readonly range: {
    readonly kind: RangeKind;
    readonly from: string;
    readonly to: string;
    readonly timezone: string;
  };
  readonly counts: {
    readonly total: number;
    readonly running: number;
    readonly needs_attention: number;
    readonly waiting_approval: number;
    readonly abnormal: number;
    readonly completed: number;
  };
  readonly duration: {
    readonly reported_task_count: number;
    readonly unreported_task_count: number;
    readonly buckets: readonly {
      readonly key: "lt_5m" | "5m_to_lt_15m" | "15m_to_lt_30m" | "gte_30m";
      readonly task_count: number;
      readonly share_basis_points: number;
    }[];
  };
  readonly usage: {
    readonly reported_task_count: number;
    readonly unreported_task_count: number;
    readonly input_units: number | null;
    readonly output_units: number | null;
    readonly cache_read_units: number | null;
    readonly cache_write_units: number | null;
    readonly total_units: number | null;
  };
  readonly lanes: {
    readonly running_task_ids: readonly string[];
    readonly approval_task_ids: readonly string[];
    readonly abnormal_task_ids: readonly string[];
  };
}

interface SessionData {
  readonly csrf_token: string;
  readonly server_started_at: string;
  readonly timezone: string;
}

interface ActionPreview {
  readonly action: RiskAction;
  readonly run_id: string;
  readonly target_revision: number;
  readonly etag: string;
  readonly effects: readonly string[];
  readonly warnings: readonly string[];
  readonly confirmation_token: string;
  readonly expires_at: string;
  readonly event_cursor: string;
}

interface Envelope<T> {
  readonly schema_version: 1;
  readonly server_instance_id: string;
  readonly event_cursor: string;
  readonly data: T;
}

export interface DashboardClientState {
  readonly phase: ConnectionPhase;
  readonly server_instance_id: string | null;
  readonly stream_id: string | null;
  readonly head_cursor: string | null;
  readonly generation: number;
  readonly selected_task_id: string | null;
  readonly snapshots: Readonly<Record<SnapshotKind, string | null>>;
}

export type DashboardClientAction =
  | {
      readonly type: "session";
      readonly server_instance_id: string;
      readonly event_cursor: string;
    }
  | {
      readonly type: "stream_ready";
      readonly server_instance_id: string;
      readonly stream_id: string;
      readonly head_cursor: string;
    }
  | {
      readonly type: "invalidate";
      readonly server_instance_id: string;
      readonly head_cursor: string;
    }
  | { readonly type: "stream_disconnected" }
  | {
      readonly type: "reset";
      readonly server_instance_id: string;
      readonly head_cursor: string;
    }
  | { readonly type: "begin_sync" }
  | {
      readonly type: "snapshot";
      readonly kind: SnapshotKind;
      readonly server_instance_id: string;
      readonly event_cursor: string;
      readonly generation: number;
    }
  | { readonly type: "select_task"; readonly task_id: string }
  | { readonly type: "close_task" }
  | { readonly type: "sync_error" }
  | { readonly type: "fatal" };

export function createDashboardClientState(): DashboardClientState {
  return Object.freeze({
    phase: "booting",
    server_instance_id: null,
    stream_id: null,
    head_cursor: null,
    generation: 0,
    selected_task_id: null,
    snapshots: emptySnapshots(),
  });
}

export function reduceDashboardClientState(
  state: DashboardClientState,
  action: DashboardClientAction,
): DashboardClientState {
  switch (action.type) {
    case "session":
      return freezeState({
        ...state,
        phase: "connecting",
        server_instance_id: action.server_instance_id,
        stream_id: null,
        head_cursor: action.event_cursor,
        generation: state.generation + 1,
        snapshots: emptySnapshots(),
      });
    case "stream_ready":
      if (
        state.server_instance_id !== null &&
        state.server_instance_id !== action.server_instance_id
      ) {
        return fatalState(state);
      }
      return freezeState({
        ...state,
        phase: "syncing",
        server_instance_id: action.server_instance_id,
        stream_id: action.stream_id,
        head_cursor: action.head_cursor,
        generation: state.generation + 1,
        snapshots: emptySnapshots(),
      });
    case "invalidate":
      if (state.server_instance_id !== action.server_instance_id) return fatalState(state);
      return freezeState({
        ...state,
        phase: "syncing",
        head_cursor: action.head_cursor,
        generation: state.generation + 1,
        snapshots: emptySnapshots(),
      });
    case "stream_disconnected":
      return freezeState({
        ...state,
        phase: "reconnecting",
        stream_id: null,
        generation: state.generation + 1,
        snapshots: emptySnapshots(),
      });
    case "reset":
      if (state.server_instance_id !== action.server_instance_id) return fatalState(state);
      return freezeState({
        ...state,
        phase: "reset",
        stream_id: null,
        head_cursor: action.head_cursor,
        generation: state.generation + 1,
        snapshots: emptySnapshots(),
      });
    case "begin_sync":
      return freezeState({
        ...state,
        phase: "syncing",
        generation: state.generation + 1,
        snapshots: emptySnapshots(),
      });
    case "snapshot": {
      if (action.generation !== state.generation) return state;
      if (state.server_instance_id !== action.server_instance_id) return fatalState(state);
      if (state.head_cursor !== action.event_cursor) return state;
      const snapshots = Object.freeze({ ...state.snapshots, [action.kind]: action.event_cursor });
      const next = freezeState({ ...state, snapshots });
      return snapshotsAreCurrent(next) ? freezeState({ ...next, phase: "current" }) : next;
    }
    case "select_task":
      return freezeState({
        ...state,
        selected_task_id: action.task_id,
        phase: state.phase === "current" ? "syncing" : state.phase,
        generation: state.generation + 1,
        snapshots: Object.freeze({ ...state.snapshots, detail: null }),
      });
    case "close_task": {
      const next = freezeState({
        ...state,
        selected_task_id: null,
        generation: state.generation + 1,
        snapshots: Object.freeze({ ...state.snapshots, detail: null }),
      });
      return snapshotsAreCurrent(next) ? freezeState({ ...next, phase: "current" }) : next;
    }
    case "sync_error":
      return freezeState({ ...state, phase: "error", snapshots: emptySnapshots() });
    case "fatal":
      return fatalState(state);
  }
}

export function dashboardWritesAllowed(state: DashboardClientState): boolean {
  return state.phase === "current" && snapshotsAreCurrent(state);
}

export function mergeTaskCards(
  current: readonly DashboardTaskCard[],
  incoming: readonly DashboardTaskCard[],
): readonly DashboardTaskCard[] {
  const revisions = new Map(current.map((task) => [task.task_id, task]));
  for (const task of incoming) {
    const previous = revisions.get(task.task_id);
    if (previous === undefined || task.revision >= previous.revision)
      revisions.set(task.task_id, task);
  }
  return Object.freeze(
    [...revisions.values()].sort((left, right) => left.task_id.localeCompare(right.task_id)),
  );
}

export function formatUsageUnits(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${formatDecimal(value / 1_000)}k`;
  return `${formatDecimal(value / 1_000_000)}m`;
}

const stageLabels: Readonly<Record<DisplayStage, string>> = Object.freeze({
  preparing_context: "准备上下文",
  executing: "Agent 执行",
  waiting_approval: "等待审批",
  verifying: "独立验证",
  review: "Review",
  completed: "完成",
});
const stageOrder: readonly DisplayStage[] = Object.freeze([
  "preparing_context",
  "executing",
  "waiting_approval",
  "verifying",
  "review",
  "completed",
]);
const durationLabels = Object.freeze({
  lt_5m: "< 5 分钟",
  "5m_to_lt_15m": "5–15 分钟",
  "15m_to_lt_30m": "15–30 分钟",
  gte_30m: "≥ 30 分钟",
});

let clientState = createDashboardClientState();
let csrfToken: string | null = null;
let activeRange: RangeKind = "today";
let dashboardData: DashboardData | null = null;
let taskCards: readonly DashboardTaskCard[] = Object.freeze([]);
let selectedDetail: TaskDetail | null = null;
let eventSource: EventSource | null = null;
let syncTimer: number | undefined;
let toastTimer: number | undefined;
let pendingPreview: ActionPreview | null = null;
let writePending = false;

function emptySnapshots(): Readonly<Record<SnapshotKind, string | null>> {
  return Object.freeze({ dashboard: null, tasks: null, detail: null });
}

function freezeState(state: DashboardClientState): DashboardClientState {
  return Object.freeze(state);
}

function fatalState(state: DashboardClientState): DashboardClientState {
  return freezeState({
    ...state,
    phase: "fatal",
    stream_id: null,
    generation: state.generation + 1,
    snapshots: emptySnapshots(),
  });
}

function snapshotsAreCurrent(state: DashboardClientState): boolean {
  const head = state.head_cursor;
  if (head === null || state.stream_id === null) return false;
  if (state.snapshots.dashboard !== head || state.snapshots.tasks !== head) return false;
  return state.selected_task_id === null || state.snapshots.detail === head;
}

function dispatch(action: DashboardClientAction): void {
  clientState = reduceDashboardClientState(clientState, action);
  renderConnection();
  renderWriteControls();
}

async function startDashboard(): Promise<void> {
  bindStaticEvents();
  renderAll();
  try {
    const launchSecret = consumeLaunchSecretFragment();
    const envelope =
      launchSecret === null
        ? await apiRequest<SessionData>("/internal/v1/session")
        : await apiRequest<SessionData>("/internal/v1/session/exchange", {
            method: "POST",
            body: JSON.stringify({ schema_version: 1, launch_secret: launchSecret }),
          });
    csrfToken = envelope.data.csrf_token;
    dispatch({
      type: "session",
      server_instance_id: envelope.server_instance_id,
      event_cursor: envelope.event_cursor,
    });
    openEventStream(envelope.event_cursor);
  } catch (error) {
    handleFatalSessionError(error);
  }
}

function consumeLaunchSecretFragment(): string | null {
  const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  if (fragment === "") return null;
  const values = new URLSearchParams(fragment).getAll("launch_secret");
  return values.length === 1 && values[0] !== undefined && values[0].length >= 32
    ? values[0]
    : null;
}

function openEventStream(afterCursor: string): void {
  eventSource?.close();
  dispatch({ type: "stream_disconnected" });
  eventSource = new EventSource(`/internal/v1/events?after=${encodeURIComponent(afterCursor)}`);
  eventSource.addEventListener("bridge.ready", (event) => {
    const data = readReadyEvent(event);
    dispatch({
      type: "stream_ready",
      server_instance_id: data.server_instance_id,
      stream_id: data.stream_id,
      head_cursor: data.head_cursor,
    });
    if (clientState.phase === "fatal") {
      handleInstanceChange();
      return;
    }
    scheduleSync(0);
  });
  eventSource.addEventListener("bridge.invalidate", (event) => {
    const data = readInvalidateEvent(event);
    dispatch({
      type: "invalidate",
      server_instance_id: data.server_instance_id,
      head_cursor: data.head_cursor,
    });
    if (clientState.phase === "fatal") {
      handleInstanceChange();
      return;
    }
    scheduleSync(20);
  });
  eventSource.addEventListener("bridge.reset", (event) => {
    const data = readResetEvent(event);
    eventSource?.close();
    dispatch({
      type: "reset",
      server_instance_id: data.server_instance_id,
      head_cursor: data.head_cursor,
    });
    if (clientState.phase === "fatal") {
      handleInstanceChange();
      return;
    }
    openEventStream(data.head_cursor);
  });
  eventSource.onerror = () => {
    dispatch({ type: "stream_disconnected" });
  };
}

function scheduleSync(delay: number): void {
  if (syncTimer !== undefined) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = undefined;
    void synchronizeSnapshots();
  }, delay);
}

async function synchronizeSnapshots(): Promise<void> {
  if (clientState.stream_id === null || clientState.server_instance_id === null) return;
  const generation = clientState.generation;
  const selectedTaskId = clientState.selected_task_id;
  try {
    const [dashboardEnvelope, tasksResult, detailEnvelope] = await Promise.all([
      apiRequest<DashboardData>(`/internal/v1/dashboard?range=${activeRange}`),
      readAllTasks(),
      selectedTaskId === null
        ? Promise.resolve(null)
        : apiRequest<TaskDetail>(`/internal/v1/tasks/${encodeURIComponent(selectedTaskId)}`),
    ]);
    if (generation !== clientState.generation) return;
    const expectedCursor = clientState.head_cursor;
    if (
      expectedCursor === null ||
      dashboardEnvelope.event_cursor !== expectedCursor ||
      tasksResult.event_cursor !== expectedCursor ||
      (detailEnvelope !== null && detailEnvelope.event_cursor !== expectedCursor)
    ) {
      scheduleSync(40);
      return;
    }
    dashboardData = readDashboardData(dashboardEnvelope.data);
    taskCards = mergeTaskCards([], tasksResult.items.map(readTaskCard));
    selectedDetail = detailEnvelope === null ? null : readTaskDetail(detailEnvelope.data);
    dispatchSnapshot("dashboard", dashboardEnvelope, generation);
    dispatchSnapshot("tasks", tasksResult, generation);
    if (detailEnvelope !== null) dispatchSnapshot("detail", detailEnvelope, generation);
    renderAll();
  } catch (error) {
    const code = publicErrorCode(error);
    if (code === "SESSION_EXPIRED") {
      handleFatalSessionError(error);
      return;
    }
    dispatch({ type: "sync_error" });
    renderBoardState("无法读取 Bridge 状态", publicErrorMessage(error));
  }
}

function dispatchSnapshot(
  kind: SnapshotKind,
  envelope: Pick<Envelope<unknown>, "server_instance_id" | "event_cursor">,
  generation: number,
): void {
  dispatch({
    type: "snapshot",
    kind,
    server_instance_id: envelope.server_instance_id,
    event_cursor: envelope.event_cursor,
    generation,
  });
  if (clientState.phase === "fatal") handleInstanceChange();
}

async function readAllTasks(): Promise<
  Pick<Envelope<unknown>, "server_instance_id" | "event_cursor"> & {
    readonly items: readonly DashboardTaskCard[];
  }
> {
  let cursor: string | null = null;
  let eventCursor: string | null = null;
  let instanceId: string | null = null;
  const items: DashboardTaskCard[] = [];
  do {
    const query =
      cursor === null ? "?limit=200" : `?limit=200&cursor=${encodeURIComponent(cursor)}`;
    const envelope = await apiRequest<unknown>(`/internal/v1/tasks${query}`);
    const page = readTaskPage(envelope.data);
    if (
      (eventCursor !== null && eventCursor !== envelope.event_cursor) ||
      (instanceId !== null && instanceId !== envelope.server_instance_id)
    ) {
      throw new DashboardPublicError("SNAPSHOT_BUSY", "页面状态正在变化，请稍后重试。");
    }
    eventCursor = envelope.event_cursor;
    instanceId = envelope.server_instance_id;
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  if (eventCursor === null || instanceId === null)
    throw new DashboardPublicError("INTERNAL_ERROR", "无法读取任务列表。");
  return Object.freeze({
    server_instance_id: instanceId,
    event_cursor: eventCursor,
    items: Object.freeze(items),
  });
}

function renderAll(): void {
  renderConnection();
  renderOverview();
  renderBoard();
  renderHistory();
  renderDrawer();
  renderWriteControls();
}

function renderConnection(): void {
  const shell = query<HTMLElement>(".app-shell");
  shell.dataset.connection = clientState.phase;
  const text = query<HTMLElement>("#connection-text");
  const detail = query<HTMLElement>("#connection-detail");
  const bannerTitle = query<HTMLElement>("#runtime-banner-title");
  const bannerDetail = query<HTMLElement>("#runtime-banner-detail");
  const labels: Readonly<Record<ConnectionPhase, readonly [string, string]>> = Object.freeze({
    booting: ["正在建立本地会话", "页面保持只读"],
    connecting: ["正在连接事件流", "页面保持只读"],
    syncing: ["正在追平权威快照", "页面保持只读"],
    current: ["Bridge 已连接", "事件流与快照已追平"],
    reconnecting: ["Bridge 正在重连", "保留最后一次权威状态"],
    reset: ["事件游标已重置", "正在执行完整刷新"],
    error: ["Bridge 读取失败", "页面保持只读"],
    fatal: ["本地会话已失效", "请重新打开管理页"],
  });
  const label = labels[clientState.phase];
  text.textContent = label[0];
  detail.textContent = label[1];
  bannerTitle.textContent = label[0];
  bannerDetail.textContent =
    clientState.phase === "fatal"
      ? "Bridge 实例已变化或会话已失效；旧 CSRF、stream、ETag 与确认信息均已丢弃。"
      : "当前展示最后一次权威状态；写操作将在事件流与所需快照全部追平后启用。";
}

function renderOverview(): void {
  const data = dashboardData;
  if (data === null) return;
  const rangeTitle: Readonly<Record<RangeKind, string>> = Object.freeze({
    session: "本次会话运行摘要",
    today: "今日运行摘要",
    "7d": "最近 7 天运行摘要",
  });
  setText("#overview-title", rangeTitle[data.range.kind]);
  setText("#metric-total", String(data.counts.total));
  setText("#metric-total-foot", `已完成 ${data.counts.completed}`);
  setText("#metric-running", String(data.counts.running));
  setText("#metric-attention", String(data.counts.needs_attention));
  setText(
    "#metric-attention-foot",
    `待审批 ${data.counts.waiting_approval} · 异常 ${data.counts.abnormal}`,
  );
  setText("#duration-unit", `${data.duration.reported_task_count} 个任务已上报`);
  setText(
    "#duration-note",
    data.duration.unreported_task_count === 0
      ? "全部任务均有可靠耗时事实。"
      : `${data.duration.unreported_task_count} 个任务缺少可靠起止事实。`,
  );
  const durationRoot = query<HTMLElement>("#duration-bars");
  durationRoot.replaceChildren(
    ...data.duration.buckets.map((bucket) => {
      const row = element("div", "duration-row");
      if (bucket.key === "gte_30m") row.classList.add("is-risk");
      row.append(
        textElement("span", "duration-label", durationLabels[bucket.key]),
        (() => {
          const track = element("div", "bar-track");
          const fill = element("span", "bar-fill");
          fill.style.width = `${Math.min(100, bucket.share_basis_points / 100)}%`;
          track.append(fill);
          return track;
        })(),
        textElement(
          "span",
          "duration-value",
          `${bucket.task_count} · ${formatBasisPoints(bucket.share_basis_points)}`,
        ),
      );
      return row;
    }),
  );
  renderUsage(data);
  document.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((button) => {
    const selected = button.dataset.range === activeRange;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function renderUsage(data: DashboardData): void {
  const usage = data.usage;
  const reported = usage.reported_task_count > 0 && usage.total_units !== null;
  setText("#metric-token", formatUsageUnits(usage.total_units));
  setText(
    "#metric-token-foot",
    reported
      ? `${usage.reported_task_count} 个任务已上报`
      : `${usage.unreported_task_count} 个任务未上报`,
  );
  setText("#token-chart-total", formatUsageUnits(usage.total_units));
  setText(
    "#token-reporting",
    reported ? (usage.unreported_task_count === 0 ? "完整上报" : "部分上报") : "未上报",
  );
  setText("#token-input", formatUsageUnits(usage.input_units));
  setText("#token-output", formatUsageUnits(usage.output_units));
  setText("#token-cache-read", formatUsageUnits(usage.cache_read_units));
  setText("#token-cache-write", formatUsageUnits(usage.cache_write_units));
  setText(
    "#token-note",
    usage.unreported_task_count === 0
      ? "范围内 usage 已完整上报。"
      : `${usage.unreported_task_count} 个任务没有 usage；缺失数据不会按 0 计算。`,
  );
  const total = usage.total_units ?? 0;
  const parts = [
    usage.input_units,
    usage.output_units,
    usage.cache_read_units,
    usage.cache_write_units,
  ];
  const selectors = [".token-input", ".token-output", ".token-cache-read", ".token-cache-write"];
  selectors.forEach((selector, index) => {
    query<HTMLElement>(`#token-stack ${selector}`).style.width =
      total === 0 ? "0%" : `${(((parts[index] ?? 0) / total) * 100).toFixed(2)}%`;
  });
  query<HTMLElement>("#token-stack").setAttribute(
    "aria-label",
    reported
      ? `Token 构成：输入 ${formatUsageUnits(usage.input_units)}，输出 ${formatUsageUnits(usage.output_units)}，缓存读 ${formatUsageUnits(usage.cache_read_units)}，缓存写 ${formatUsageUnits(usage.cache_write_units)}`
      : "Token 数据未上报",
  );
}

function renderBoard(): void {
  const data = dashboardData;
  if (data === null) {
    renderBoardState("正在读取权威状态", "正在恢复任务、审批和事件。");
    return;
  }
  const byId = new Map(taskCards.map((task) => [task.task_id, task]));
  const lanes = [
    ["running", data.lanes.running_task_ids],
    ["approval", data.lanes.approval_task_ids],
    ["anomaly", data.lanes.abnormal_task_ids],
  ] as const;
  const activeCount = lanes.reduce((total, lane) => total + lane[1].length, 0);
  query<HTMLElement>("#board-state-panel").hidden = activeCount !== 0;
  query<HTMLElement>("#board-grid").hidden = activeCount === 0;
  if (activeCount === 0) {
    renderBoardState("当前没有活动或待处理任务", "历史任务仍可在“全部任务”中查看。");
  }
  for (const [name, ids] of lanes) {
    const cards = ids.flatMap((id) => {
      const task = byId.get(id);
      return task === undefined ? [] : [task];
    });
    setText(`#${name}-count`, String(cards.length).padStart(2, "0"));
    const root = query<HTMLElement>(`#${name}-list`);
    root.replaceChildren(
      ...(cards.length === 0
        ? [textElement("div", "lane-empty", laneEmptyMessage(name))]
        : cards.map((task) => taskCardButton(task, name))),
    );
  }
  setText(
    "#attention-summary",
    data.counts.needs_attention === 0
      ? "当前无待处理事项"
      : `${data.counts.needs_attention} 项需要人工处理`,
  );
}

function renderBoardState(title: string, detail: string): void {
  setText("#board-state-title", title);
  setText("#board-state-detail", detail);
}

function taskCardButton(
  task: DashboardTaskCard,
  lane: "running" | "approval" | "anomaly",
): HTMLButtonElement {
  const button = element("button", "task-row");
  button.type = "button";
  button.dataset.taskId = task.task_id;
  button.classList.toggle("is-selected", task.task_id === clientState.selected_task_id);
  const topline = element("div", "task-topline");
  if (lane === "running") {
    topline.append(
      textElement("span", "task-title", task.title),
      textElement("span", "task-time", formatElapsed(task.elapsed_ms)),
    );
  } else {
    topline.append(
      textElement(
        "span",
        `tone-label ${lane === "approval" ? "tone-approval" : "tone-anomaly"}`,
        lane === "approval" ? "等待批准" : "需要处理",
      ),
      textElement("span", "task-time", formatElapsed(task.elapsed_ms)),
    );
    button.append(topline, textElement("div", "task-title", task.title));
  }
  if (lane === "running") button.append(topline);
  button.append(
    textElement("div", "task-meta", `${stageLabels[task.display_stage]} · ${task.current_step}`),
  );
  if (lane === "running") button.append(stageStrip(task.display_stage));
  button.append(
    textElement(
      "div",
      "task-event",
      task.latest_event === null ? "最近：暂无安全事件摘要" : `最近：${task.latest_event.message}`,
    ),
    textElement("div", "task-wait", `等待原因：${task.wait_reason ?? "无"}`),
  );
  button.addEventListener("click", () => selectTask(task.task_id));
  return button;
}

function stageStrip(stage: DisplayStage): HTMLElement {
  const root = element("div", "stage-strip");
  root.setAttribute("aria-label", `当前阶段：${stageLabels[stage]}`);
  const current = stageOrder.indexOf(stage);
  stageOrder.forEach((_item, index) => {
    const step = element("span", "stage-step");
    if (index < current) step.classList.add("is-done");
    if (index === current) step.classList.add("is-current");
    root.append(step);
  });
  return root;
}

function renderHistory(): void {
  setText("#history-count", `${taskCards.length} 个任务`);
  const root = query<HTMLElement>("#history-list");
  root.replaceChildren(
    ...(taskCards.length === 0
      ? [textElement("div", "history-empty", "当前没有历史任务")]
      : taskCards.map((task) => {
          const button = element("button", "history-row");
          button.type = "button";
          button.classList.toggle("is-selected", task.task_id === clientState.selected_task_id);
          const main = element("span");
          main.append(
            textElement("span", "history-main", task.title),
            textElement("span", "history-sub", task.task_id),
          );
          button.append(
            main,
            textElement("span", "history-cell", task.authoritative_status),
            textElement("span", "history-cell", stageLabels[task.display_stage]),
            textElement("span", "history-cell", formatElapsed(task.elapsed_ms)),
          );
          button.addEventListener("click", () => selectTask(task.task_id));
          return button;
        })),
  );
}

function selectTask(taskId: string): void {
  selectedDetail = null;
  dispatch({ type: "select_task", task_id: taskId });
  openDrawer();
  renderAll();
  scheduleSync(0);
}

function closeDrawer(): void {
  selectedDetail = null;
  dispatch({ type: "close_task" });
  const drawer = query<HTMLElement>("#detail-drawer");
  drawer.inert = true;
  drawer.setAttribute("aria-hidden", "true");
  query<HTMLElement>(".app-shell").classList.remove("has-drawer");
  renderAll();
}

function openDrawer(): void {
  const drawer = query<HTMLElement>("#detail-drawer");
  drawer.inert = false;
  drawer.setAttribute("aria-hidden", "false");
  query<HTMLElement>(".app-shell").classList.add("has-drawer");
}

function renderDrawer(): void {
  const detail = selectedDetail;
  if (clientState.selected_task_id === null) return;
  openDrawer();
  if (detail === null) {
    setText("#drawer-title", "正在读取任务详情");
    query<HTMLElement>("#drawer-facts").replaceChildren();
    setText("#drawer-event", "正在读取最近安全事件摘要");
    setText("#drawer-result", "—");
    query<HTMLElement>("#approval-block").hidden = true;
    query<HTMLElement>("#drawer-actions").replaceChildren();
    return;
  }
  setText("#drawer-title", detail.task.title);
  const tone = query<HTMLElement>("#drawer-tone");
  tone.className = `tone-label ${toneClass(detail.task)}`;
  tone.textContent = stageLabels[detail.task.display_stage];
  const facts = query<HTMLElement>("#drawer-facts");
  facts.replaceChildren(
    ...factNodes([
      ["权威状态", detail.task.authoritative_status],
      ["当前阶段", stageLabels[detail.task.display_stage]],
      ["当前步骤", detail.task.current_step],
      ["等待原因", detail.task.wait_reason ?? "无"],
      ["已耗时", formatElapsed(detail.task.elapsed_ms)],
      ["任务版本", detail.task_version_id],
    ]),
  );
  setText(
    "#drawer-event",
    detail.task.latest_event === null
      ? "暂无安全事件摘要"
      : `${formatEventTime(detail.task.latest_event.occurred_at)} · ${detail.task.latest_event.message}`,
  );
  setText(
    "#drawer-result",
    `结果：${detail.result.outcome ?? "尚未形成"}；验证：${verificationLabel(detail.result.verification_summary)}；Token：${detail.result.usage.status === "reported" ? formatUsageUnits(detail.result.usage.total_units) : "— / 未上报"}`,
  );
  const approvalBlock = query<HTMLElement>("#approval-block");
  approvalBlock.hidden = detail.approval === null;
  if (detail.approval !== null) setText("#approval-summary", detail.approval.summary);
  renderActions(detail);
}

function renderActions(detail: TaskDetail): void {
  const root = query<HTMLElement>("#drawer-actions");
  const buttons: HTMLButtonElement[] = [];
  if (detail.available_actions.includes("reject")) {
    buttons.push(actionButton("拒绝", "", () => void decideApproval("reject")));
  }
  if (detail.available_actions.includes("approve")) {
    buttons.push(actionButton("批准", "primary", () => void decideApproval("approve")));
  }
  if (detail.available_actions.includes("cancel") && detail.task.run_id !== null) {
    buttons.push(actionButton("取消当前 Run", "danger", () => void previewRiskAction("cancel")));
  }
  if (isAbnormalTask(detail.task) && detail.task.run_id !== null) {
    buttons.push(actionButton("重新执行", "", () => void previewRiskAction("retry")));
    buttons.push(actionButton("清理残留资源", "danger", () => void previewRiskAction("cleanup")));
  }
  root.replaceChildren(...buttons);
}

function actionButton(
  label: string,
  tone: "" | "primary" | "danger",
  onClick: () => void,
): HTMLButtonElement {
  const button = element("button", `action-button${tone === "" ? "" : ` ${tone}`}`);
  button.type = "button";
  button.textContent = label;
  button.disabled = !dashboardWritesAllowed(clientState) || writePending;
  button.addEventListener("click", onClick);
  return button;
}

function renderWriteControls(): void {
  const disabled = !dashboardWritesAllowed(clientState) || writePending;
  document
    .querySelectorAll<HTMLButtonElement>("#drawer-actions button, #risk-confirm")
    .forEach((button) => {
      button.disabled = disabled;
    });
  query<HTMLTextAreaElement>("#approval-feedback").disabled = disabled;
}

async function decideApproval(decision: "approve" | "reject"): Promise<void> {
  const detail = selectedDetail;
  const approval = detail?.approval;
  if (
    detail === null ||
    approval === null ||
    approval === undefined ||
    !dashboardWritesAllowed(clientState)
  )
    return;
  const feedbackControl = query<HTMLTextAreaElement>("#approval-feedback");
  const feedback = feedbackControl.value.trim();
  const feedbackLength = Array.from(feedback).length;
  if (decision === "reject" && (feedbackLength < 1 || feedbackLength > 2_000)) {
    const error = query<HTMLElement>("#approval-feedback-error");
    error.hidden = false;
    feedbackControl.setAttribute("aria-invalid", "true");
    feedbackControl.focus();
    return;
  }
  query<HTMLElement>("#approval-feedback-error").hidden = true;
  feedbackControl.removeAttribute("aria-invalid");
  await performWrite(async () => {
    const body = {
      schema_version: 1,
      decision,
      ...(decision === "reject" ? { feedback } : {}),
    };
    const envelope = await apiRequest<unknown>(
      `/internal/v1/approvals/${encodeURIComponent(approval.approval_id)}/decision`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: writeHeaders(approval.etag),
      },
    );
    feedbackControl.value = "";
    showToast(
      decision === "approve"
        ? "审批已批准，正在刷新权威状态。"
        : "当前方案已拒绝，等待 Codex 重新规划。 ",
    );
    beginPostWriteSync(envelope.event_cursor);
  });
}

async function previewRiskAction(action: RiskAction): Promise<void> {
  const runId = selectedDetail?.task.run_id;
  if (runId === null || runId === undefined || !dashboardWritesAllowed(clientState)) return;
  try {
    const envelope = await apiRequest<ActionPreview>(
      `/internal/v1/runs/${encodeURIComponent(runId)}/actions/${action}/preview`,
      { headers: streamHeaders() },
    );
    assertEnvelopeInstance(envelope.server_instance_id);
    pendingPreview = readActionPreview(envelope.data);
    renderPreviewDialog(pendingPreview);
  } catch (error) {
    handleActionError(error);
  }
}

function renderPreviewDialog(preview: ActionPreview): void {
  const titles: Readonly<Record<RiskAction, string>> = Object.freeze({
    retry: "确认重新执行？",
    cancel: "确认取消当前 Run？",
    cleanup: "确认清理残留资源？",
  });
  setText("#risk-dialog-title", titles[preview.action]);
  query<HTMLElement>("#risk-effects").replaceChildren(...listItems(preview.effects));
  query<HTMLElement>("#risk-warnings").replaceChildren(
    ...listItems(
      preview.warnings.length === 0
        ? ["当前预览没有额外警告；仍需确认作用范围。"]
        : preview.warnings,
    ),
  );
  setText(
    "#risk-expiry",
    `预览有效期至 ${formatEventTime(preview.expires_at)}；目标变化后会立即失效。`,
  );
  query<HTMLDialogElement>("#risk-dialog").showModal();
}

async function confirmRiskAction(): Promise<void> {
  const preview = pendingPreview;
  if (preview === null || !dashboardWritesAllowed(clientState)) return;
  await performWrite(async () => {
    const envelope = await apiRequest<unknown>(
      `/internal/v1/runs/${encodeURIComponent(preview.run_id)}/actions/${preview.action}`,
      {
        method: "POST",
        body: JSON.stringify({ schema_version: 1, confirmation_token: preview.confirmation_token }),
        headers: writeHeaders(preview.etag),
      },
    );
    pendingPreview = null;
    query<HTMLDialogElement>("#risk-dialog").close();
    showToast("操作已提交，正在刷新权威状态。");
    beginPostWriteSync(envelope.event_cursor);
  });
}

async function performWrite(operation: () => Promise<void>): Promise<void> {
  if (!dashboardWritesAllowed(clientState) || writePending) return;
  writePending = true;
  renderWriteControls();
  try {
    await operation();
  } catch (error) {
    handleActionError(error);
  } finally {
    writePending = false;
    renderWriteControls();
  }
}

function beginPostWriteSync(eventCursor: string): void {
  if (clientState.server_instance_id === null) return;
  dispatch({
    type: "invalidate",
    server_instance_id: clientState.server_instance_id,
    head_cursor: eventCursor,
  });
  scheduleSync(20);
}

function writeHeaders(etag: string): Headers {
  if (csrfToken === null || clientState.stream_id === null || clientState.head_cursor === null) {
    throw new DashboardPublicError("STREAM_NOT_CURRENT", "事件流尚未追平，写操作已停止。");
  }
  const headers = streamHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Agent-Bridge-CSRF", csrfToken);
  headers.set("X-Agent-Bridge-Event-Cursor", clientState.head_cursor);
  headers.set("Idempotency-Key", window.crypto.randomUUID());
  headers.set("If-Match", etag);
  return headers;
}

function streamHeaders(): Headers {
  if (clientState.stream_id === null) {
    throw new DashboardPublicError("STREAM_NOT_CURRENT", "事件流尚未连接。");
  }
  const headers = new Headers();
  headers.set("X-Agent-Bridge-Stream-ID", clientState.stream_id);
  return headers;
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<Envelope<T>> {
  const headers = new Headers(init.headers);
  headers.set("X-Agent-Bridge-Client", "dashboard");
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  const response = await window.fetch(path, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });
  const value = await (response.json() as Promise<unknown>).catch(() => null);
  if (!response.ok) throw readPublicError(value);
  return readEnvelope<T>(value);
}

function readEnvelope<T>(value: unknown): Envelope<T> {
  const record = requireRecord(value);
  if (record.schema_version !== 1 || !("data" in record)) {
    throw new DashboardPublicError("INTERNAL_ERROR", "Bridge 返回了无法识别的响应。");
  }
  return Object.freeze({
    schema_version: 1,
    server_instance_id: requireString(record.server_instance_id),
    event_cursor: requireString(record.event_cursor),
    data: record.data as T,
  });
}

function readPublicError(value: unknown): DashboardPublicError {
  const record = isRecord(value) ? value : null;
  const error = record !== null && isRecord(record.error) ? record.error : null;
  return new DashboardPublicError(
    error === null ? "INTERNAL_ERROR" : (optionalString(error.code) ?? "INTERNAL_ERROR"),
    error === null ? "Bridge 请求失败。" : (optionalString(error.message) ?? "Bridge 请求失败。"),
  );
}

class DashboardPublicError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DashboardPublicError";
  }
}

function readReadyEvent(event: Event): {
  readonly server_instance_id: string;
  readonly stream_id: string;
  readonly head_cursor: string;
} {
  const record = readSseData(event);
  return Object.freeze({
    server_instance_id: requireString(record.server_instance_id),
    stream_id: requireString(record.stream_id),
    head_cursor: requireString(record.head_cursor),
  });
}

function readInvalidateEvent(event: Event): {
  readonly server_instance_id: string;
  readonly head_cursor: string;
} {
  const record = readSseData(event);
  const resources = record.resources;
  if (!Array.isArray(resources) || resources.some((item) => typeof item !== "string")) {
    throw new DashboardPublicError("INTERNAL_ERROR", "事件通知格式无效。");
  }
  return Object.freeze({
    server_instance_id: requireString(record.server_instance_id),
    head_cursor: requireString(record.head_cursor),
  });
}

function readResetEvent(event: Event): {
  readonly server_instance_id: string;
  readonly head_cursor: string;
} {
  const record = readSseData(event);
  return Object.freeze({
    server_instance_id: requireString(record.server_instance_id),
    head_cursor: requireString(record.head_cursor),
  });
}

function readSseData(event: Event): Record<string, unknown> {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
    throw new DashboardPublicError("INTERNAL_ERROR", "事件通知格式无效。");
  }
  let value: unknown;
  try {
    value = JSON.parse(event.data) as unknown;
  } catch {
    throw new DashboardPublicError("INTERNAL_ERROR", "事件通知格式无效。");
  }
  const record = requireRecord(value);
  if (record.schema_version !== 1)
    throw new DashboardPublicError("INTERNAL_ERROR", "事件通知版本无效。");
  return record;
}

function readDashboardData(value: unknown): DashboardData {
  const record = requireRecord(value);
  requireRecord(record.range);
  requireRecord(record.counts);
  requireRecord(record.duration);
  requireRecord(record.usage);
  requireRecord(record.lanes);
  return value as DashboardData;
}

function readTaskPage(value: unknown): {
  readonly items: readonly DashboardTaskCard[];
  readonly next_cursor: string | null;
} {
  const record = requireRecord(value);
  if (!Array.isArray(record.items))
    throw new DashboardPublicError("INTERNAL_ERROR", "任务列表格式无效。");
  return Object.freeze({
    items: Object.freeze(record.items.map(readTaskCard)),
    next_cursor: record.next_cursor === null ? null : requireString(record.next_cursor),
  });
}

function readTaskCard(value: unknown): DashboardTaskCard {
  const record = requireRecord(value);
  const stage = requireString(record.display_stage);
  if (!stageOrder.includes(stage as DisplayStage))
    throw new DashboardPublicError("INTERNAL_ERROR", "任务阶段无效。");
  const latest = record.latest_event === null ? null : requireRecord(record.latest_event);
  return Object.freeze({
    task_id: requireString(record.task_id),
    run_id: record.run_id === null ? null : requireString(record.run_id),
    title: requireString(record.title),
    authoritative_status: requireString(record.authoritative_status),
    display_stage: stage as DisplayStage,
    current_step: requireString(record.current_step),
    wait_reason: record.wait_reason === null ? null : requireString(record.wait_reason),
    elapsed_ms: record.elapsed_ms === null ? null : requireNonNegativeNumber(record.elapsed_ms),
    latest_event:
      latest === null
        ? null
        : Object.freeze({
            kind: "safe_summary",
            message: requireString(latest.message),
            occurred_at: requireString(latest.occurred_at),
          }),
    revision: requirePositiveInteger(record.revision),
    etag: requireString(record.etag),
  });
}

function readTaskDetail(value: unknown): TaskDetail {
  const record = requireRecord(value);
  const result = requireRecord(record.result);
  const usage = requireRecord(result.usage);
  const approvalRecord = record.approval === null ? null : requireRecord(record.approval);
  if (!Array.isArray(record.available_actions))
    throw new DashboardPublicError("INTERNAL_ERROR", "任务操作格式无效。");
  const availableActions = record.available_actions.map((item) => requireString(item));
  if (availableActions.some((item) => !["approve", "reject", "cancel"].includes(item))) {
    throw new DashboardPublicError("INTERNAL_ERROR", "任务操作格式无效。");
  }
  return Object.freeze({
    task: readTaskCard(record.task),
    task_version_id: requireString(record.task_version_id),
    approval:
      approvalRecord === null
        ? null
        : Object.freeze({
            approval_id: requireString(approvalRecord.approval_id),
            status: requireString(approvalRecord.status),
            summary: requireString(approvalRecord.summary),
            feedback_required_on_reject: true,
            etag: requireString(approvalRecord.etag),
          }),
    result: Object.freeze({
      outcome: result.outcome === null ? null : requireString(result.outcome),
      verification_summary:
        result.verification_summary === null
          ? null
          : (requireString(result.verification_summary) as "passed" | "failed" | "not_run"),
      usage: Object.freeze({
        status: requireString(usage.status) as "reported" | "unreported",
        input_units: nullableNumber(usage.input_units),
        output_units: nullableNumber(usage.output_units),
        cache_read_units: nullableNumber(usage.cache_read_units),
        cache_write_units: nullableNumber(usage.cache_write_units),
        total_units: nullableNumber(usage.total_units),
      }),
    }),
    available_actions: Object.freeze(availableActions as ("approve" | "reject" | "cancel")[]),
  });
}

function readActionPreview(value: unknown): ActionPreview {
  const record = requireRecord(value);
  const action = requireString(record.action);
  if (!isRiskAction(action) || !Array.isArray(record.effects) || !Array.isArray(record.warnings)) {
    throw new DashboardPublicError("INTERNAL_ERROR", "操作预览格式无效。");
  }
  return Object.freeze({
    action,
    run_id: requireString(record.run_id),
    target_revision: requirePositiveInteger(record.target_revision),
    etag: requireString(record.etag),
    effects: Object.freeze(record.effects.map(requireString)),
    warnings: Object.freeze(record.warnings.map(requireString)),
    confirmation_token: requireString(record.confirmation_token),
    expires_at: requireString(record.expires_at),
    event_cursor: requireString(record.event_cursor),
  });
}

function bindStaticEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.range;
      if (value !== "session" && value !== "today" && value !== "7d") return;
      activeRange = value;
      dispatch({ type: "begin_sync" });
      renderOverview();
      scheduleSync(0);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () =>
      switchView(button.dataset.viewTarget === "history" ? "history" : "board"),
    );
  });
  query<HTMLButtonElement>("#state-retry").addEventListener("click", () => {
    if (clientState.stream_id === null && clientState.head_cursor !== null)
      openEventStream(clientState.head_cursor);
    else {
      dispatch({ type: "begin_sync" });
      scheduleSync(0);
    }
  });
  query<HTMLButtonElement>("#close-drawer").addEventListener("click", closeDrawer);
  query<HTMLButtonElement>("#risk-confirm").addEventListener(
    "click",
    () => void confirmRiskAction(),
  );
  query<HTMLDialogElement>("#risk-dialog").addEventListener("close", () => {
    pendingPreview = null;
  });
  query<HTMLTextAreaElement>("#approval-feedback").addEventListener("input", () => {
    query<HTMLElement>("#approval-feedback-error").hidden = true;
    query<HTMLTextAreaElement>("#approval-feedback").removeAttribute("aria-invalid");
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      clientState.selected_task_id !== null &&
      !query<HTMLDialogElement>("#risk-dialog").open
    )
      closeDrawer();
  });
}

function switchView(view: "board" | "history"): void {
  query<HTMLElement>(".app-shell").dataset.view = view;
  query<HTMLElement>("#board-view").hidden = view !== "board";
  query<HTMLElement>("#history-view").hidden = view !== "history";
  setText("#page-title", view === "board" ? "运行与处置" : "全部任务");
  setText(
    "#page-note",
    view === "board"
      ? "先看总体负载，再处理需要人的事项。这里不创建任务，也不估算完成百分比。"
      : "历史列表只展示权威任务投影；任务设计、合同编辑与下发仍由 Codex/MCP 完成。",
  );
  document.querySelectorAll<HTMLButtonElement>("[data-view-target]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.viewTarget === view);
  });
}

function handleActionError(error: unknown): void {
  showToast(publicErrorMessage(error));
  const code = publicErrorCode(error);
  if (
    ["STALE_EVENT_CURSOR", "ETAG_MISMATCH", "CONFIRMATION_EXPIRED", "STREAM_NOT_CURRENT"].includes(
      code,
    )
  ) {
    dispatch({ type: "begin_sync" });
    scheduleSync(0);
  }
  if (code === "SESSION_EXPIRED") handleFatalSessionError(error);
}

function handleFatalSessionError(error: unknown): void {
  csrfToken = null;
  pendingPreview = null;
  eventSource?.close();
  eventSource = null;
  dispatch({ type: "fatal" });
  renderBoardState("本地会话已失效", publicErrorMessage(error));
}

function handleInstanceChange(): void {
  csrfToken = null;
  pendingPreview = null;
  eventSource?.close();
  eventSource = null;
  renderBoardState("Bridge 实例已变化", "旧页面已进入只读；请重新打开管理页建立新会话。");
}

function assertEnvelopeInstance(instanceId: string): void {
  if (clientState.server_instance_id !== instanceId) {
    dispatch({ type: "fatal" });
    handleInstanceChange();
    throw new DashboardPublicError("SESSION_EXPIRED", "Bridge 实例已变化，请重新打开管理页。");
  }
}

function showToast(message: string): void {
  const toast = query<HTMLElement>("#toast");
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2_600);
}

function factNodes(facts: readonly (readonly [string, string])[]): Node[] {
  return facts.flatMap(([label, value]) => [
    textElement("dt", "", label),
    textElement("dd", "", value),
  ]);
}

function listItems(items: readonly string[]): HTMLLIElement[] {
  return items.map((item) => textElement("li", "", item));
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  return node;
}

function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const node = element(tag, className);
  node.textContent = text;
  return node;
}

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error(`Dashboard element missing: ${selector}`);
  return node;
}

function setText(selector: string, value: string): void {
  query<HTMLElement>(selector).textContent = value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new DashboardPublicError("INTERNAL_ERROR", "Bridge 返回了无法识别的数据。");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown): string {
  if (typeof value !== "string")
    throw new DashboardPublicError("INTERNAL_ERROR", "Bridge 返回了无法识别的数据。");
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new DashboardPublicError("INTERNAL_ERROR", "Bridge 返回了无法识别的数据。");
  }
  return value;
}

function requirePositiveInteger(value: unknown): number {
  const number = requireNonNegativeNumber(value);
  if (!Number.isInteger(number) || number < 1)
    throw new DashboardPublicError("INTERNAL_ERROR", "Bridge 返回了无法识别的数据。");
  return number;
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : requireNonNegativeNumber(value);
}

function isRiskAction(value: string): value is RiskAction {
  return value === "retry" || value === "cancel" || value === "cleanup";
}

function isAbnormalTask(task: DashboardTaskCard): boolean {
  return ["INTERRUPTED", "FAILED", "CHANGES_REQUESTED"].includes(task.authoritative_status);
}

function toneClass(task: DashboardTaskCard): string {
  if (task.authoritative_status === "WAITING_APPROVAL") return "tone-approval";
  if (isAbnormalTask(task)) return "tone-anomaly";
  return "tone-running";
}

function laneEmptyMessage(lane: "running" | "approval" | "anomaly"): string {
  if (lane === "running") return "当前没有运行中的任务";
  if (lane === "approval") return "当前没有待审批事项";
  return "当前没有异常事项";
}

function formatElapsed(value: number | null): string {
  if (value === null) return "未知";
  if (value < 60_000) return `${Math.max(1, Math.floor(value / 1_000))}s`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}m`;
  return `${formatDecimal(value / 3_600_000)}h`;
}

function formatDecimal(value: number): string {
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/u, "");
}

function formatBasisPoints(value: number): string {
  return `${formatDecimal(value / 100)}%`;
}

function formatEventTime(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? "未知时间"
    : new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(time);
}

function verificationLabel(value: TaskDetail["result"]["verification_summary"]): string {
  if (value === "passed") return "通过";
  if (value === "failed") return "失败";
  if (value === "not_run") return "未运行";
  return "尚未形成";
}

function publicErrorCode(error: unknown): string {
  return error instanceof DashboardPublicError ? error.code : "INTERNAL_ERROR";
}

function publicErrorMessage(error: unknown): string {
  return error instanceof DashboardPublicError ? error.message : "Bridge 请求失败，请稍后重试。";
}

if (typeof document !== "undefined") void startDashboard();
