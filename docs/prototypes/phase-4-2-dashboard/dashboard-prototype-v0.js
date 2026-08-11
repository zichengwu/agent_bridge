/* global document, window */

const shell = document.querySelector(".prototype-shell");
const tweaksTrigger = document.querySelector("#tweaks-trigger");
const tweaksPanel = document.querySelector("#tweaks-panel");
const densityToggle = document.querySelector("#density-toggle");
const toast = document.querySelector("#toast");
let toastTimer;

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

function setLayout(layout) {
  shell.dataset.layout = layout;
  document.querySelectorAll("[data-layout-choice]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.layoutChoice === layout);
  });
  window.localStorage.setItem("agentBridgePrototypeLayout", layout);
}

function selectItem(itemId) {
  const data = detailData[itemId];
  if (!data) return;

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
  shell.classList.add("has-drawer");
}

tweaksTrigger.addEventListener("click", () => {
  const willOpen = !tweaksPanel.classList.contains("is-open");
  tweaksPanel.classList.toggle("is-open", willOpen);
  tweaksTrigger.setAttribute("aria-expanded", String(willOpen));
});

document.querySelectorAll("[data-layout-choice]").forEach((button) => {
  button.addEventListener("click", () => setLayout(button.dataset.layoutChoice));
});

document.querySelectorAll("[data-item]").forEach((button) => {
  button.addEventListener("click", () => selectItem(button.dataset.item));
});

document.querySelector("#close-drawer").addEventListener("click", () => {
  shell.classList.remove("has-drawer");
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
    showToast("v0 暂不执行真实审批；完整交互将在方向确认后补齐"),
  );
});

document.querySelector("[data-placeholder='history']").addEventListener("click", () => {
  showToast("全部任务页不在本轮首页原型范围内");
});

const savedLayout = window.localStorage.getItem("agentBridgePrototypeLayout");
if (["board", "timeline", "ledger"].includes(savedLayout)) setLayout(savedLayout);

const savedDensity = window.localStorage.getItem("agentBridgePrototypeDensity");
if (savedDensity === "compact") {
  densityToggle.checked = true;
  shell.dataset.density = "compact";
}
