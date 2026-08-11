/* global document, window */

const shell = document.querySelector(".prototype-shell");
const tweaksTrigger = document.querySelector("#tweaks-trigger");
const tweaksPanel = document.querySelector("#tweaks-panel");
const densityToggle = document.querySelector("#density-toggle");
const toast = document.querySelector("#toast");
const tokenMissingToggle = document.querySelector("#token-missing-toggle");
let toastTimer;
const rangeData = {
  session: {
    title: "本次会话运行摘要",
    total: 4,
    completed: 0,
    running: 2,
    attention: 2,
    approval: 1,
    anomaly: 1,
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
    attention: 2,
    approval: 1,
    anomaly: 1,
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
    attention: 2,
    approval: 1,
    anomaly: 1,
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

let activeRange = "today";

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

  ["input", "output", "cached"].forEach((key, index) => {
    document.querySelector(`#token-stack .token-${key}`).style.width = missing
      ? "0%"
      : `${data.widths[index]}%`;
  });
  document
    .querySelector("#token-stack")
    .setAttribute(
      "aria-label",
      missing
        ? "Token 数据未上报"
        : `Token 构成：输入 ${data.input}，输出 ${data.output}，缓存 ${data.cached}`,
    );
}

function setRange(range) {
  const data = rangeData[range];
  if (!data) return;
  activeRange = range;

  document.querySelector("#overview-title").textContent = data.title;
  document.querySelector("#metric-total").textContent = data.total;
  document.querySelector("#metric-total-foot").textContent = `已完成 ${data.completed}`;
  document.querySelector("#metric-running").textContent = data.running;
  document.querySelector("#metric-attention").textContent = data.attention;
  document.querySelector("#metric-attention-foot").textContent =
    `待审批 ${data.approval} · 异常 ${data.anomaly}`;
  document.querySelector("#duration-unit").textContent = `${data.total} 个任务`;

  document.querySelectorAll("[data-range]").forEach((button) => {
    const active = button.dataset.range === range;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  document.querySelectorAll("[data-duration]").forEach((row, index) => {
    const count = data.durations[index];
    const percentage = data.total === 0 ? 0 : Math.round((count / data.total) * 100);
    row.querySelector(".bar-fill").style.width = `${percentage}%`;
    row.querySelector(".duration-value").textContent = `${count} · ${percentage}%`;
  });

  renderToken(data.token);
}

document.querySelectorAll("[data-range]").forEach((button) => {
  button.addEventListener("click", () => setRange(button.dataset.range));
});

tokenMissingToggle.addEventListener("change", () => {
  renderToken(rangeData[activeRange].token);
});
const detailData = {
  approval: {
    tone: "等待批准",
    toneClass: "tone-approval",
    title: "执行独立验证命令",
    context: "Agent 已完成当前修改，准备在隔离环境中执行只读验证命令。",
    impact: "不会修改工作区；预计运行约 2 分钟，可能产生本地测试缓存。",
    advice: "确认命令与范围后批准；若范围不符，可拒绝并返回修改意见。",
    event: "17:44 · approval.requested · 等待用户决定",
    actionNote: "高风险操作将在完整原型中通过二次确认完成",
  },
  anomaly: {
    tone: "范围冲突",
    toneClass: "tone-anomaly",
    title: "Worktree 范围冲突",
    context: "任务尝试访问当前 TaskContract 未声明的 worktree 路径。",
    impact: "Bridge 已拒绝越界操作，任务保持中断状态，没有文件被修改。",
    advice: "先确认任务边界；如确需扩展范围，应返回 Codex 更新任务合同后重新执行。",
    event: "17:41 · SESSION_SCOPE_CONFLICT · 已拒绝越界请求",
    actionNote: "重试、取消或清理将在完整原型中通过二次确认完成",
  },
  "running-primary": {
    tone: "Agent 执行",
    toneClass: "tone-running",
    title: "统一 Driver 错误映射",
    context: "OpenCode Driver 正在把运行时错误转换为 Bridge 的公开错误语义。",
    impact: "当前仍在隔离 worktree 内工作；尚未进入独立验证和 Review。",
    advice: "继续观察最近事件；如果长时间无新事件，再检查 Worker 与 Driver 状态。",
    event: "17:42 · worker.event.persisted · 状态事件已写入",
    actionNote: "运行中任务在本轮仅供观察；取消操作将在完整原型中补齐",
  },
  "running-secondary": {
    tone: "独立验证",
    toneClass: "tone-running",
    title: "补充 stdio Contract 覆盖",
    context: "实现已完成，正在独立环境中验证 Driver Protocol 的边界行为。",
    impact: "验证不会访问真实 Provider，也不会修改现有 Agent 配置。",
    advice: "等待 Contract 测试结果；失败时查看第一个不一致事件。",
    event: "17:39 · verification.started · 环境准备完成",
    actionNote: "运行中任务在本轮仅供观察；取消操作将在完整原型中补齐",
  },
};

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 1800);
}

function selectItem(itemId) {
  const data = detailData[itemId];
  if (!data) return;
  const drawer = document.querySelector(".detail-drawer");

  document.querySelectorAll("[data-item]").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.item === itemId);
  });

  const tone = document.querySelector("#drawer-tone");
  tone.className = `tone-label ${data.toneClass}`;
  tone.textContent = data.tone;
  document.querySelector("#drawer-title").textContent = data.title;
  document.querySelector("#drawer-context").textContent = data.context;
  document.querySelector("#drawer-impact").textContent = data.impact;
  document.querySelector("#drawer-advice").textContent = data.advice;
  document.querySelector("#drawer-event").textContent = data.event;
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.hidden = itemId !== "approval";
  });
  document.querySelector(".danger-placeholder").textContent = data.actionNote;
  drawer.inert = false;
  drawer.setAttribute("aria-hidden", "false");
  shell.classList.add("has-drawer");
}

tweaksTrigger.addEventListener("click", () => {
  const willOpen = !tweaksPanel.classList.contains("is-open");
  tweaksPanel.classList.toggle("is-open", willOpen);
  tweaksTrigger.setAttribute("aria-expanded", String(willOpen));
});

document.querySelectorAll("[data-item]").forEach((button) => {
  button.addEventListener("click", () => selectItem(button.dataset.item));
});

document.querySelector("#close-drawer").addEventListener("click", () => {
  const drawer = document.querySelector(".detail-drawer");
  shell.classList.remove("has-drawer");
  drawer.inert = true;
  drawer.setAttribute("aria-hidden", "true");
  document
    .querySelectorAll("[data-item]")
    .forEach((button) => button.classList.remove("is-selected"));
});

densityToggle.addEventListener("change", () => {
  const density = densityToggle.checked ? "compact" : "comfortable";
  shell.dataset.density = density;
  window.localStorage.setItem("agentBridgePrototypeDensity", density);
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () =>
    showToast("v1 暂不执行真实审批；完整交互将在任务流程确认后补齐"),
  );
});

document.querySelector("[data-placeholder='history']").addEventListener("click", () => {
  showToast("全部任务页不在本轮首页原型范围内");
});

setRange("today");

const savedDensity = window.localStorage.getItem("agentBridgePrototypeDensity");
if (savedDensity === "compact") {
  densityToggle.checked = true;
  shell.dataset.density = "compact";
}
