/* global document, window */

const shell = document.querySelector(".prototype-shell");
const drawer = document.querySelector(".detail-drawer");
const tweaksTrigger = document.querySelector("#tweaks-trigger");
const tweaksPanel = document.querySelector("#tweaks-panel");
const densityToggle = document.querySelector("#density-toggle");
const tokenMissingToggle = document.querySelector("#token-missing-toggle");
const demoStateSelect = document.querySelector("#demo-state");
const toast = document.querySelector("#toast");
const riskDialog = document.querySelector("#risk-dialog");

let toastTimer;
let busyTimer;
let pendingRisk = null;

const prototypeState = {
  activeRange: "today",
  approvalDecision: null,
  anomalyResolution: null,
  cancelledItems: new Set(),
  selectedItem: null,
  demoState: "normal",
};

const rangeData = {
  session: {
    title: "本次会话运行摘要",
    total: 4,
    completed: 0,
    running: 2,
    durations: [1, 2, 1, 0],
    token: {
      total: "35.2k",
      input: "23.4k",
      output: "8.7k",
      cached: "3.1k",
      widths: [66, 25, 9],
      reported: "4 / 4 个任务已上报",
      note: "本次会话中的任务均包含 usage 事件。",
      status: "完整上报",
    },
  },
  today: {
    title: "今日运行摘要",
    total: 12,
    completed: 8,
    running: 2,
    durations: [4, 5, 2, 1],
    token: {
      total: "148.6k",
      input: "104k",
      output: "31k",
      cached: "13.6k",
      widths: [70, 21, 9],
      reported: "10 / 12 个任务已上报",
      note: "2 个任务没有 usage 事件，因此未计入总数。",
      status: "部分上报",
    },
  },
  week: {
    title: "最近 7 天运行摘要",
    total: 47,
    completed: 43,
    running: 2,
    durations: [16, 18, 9, 4],
    token: {
      total: "842k",
      input: "593k",
      output: "161k",
      cached: "88k",
      widths: [70, 19, 11],
      reported: "44 / 47 个任务已上报",
      note: "3 个历史任务没有 usage 事件，因此未计入总数。",
      status: "部分上报",
    },
  },
};

const detailData = {
  approval: {
    tone: "等待批准",
    toneClass: "tone-approval",
    title: "执行独立验证命令",
    context: "Agent 已完成当前修改，准备在隔离环境中执行只读验证命令。",
    impact: "不会修改工作区；预计运行约 2 分钟，可能产生本地测试缓存。",
    advice: "确认命令与范围后批准；若范围不符，可拒绝并返回修改意见。",
    event: "17:44 · approval.requested · 等待用户决定",
    actionKind: "approval",
    actionNote: "审批决定将写入审计并送达当前 Worker。",
  },
  anomaly: {
    tone: "范围冲突",
    toneClass: "tone-anomaly",
    title: "Worktree 范围冲突",
    context: "任务尝试访问当前 TaskContract 未声明的 worktree 路径。",
    impact: "Bridge 已拒绝越界操作，任务保持中断状态，没有文件被修改。",
    advice: "先确认任务边界；如确需扩展范围，应返回 Codex 更新任务合同后重新执行。",
    event: "17:41 · SESSION_SCOPE_CONFLICT · 已拒绝越界请求",
    actionKind: "anomaly",
    actionNote: "重新执行或清理资源都需要二次确认。",
  },
  "running-primary": {
    tone: "Agent 执行",
    toneClass: "tone-running",
    title: "统一 Driver 错误映射",
    context: "OpenCode Driver 正在把运行时错误转换为 Bridge 的公开错误语义。",
    impact: "当前仍在隔离 worktree 内工作；尚未进入独立验证和 Review。",
    advice: "继续观察最近事件；如果长时间无新事件，再检查 Worker 与 Driver 状态。",
    event: "17:42 · worker.event.persisted · 状态事件已写入",
    actionKind: "running",
    actionNote: "取消当前 Run 会进入二次确认，不会自动清理 worktree。",
  },
  "running-secondary": {
    tone: "独立验证",
    toneClass: "tone-running",
    title: "补充 stdio Contract 覆盖",
    context: "实现已完成，正在独立环境中验证 Driver Protocol 的边界行为。",
    impact: "验证不会访问真实 Provider，也不会修改现有 Agent 配置。",
    advice: "等待 Contract 测试结果；失败时查看第一个不一致事件。",
    event: "17:39 · verification.started · 环境准备完成",
    actionKind: "running",
    actionNote: "取消当前 Run 会进入二次确认，不会自动清理 worktree。",
  },
  "approval-resumed": {
    tone: "审批决定已处理",
    toneClass: "tone-running",
    title: "处理审批结果",
    context: "审批决定已记录，任务已离开等待审批状态。",
    impact: "后续行为取决于批准或拒绝决定；演示数据不会执行真实命令。",
    advice: "观察最近事件，确认任务进入正确的后续路径。",
    event: "17:46 · approval.decision_recorded · 决定已记录",
    actionKind: "running",
    actionNote: "取消恢复后的任务仍需要二次确认。",
  },
  "anomaly-resumed": {
    tone: "准备上下文",
    toneClass: "tone-running",
    title: "Worktree 范围冲突",
    context: "用户已显式确认重新执行；系统正在准备新的 Run。",
    impact: "旧 Run、事件和失败证据继续保留；新 Run 尚未调用 Provider。",
    advice: "确认 TaskContract 范围已更新，再观察新 Run 是否启动。",
    event: "17:48 · retry.requested · 新 Run 等待启动",
    actionKind: "running",
    actionNote: "取消新 Run 仍需要二次确认。",
  },
};

const riskContent = {
  retry: {
    title: "确认重新执行异常任务？",
    scope: "基于当前 TaskContract 创建新的 Run；旧 Run、失败事件和审计事实继续保留。",
    impact: "可能再次调用 Provider 并产生 Token 消耗。如果范围冲突尚未修复，新 Run 仍会失败。",
    confirm: "确认重新执行",
  },
  cancel: {
    title: "确认取消当前任务？",
    scope: "向当前 Run 发送取消请求；已写入 worktree 的文件和既有审计事件继续保留。",
    impact: "取消可能需要等待 Driver 确认。原型不会终止真实进程，也不会自动清理临时资源。",
    confirm: "确认取消",
  },
  cleanup: {
    title: "确认清理残留资源？",
    scope: "清理已确认属于当前 Run 的临时目录和残留子进程；任务记录与审计事件继续保留。",
    impact: "清理不可撤销，必须先确认没有仍在运行的合法进程。原型不会删除任何真实文件。",
    confirm: "确认清理",
  },
};

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(function () {
    toast.classList.remove("is-visible");
  }, 2200);
}

function activeApprovalCount() {
  return prototypeState.approvalDecision === null ? 1 : 0;
}

function activeAnomalyCount() {
  return prototypeState.anomalyResolution === null ? 1 : 0;
}

function visibleRunningItems() {
  const ids = ["running-primary", "running-secondary"];
  if (prototypeState.approvalDecision !== null) ids.push("approval-resumed");
  if (prototypeState.anomalyResolution === "retry") ids.push("anomaly-resumed");
  return ids.filter(function (id) {
    return !prototypeState.cancelledItems.has(id);
  });
}

function setHidden(selector, hidden) {
  document.querySelector(selector).hidden = hidden;
}

function renderToken(data) {
  const missing = tokenMissingToggle.checked;
  const tokenCard = document.querySelector("#token-card");
  tokenCard.classList.toggle("is-missing", missing);
  document.querySelector("#metric-token").textContent = missing ? "—" : data.total;
  document.querySelector("#metric-token-foot").textContent = missing ? "未上报" : data.reported;
  document.querySelector("#token-chart-total").textContent = missing ? "—" : data.total;
  document.querySelector("#token-reporting").textContent = missing ? "未上报" : data.status;
  document.querySelector("#token-input").textContent = missing ? "—" : data.input;
  document.querySelector("#token-output").textContent = missing ? "—" : data.output;
  document.querySelector("#token-cached").textContent = missing ? "—" : data.cached;
  document.querySelector("#token-note").textContent = missing
    ? "Driver 未提供 usage 事件；缺失数据不会按 0 计算。"
    : data.note;

  ["input", "output", "cached"].forEach(function (key, index) {
    document.querySelector("#token-stack .token-" + key).style.width = missing
      ? "0%"
      : data.widths[index] + "%";
  });
  document
    .querySelector("#token-stack")
    .setAttribute(
      "aria-label",
      missing
        ? "Token 数据未上报"
        : "Token 构成：输入 " + data.input + "，输出 " + data.output + "，缓存 " + data.cached,
    );
}

function renderMetrics() {
  const data = rangeData[prototypeState.activeRange];
  const empty = prototypeState.demoState === "empty";
  const approval = empty ? 0 : activeApprovalCount();
  const anomaly = empty ? 0 : activeAnomalyCount();
  const running = empty ? 0 : visibleRunningItems().length;

  document.querySelector("#overview-title").textContent = data.title;
  document.querySelector("#metric-total").textContent = data.total;
  document.querySelector("#metric-total-foot").textContent = "已完成 " + data.completed;
  document.querySelector("#metric-running").textContent = running;
  document.querySelector("#metric-attention").textContent = approval + anomaly;
  document.querySelector("#metric-attention-foot").textContent =
    "待审批 " + approval + " · 异常 " + anomaly;
  document.querySelector("#duration-unit").textContent = data.total + " 个任务";

  document.querySelectorAll("[data-range]").forEach(function (button) {
    const active = button.dataset.range === prototypeState.activeRange;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  document.querySelectorAll("[data-duration]").forEach(function (row, index) {
    const count = data.durations[index];
    const percentage = data.total === 0 ? 0 : Math.round((count / data.total) * 100);
    row.querySelector(".bar-fill").style.width = percentage + "%";
    row.querySelector(".duration-value").textContent = count + " · " + percentage + "%";
  });

  renderToken(data.token);
}

function renderBoard() {
  const empty = prototypeState.demoState === "empty";
  const approval = empty ? 0 : activeApprovalCount();
  const anomaly = empty ? 0 : activeAnomalyCount();
  const runningIds = empty ? [] : visibleRunningItems();

  ["running-primary", "running-secondary", "approval-resumed", "anomaly-resumed"].forEach(
    function (id) {
      const element =
        id === "approval-resumed"
          ? document.querySelector("#approval-resumed-card")
          : id === "anomaly-resumed"
            ? document.querySelector("#anomaly-resumed-card")
            : document.querySelector('[data-item="' + id + '"]');
      element.hidden = !runningIds.includes(id);
    },
  );

  setHidden("#approval-card", approval === 0);
  setHidden("#approval-empty", approval !== 0);
  setHidden("#anomaly-card", anomaly === 0);
  setHidden("#anomaly-empty", anomaly !== 0);
  setHidden("#running-empty", runningIds.length !== 0);

  document.querySelector("#running-count").textContent = String(runningIds.length).padStart(2, "0");
  document.querySelector("#approval-count").textContent = String(approval).padStart(2, "0");
  document.querySelector("#anomaly-count").textContent = String(anomaly).padStart(2, "0");
  document.querySelector("#attention-summary").textContent =
    approval + anomaly === 0 ? "当前无待处理事项" : approval + anomaly + " 项需要人工处理";

  renderMetrics();
}

function closeDrawer() {
  shell.classList.remove("has-drawer");
  drawer.inert = true;
  drawer.setAttribute("aria-hidden", "true");
  prototypeState.selectedItem = null;
  document.querySelectorAll("[data-item]").forEach(function (button) {
    button.classList.remove("is-selected");
  });
}

function selectItem(itemId) {
  const data = detailData[itemId];
  if (!data || document.querySelector('[data-item="' + itemId + '"]').hidden) return;
  prototypeState.selectedItem = itemId;

  document.querySelectorAll("[data-item]").forEach(function (button) {
    button.classList.toggle("is-selected", button.dataset.item === itemId);
  });

  const tone = document.querySelector("#drawer-tone");
  tone.className = "tone-label " + data.toneClass;
  tone.textContent = data.tone;
  document.querySelector("#drawer-title").textContent = data.title;
  document.querySelector("#drawer-context").textContent = data.context;
  document.querySelector("#drawer-impact").textContent = data.impact;
  document.querySelector("#drawer-advice").textContent = data.advice;
  document.querySelector("#drawer-event").textContent = data.event;
  document.querySelector("#drawer-action-note").textContent = data.actionNote;

  setHidden("#approval-actions", data.actionKind !== "approval");
  setHidden("#running-actions", data.actionKind !== "running");
  setHidden("#anomaly-actions", data.actionKind !== "anomaly");

  document
    .querySelectorAll(".drawer-actions button, .drawer-actions textarea")
    .forEach(function (control) {
      control.disabled = prototypeState.demoState === "reconnecting";
    });

  drawer.inert = false;
  drawer.setAttribute("aria-hidden", "false");
  shell.classList.add("has-drawer");
}

function setBusy(button, label) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return function () {
    button.disabled = false;
    button.textContent = original;
  };
}

function completeApproval(decision, button) {
  const reason = document.querySelector("#approval-reason");
  const error = document.querySelector("#approval-reason-error");
  if (decision === "reject" && reason.value.trim() === "") {
    error.hidden = false;
    reason.setAttribute("aria-invalid", "true");
    reason.focus();
    return;
  }
  error.hidden = true;
  reason.removeAttribute("aria-invalid");

  const restore = setBusy(button, "正在提交…");
  document.querySelectorAll("[data-approval-action]").forEach(function (item) {
    item.disabled = true;
  });
  window.clearTimeout(busyTimer);
  busyTimer = window.setTimeout(function () {
    prototypeState.approvalDecision = decision;
    const resumed = detailData["approval-resumed"];
    const approved = decision === "approve";
    resumed.tone = approved ? "审批已通过" : "重新规划";
    resumed.title = approved ? "执行独立验证命令" : "根据拒绝反馈重新规划";
    resumed.context = approved
      ? "批准决定已记录，Worker 已从等待状态恢复。"
      : "当前方案已被阻止，拒绝反馈已记录，任务正在返回 Codex 重新规划。";
    resumed.impact = approved
      ? "任务继续使用同一 Run 和 Session；演示数据不会执行真实命令。"
      : "拒绝不会取消整个任务，但原方案或实质等价动作不得继续执行。";
    resumed.advice = approved
      ? "观察最近事件，确认验证命令开始执行。"
      : "根据反馈设计其他路径；新路径超出 TaskContract、权限或再次触发高风险动作时重新审批。";
    resumed.event = approved
      ? "17:46 · approval.approved · Worker 已恢复"
      : "17:46 · approval.rejected · 已返回重新规划";
    resumed.actionNote = approved
      ? "取消恢复后的任务仍需要二次确认。"
      : "重新规划期间不得绕过拒绝继续等价动作。";
    document.querySelector("#approval-resumed-card .task-title").textContent = resumed.title;
    document.querySelector("#approval-resumed-meta").textContent = approved
      ? "独立验证 · 审批已通过"
      : "重新规划 · 已收到拒绝反馈";
    document.querySelector("#approval-resumed-event").textContent = approved
      ? "最近：批准决定已送达 Worker"
      : "最近：当前方案已拒绝，反馈已记录";
    document.querySelector("#approval-resumed-wait").textContent = approved
      ? "等待原因：无"
      : "等待原因：Codex 正在重新规划";
    restore();
    reason.value = "";
    closeDrawer();
    renderBoard();
    showToast(approved ? "已批准；任务恢复运行" : "已拒绝；任务返回重新规划");
  }, 520);
}

function openRiskDialog(action) {
  const content = riskContent[action];
  if (!content || prototypeState.demoState === "reconnecting") return;
  pendingRisk = { action: action, itemId: prototypeState.selectedItem };
  document.querySelector("#risk-dialog-title").textContent = content.title;
  document.querySelector("#risk-dialog-scope").textContent = content.scope;
  document.querySelector("#risk-dialog-impact").textContent = content.impact;
  document.querySelector("#risk-confirm").textContent = content.confirm;
  riskDialog.showModal();
}

function applyRiskAction() {
  if (pendingRisk === null) return;
  const action = pendingRisk.action;
  const itemId = pendingRisk.itemId;
  const button = document.querySelector("#risk-confirm");
  const restore = setBusy(button, "正在确认…");

  window.clearTimeout(busyTimer);
  busyTimer = window.setTimeout(function () {
    if (action === "retry") {
      prototypeState.anomalyResolution = "retry";
    } else if (action === "cleanup") {
      prototypeState.anomalyResolution = "cleanup";
    } else if (action === "cancel" && itemId !== null) {
      prototypeState.cancelledItems.add(itemId);
    }

    restore();
    riskDialog.close();
    pendingRisk = null;
    closeDrawer();
    renderBoard();

    const message =
      action === "retry"
        ? "已记录重新执行请求；新 Run 等待启动"
        : action === "cleanup"
          ? "已完成原型清理；真实文件未被修改"
          : "已记录取消请求；等待 Driver 确认";
    showToast(message);
  }, 620);
}

function renderDemoState() {
  const value = prototypeState.demoState;
  const panel = document.querySelector("#board-state-panel");
  const grid = document.querySelector("#board-grid");
  const banner = document.querySelector("#runtime-banner");
  const retry = document.querySelector("#state-retry");
  const connection = document.querySelector("#connection-status");
  const connectionText = document.querySelector("#connection-text");

  shell.dataset.runtimeState = value;
  panel.hidden = !["loading", "empty", "error"].includes(value);
  grid.hidden = ["loading", "empty", "error"].includes(value);
  banner.hidden = value !== "reconnecting";
  retry.hidden = value !== "error";

  connection.classList.toggle("is-reconnecting", value === "reconnecting");
  connection.classList.toggle("is-error", value === "error");
  connectionText.textContent =
    value === "reconnecting"
      ? "Bridge 正在重连"
      : value === "error"
        ? "Bridge 连接失败"
        : "Bridge 已连接";

  if (value === "loading") {
    document.querySelector("#board-state-title").textContent = "正在读取权威状态";
    document.querySelector("#board-state-detail").textContent =
      "正在从 Bridge 应用服务恢复任务、审批和事件。";
  } else if (value === "empty") {
    document.querySelector("#board-state-title").textContent = "当前没有活动任务";
    document.querySelector("#board-state-detail").textContent =
      "没有运行中、待审批或异常事项；历史任务仍可在独立列表中查看。";
  } else if (value === "error") {
    document.querySelector("#board-state-title").textContent = "无法读取 Bridge 状态";
    document.querySelector("#board-state-detail").textContent =
      "保留最后一次成功读取的数据；重新连接不会自动重跑任务。";
  }

  if (value === "reconnecting") {
    document.querySelector("#runtime-banner-title").textContent = "正在恢复实时连接";
    document.querySelector("#runtime-banner-detail").textContent =
      "当前展示最后一次权威状态；恢复后将从事件游标继续，写操作暂不可用。";
  }

  if (value !== "normal") closeDrawer();
  renderBoard();
}

document.querySelectorAll("[data-range]").forEach(function (button) {
  button.addEventListener("click", function () {
    prototypeState.activeRange = button.dataset.range;
    renderMetrics();
  });
});

document.querySelectorAll("[data-item]").forEach(function (button) {
  button.addEventListener("click", function () {
    selectItem(button.dataset.item);
  });
});

document.querySelectorAll("[data-approval-action]").forEach(function (button) {
  button.addEventListener("click", function () {
    completeApproval(button.dataset.approvalAction, button);
  });
});

document.querySelectorAll("[data-risk-action]").forEach(function (button) {
  button.addEventListener("click", function () {
    openRiskDialog(button.dataset.riskAction);
  });
});

document.querySelector("#risk-confirm").addEventListener("click", applyRiskAction);
document.querySelector("#close-drawer").addEventListener("click", closeDrawer);

document.querySelector("#approval-reason").addEventListener("input", function (event) {
  if (event.currentTarget.value.trim() !== "") {
    document.querySelector("#approval-reason-error").hidden = true;
    event.currentTarget.removeAttribute("aria-invalid");
  }
});

tweaksTrigger.addEventListener("click", function () {
  const willOpen = !tweaksPanel.classList.contains("is-open");
  tweaksPanel.classList.toggle("is-open", willOpen);
  tweaksTrigger.setAttribute("aria-expanded", String(willOpen));
});

densityToggle.addEventListener("change", function () {
  shell.dataset.density = densityToggle.checked ? "compact" : "comfortable";
  window.localStorage.setItem("agentBridgePrototypeDensity", shell.dataset.density);
});

tokenMissingToggle.addEventListener("change", function () {
  renderToken(rangeData[prototypeState.activeRange].token);
});

demoStateSelect.addEventListener("change", function () {
  prototypeState.demoState = demoStateSelect.value;
  renderDemoState();
});

document.querySelector("#state-retry").addEventListener("click", function () {
  demoStateSelect.value = "reconnecting";
  prototypeState.demoState = "reconnecting";
  renderDemoState();
});

document.querySelector("#reset-demo").addEventListener("click", function () {
  prototypeState.activeRange = "today";
  prototypeState.approvalDecision = null;
  prototypeState.anomalyResolution = null;
  prototypeState.cancelledItems.clear();
  prototypeState.demoState = "normal";
  pendingRisk = null;
  tokenMissingToggle.checked = false;
  demoStateSelect.value = "normal";
  densityToggle.checked = false;
  shell.dataset.density = "comfortable";
  window.localStorage.removeItem("agentBridgePrototypeDensity");
  document.querySelector("#approval-reason").value = "";
  closeDrawer();
  renderDemoState();
  showToast("演示状态已重置");
});

document.querySelector("[data-placeholder='history']").addEventListener("click", function () {
  showToast("全部任务页不在本轮首页原型范围内");
});

riskDialog.addEventListener("close", function () {
  pendingRisk = null;
});

const savedDensity = window.localStorage.getItem("agentBridgePrototypeDensity");
if (savedDensity === "compact") {
  densityToggle.checked = true;
  shell.dataset.density = "compact";
}

renderDemoState();
