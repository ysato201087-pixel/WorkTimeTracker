const state = {
  projects: [],
  entries: [],
  activeTimer: { status: "IDLE", activeSeconds: 0 }
};

const isHistoryPage = new URLSearchParams(location.search).get("history") === "1";

function requestCompactWindow() {
  if (isHistoryPage) return;
  const targetWidth = 410;
  const targetHeight = 455;
  try {
    if (Math.abs(window.outerWidth - targetWidth) > 20 || Math.abs(window.outerHeight - targetHeight) > 20) {
      window.resizeTo(targetWidth, targetHeight);
    }
  } catch {}
}

const $ = (id) => document.getElementById(id);

const els = {
  statusText: $("statusText"),
  projectInput: $("projectInput"),
  projectSelect: $("projectSelect"),
  projectOptions: $("projectOptions"),
  message: $("message"),
  currentTime: $("currentTime"),
  projectTotal: $("projectTotal"),
  startButton: $("startButton"),
  pauseButton: $("pauseButton"),
  resumeButton: $("resumeButton"),
  stopButton: $("stopButton"),
  openHistoryButton: $("openHistoryButton"),
  historyDialog: $("historyDialog"),
  closeHistoryButton: $("closeHistoryButton"),
  historyProjectFilter: $("historyProjectFilter"),
  addEntryButton: $("addEntryButton"),
  renameProjectButton: $("renameProjectButton"),
  deleteProjectButton: $("deleteProjectButton"),
  historySummary: $("historySummary"),
  historyList: $("historyList"),
  editDialog: $("editDialog"),
  editDialogTitle: $("editDialogTitle"),
  editForm: $("editForm"),
  editEntryId: $("editEntryId"),
  editProjectId: $("editProjectId"),
  durationPreset: $("durationPreset"),
  durationPresetLabel: $("durationPresetLabel"),
  editActiveText: $("editActiveText"),
  editMessage: $("editMessage"),
  deleteEntryButton: $("deleteEntryButton")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "処理に失敗しました。");
  return payload;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h && m) return `${h}時間${m}分`;
  if (h) return `${h}時間`;
  if (m) return `${m}分`;
  return `${s}秒`;
}

function entryRangeForDate(activeSeconds, baseIso = null) {
  const startedAt = baseIso ? new Date(baseIso) : new Date();
  startedAt.setHours(0, 0, 0, 0);
  const endedAt = new Date(startedAt.getTime() + activeSeconds * 1000);
  return {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString()
  };
}

function formatDate(iso) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(iso));
}

function setMessage(message = "", target = els.message) {
  target.textContent = message;
}

function selectedProject() {
  const name = els.projectInput.value.trim();
  return state.projects.find((project) => project.name.toLowerCase() === name.toLowerCase()) || null;
}

function syncProjectSelectToInput() {
  const project = selectedProject();
  els.projectSelect.value = project?.id || "";
}

function currentProjectTotal() {
  const timer = state.activeTimer;
  const project = timer.status !== "IDLE"
    ? state.projects.find((item) => item.id === timer.projectId)
    : selectedProject();
  return project?.totalSeconds || 0;
}

function currentTimerSeconds() {
  const timer = state.activeTimer;
  if (timer.status !== "RUNNING" || !timer.startedAt) return timer.activeSeconds || 0;
  const elapsed = Math.floor((Date.now() - new Date(timer.startedAt).getTime()) / 1000);
  return Math.max(0, elapsed - Number(timer.totalPausedSeconds || 0));
}

function renderTimer() {
  const status = state.activeTimer.status;
  const statusLabels = { IDLE: "未計測", RUNNING: "計測中", PAUSED: "一時停止中" };
  els.statusText.textContent = statusLabels[status] || "未計測";
  els.statusText.className = `status ${status.toLowerCase()}`;
  els.currentTime.textContent = formatClock(currentTimerSeconds());
  els.projectTotal.textContent = formatClock(currentProjectTotal());

  const locked = status !== "IDLE";
  els.projectInput.disabled = locked;
  els.projectSelect.disabled = locked;
  if (locked && state.activeTimer.projectName) {
    els.projectInput.value = state.activeTimer.projectName;
    els.projectSelect.value = state.activeTimer.projectId || "";
  } else {
    syncProjectSelectToInput();
  }

  els.startButton.disabled = status !== "IDLE";
  els.pauseButton.disabled = status !== "RUNNING";
  els.resumeButton.disabled = status !== "PAUSED";
  els.stopButton.disabled = status === "IDLE";
}

function renderProjectOptions() {
  els.projectOptions.replaceChildren(...state.projects.map((project) => {
    const option = document.createElement("option");
    option.value = project.name;
    return option;
  }));

  els.projectSelect.replaceChildren(
    optionElement("", "新規プロジェクト名を入力"),
    ...state.projects.map((project) => optionElement(project.id, project.name))
  );
  syncProjectSelectToInput();

  const previousFilter = els.historyProjectFilter.value || "all";
  els.historyProjectFilter.replaceChildren(
    optionElement("all", "すべてのプロジェクト"),
    ...state.projects.map((project) => optionElement(project.id, project.name))
  );
  if ([...els.historyProjectFilter.options].some((option) => option.value === previousFilter)) {
    els.historyProjectFilter.value = previousFilter;
  }

  els.editProjectId.replaceChildren(
    ...state.projects.map((project) => optionElement(project.id, project.name))
  );
}

function optionElement(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function entriesForFilter() {
  const filter = els.historyProjectFilter.value;
  return state.entries
    .filter((entry) => filter === "all" || entry.projectId === filter)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

function renderHistory() {
  const filter = els.historyProjectFilter.value;
  const entries = entriesForFilter();
  const selected = state.projects.find((project) => project.id === filter);
  const totalSeconds = selected
    ? selected.totalSeconds
    : state.projects.reduce((sum, project) => sum + project.totalSeconds, 0);
  const title = selected ? selected.name : "全プロジェクト";

  els.historySummary.textContent = `${title} 合計 ${formatClock(totalSeconds)} / 表示履歴 ${entries.length}件`;
  els.historyList.replaceChildren();

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "履歴はまだありません。";
    els.historyList.append(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "entry-row";
    row.innerHTML = `
      <span>${formatDate(entry.startedAt)}</span>
      <strong>${formatDuration(entry.activeSeconds)}</strong>
      <span class="project-name" title="${escapeHtml(entry.projectName)}">${escapeHtml(entry.projectName)}</span>
    `;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "編集";
    edit.addEventListener("click", () => openEdit(entry.id));
    row.append(edit);
    els.historyList.append(row);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function applyState(nextState) {
  state.projects = nextState.projects;
  state.entries = nextState.entries;
  state.activeTimer = nextState.activeTimer;
  renderProjectOptions();
  renderTimer();
  renderHistory();
}

async function loadState() {
  try {
    applyState(await api("/api/state"));
  } catch (error) {
    setMessage(`保存データの読み込みに失敗しました: ${error.message}`);
  }
}

function openHistoryWindow() {
  const historyUrl = `${location.origin}${location.pathname}?history=1`;
  const popup = window.open(
    historyUrl,
    "workTimeTrackerHistory",
    "popup=yes,width=820,height=660,resizable=yes,scrollbars=yes"
  );
  if (!popup) {
    renderHistory();
    els.historyDialog.showModal();
  }
}

function parseDuration(text) {
  const clean = String(text).trim();
  if (!clean) return NaN;

  const hm = clean.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (hm) {
    return Number(hm[1]) * 3600 + Number(hm[2]) * 60 + Number(hm[3] || 0);
  }

  const h = clean.match(/(\d+(?:\.\d+)?)\s*時間/);
  const m = clean.match(/(\d+)\s*分/);
  const s = clean.match(/(\d+)\s*秒/);
  if (h || m || s) {
    return Math.floor(Number(h?.[1] || 0) * 3600 + Number(m?.[1] || 0) * 60 + Number(s?.[1] || 0));
  }

  const minutes = clean.match(/^(\d+)$/);
  if (minutes) return Number(minutes[1]) * 60;
  return NaN;
}

function setDurationPreset(value) {
  const option = [...els.durationPreset.options].find((item) => item.value === String(value));
  els.durationPreset.value = option ? String(value) : "custom";
  els.editActiveText.disabled = els.durationPreset.value !== "custom";
}

function selectedDurationSeconds() {
  if (els.durationPreset.value !== "custom") return Number(els.durationPreset.value);
  return parseDuration(els.editActiveText.value);
}

function openEdit(entryId) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) return;
  els.editDialogTitle.textContent = "履歴編集";
  els.editEntryId.value = entry.id;
  els.editProjectId.value = entry.projectId;
  els.editActiveText.value = formatClock(entry.activeSeconds);
  setDurationPreset("custom");
  els.durationPresetLabel.hidden = true;
  els.deleteEntryButton.hidden = false;
  setMessage("", els.editMessage);
  els.editDialog.showModal();
}

function openAdd() {
  if (!state.projects.length) {
    setMessage("先にプロジェクトを作成してください。");
    return;
  }

  const filteredProject = state.projects.find((project) => project.id === els.historyProjectFilter.value);
  const target = filteredProject || selectedProject() || state.projects[0];
  els.editDialogTitle.textContent = "作業時間を追加";
  els.editEntryId.value = "";
  els.editProjectId.value = target.id;
  setDurationPreset(3600);
  els.durationPresetLabel.hidden = false;
  els.editActiveText.value = "01:00:00";
  els.deleteEntryButton.hidden = true;
  setMessage("", els.editMessage);
  els.editDialog.showModal();
}

els.startButton.addEventListener("click", async () => {
  setMessage();
  try {
    applyState(await api("/api/timer/start", {
      method: "POST",
      body: JSON.stringify({ projectName: els.projectInput.value })
    }));
  } catch (error) {
    setMessage(error.message);
  }
});

els.pauseButton.addEventListener("click", async () => {
  setMessage();
  try {
    applyState(await api("/api/timer/pause", { method: "POST" }));
  } catch (error) {
    setMessage(error.message);
  }
});

els.resumeButton.addEventListener("click", async () => {
  setMessage();
  try {
    applyState(await api("/api/timer/resume", { method: "POST" }));
  } catch (error) {
    setMessage(error.message);
  }
});

els.stopButton.addEventListener("click", async () => {
  setMessage();
  try {
    applyState(await api("/api/timer/stop", { method: "POST" }));
  } catch (error) {
    setMessage(error.message);
  }
});

els.projectInput.addEventListener("input", () => {
  syncProjectSelectToInput();
  renderTimer();
});

els.projectSelect.addEventListener("change", () => {
  const project = state.projects.find((item) => item.id === els.projectSelect.value);
  els.projectInput.value = project?.name || "";
  renderTimer();
});

els.openHistoryButton.addEventListener("click", openHistoryWindow);

els.closeHistoryButton.addEventListener("click", () => {
  if (isHistoryPage) {
    window.close();
    return;
  }
  els.historyDialog.close();
});
els.historyProjectFilter.addEventListener("change", renderHistory);
els.addEntryButton.addEventListener("click", openAdd);
els.durationPreset.addEventListener("change", () => {
  if (els.durationPreset.value === "custom") {
    els.editActiveText.disabled = false;
    els.editActiveText.focus();
    return;
  }
  els.editActiveText.value = formatClock(Number(els.durationPreset.value));
  els.editActiveText.disabled = true;
});

els.renameProjectButton.addEventListener("click", async () => {
  const projectId = els.historyProjectFilter.value;
  if (projectId === "all") return setMessage("名称変更するプロジェクトを選択してください。");
  const project = state.projects.find((item) => item.id === projectId);
  const name = prompt("新しいプロジェクト名", project?.name || "");
  if (name === null) return;
  try {
    applyState(await api(`/api/projects/${projectId}`, {
      method: "PUT",
      body: JSON.stringify({ name })
    }));
    els.historyProjectFilter.value = projectId;
  } catch (error) {
    setMessage(error.message);
  }
});

els.deleteProjectButton.addEventListener("click", async () => {
  const projectId = els.historyProjectFilter.value;
  if (projectId === "all") return setMessage("削除するプロジェクトを選択してください。");
  const project = state.projects.find((item) => item.id === projectId);
  if (!confirm(`「${project?.name || ""}」を削除します。紐づく作業履歴も削除されます。`)) return;
  try {
    applyState(await api(`/api/projects/${projectId}`, { method: "DELETE" }));
    els.historyProjectFilter.value = "all";
  } catch (error) {
    setMessage(error.message);
  }
});

els.editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("", els.editMessage);
  const id = els.editEntryId.value;
  const entry = state.entries.find((item) => item.id === id);
  const activeSeconds = selectedDurationSeconds();
  if (!Number.isFinite(activeSeconds)) {
    setMessage("作業時間は 1:27、01:27:00、87分 のように入力してください。", els.editMessage);
    return;
  }

  const range = entryRangeForDate(activeSeconds, entry?.startedAt || null);
  const payload = {
    projectId: els.editProjectId.value,
    previousProjectId: entry?.projectId,
    startedAt: range.startedAt,
    endedAt: range.endedAt,
    activeSeconds
  };

  try {
    const path = id ? `/api/entries/${id}` : "/api/entries";
    const method = id ? "PUT" : "POST";
    applyState(await api(path, {
      method,
      body: JSON.stringify(payload)
    }));
    els.editDialog.close();
  } catch (error) {
    setMessage(error.message, els.editMessage);
  }
});

els.deleteEntryButton.addEventListener("click", async () => {
  const id = els.editEntryId.value;
  if (!id || !confirm("この作業履歴を削除します。")) return;
  try {
    applyState(await api(`/api/entries/${id}`, { method: "DELETE" }));
    els.editDialog.close();
  } catch (error) {
    setMessage(error.message, els.editMessage);
  }
});

window.addEventListener("beforeunload", (event) => {
  if (state.activeTimer.status === "IDLE") return;
  event.preventDefault();
  event.returnValue = "現在タイマーが動作しています。";
});

function scheduleTimerRender() {
  renderTimer();
  const timer = state.activeTimer;
  let wait = 500;
  if (timer.status === "RUNNING" && timer.startedAt) {
    const elapsedMs = Date.now() - new Date(timer.startedAt).getTime() - Number(timer.totalPausedSeconds || 0) * 1000;
    wait = 1000 - (((elapsedMs % 1000) + 1000) % 1000) + 15;
  }
  setTimeout(scheduleTimerRender, Math.max(80, Math.min(wait, 1000)));
}

setInterval(loadState, 30000);
document.body.classList.toggle("history-page", isHistoryPage);
requestCompactWindow();
loadState().then(() => {
  if (isHistoryPage) {
    renderHistory();
    els.historyDialog.showModal();
  }
});
if (!isHistoryPage) scheduleTimerRender();
