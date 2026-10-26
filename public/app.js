const state = {
  categories: [],
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
  categoryInput: $("categoryInput"),
  categoryMenu: $("categoryMenu"),
  projectInput: $("projectInput"),
  projectMenu: $("projectMenu"),
  message: $("message"),
  currentTime: $("currentTime"),
  projectTotal: $("projectTotal"),
  projectTotalLabel: $("projectTotalLabel"),
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
  historyMessage: $("historyMessage"),
  projectDialog: $("projectDialog"),
  projectDialogTitle: $("projectDialogTitle"),
  projectForm: $("projectForm"),
  projectCategoryLabel: $("projectCategoryLabel"),
  projectCategoryInput: $("projectCategoryInput"),
  projectNameInput: $("projectNameInput"),
  projectMessage: $("projectMessage"),
  cancelProjectButton: $("cancelProjectButton"),
  categoryList: $("categoryList"),
  viewEntriesButton: $("viewEntriesButton"),
  viewDailyButton: $("viewDailyButton"),
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

const UNCATEGORIZED = "未分類";
const norm = (value) => String(value ?? "").normalize("NFKC").trim();
const normCategory = (value) => (norm(value) === UNCATEGORIZED ? "" : norm(value));
const sameText = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();

// 候補から選んだプロジェクトの id (文字を書き換えたら null に戻す)
let pickedProjectId = null;

function byRecent(a, b) {
  return String(b.lastWorkedAt || "").localeCompare(String(a.lastWorkedAt || "")) || a.name.localeCompare(b.name, "ja");
}

// プロジェクト (name) と記録 (projectName) のどちらでも使う
function projectLabel(item) {
  const name = item.projectName ?? item.name;
  return item.categoryName ? `${item.categoryName} / ${name}` : name;
}

function projectsInCategory(categoryName) {
  const name = normCategory(categoryName);
  return state.projects.filter((project) => (name ? sameText(project.categoryName, name) : !project.categoryName));
}

function selectedProject() {
  const picked = state.projects.find((project) => project.id === pickedProjectId);
  if (picked) return picked;
  const name = norm(els.projectInput.value);
  if (!name) return null;
  const categoryName = normCategory(els.categoryInput.value);
  if (categoryName) return projectsInCategory(categoryName).find((project) => sameText(project.name, name)) || null;
  const matches = state.projects.filter((project) => sameText(project.name, name));
  return matches.length === 1 ? matches[0] : null;
}

function hideProjectMenu() {
  els.projectMenu.hidden = true;
  els.projectInput.setAttribute("aria-expanded", "false");
}

function hideCategoryMenu() {
  els.categoryMenu.hidden = true;
  els.categoryInput.setAttribute("aria-expanded", "false");
}

function menuButton(label, sub, onPick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "project-option";
  button.textContent = label;
  if (sub) {
    const small = document.createElement("span");
    small.className = "option-sub";
    small.textContent = sub;
    button.append(small);
  }
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", onPick);
  return button;
}

function showMenu(menu, input, buttons) {
  if (!buttons.length) {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    return;
  }
  menu.replaceChildren(...buttons);
  menu.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function showProjectMenu(showAll = false) {
  hideCategoryMenu();
  if (state.activeTimer.status !== "IDLE" || !state.projects.length) return hideProjectMenu();
  const categoryName = normCategory(els.categoryInput.value);
  const query = showAll ? "" : norm(els.projectInput.value).toLowerCase();
  const pool = categoryName ? projectsInCategory(categoryName) : state.projects;
  const projects = pool
    .filter((project) => !query
      || project.name.toLowerCase().includes(query)
      || (!categoryName && project.categoryName.toLowerCase().includes(query)))
    .sort(byRecent);
  showMenu(els.projectMenu, els.projectInput, projects.map((project) => menuButton(
    project.name,
    categoryName ? "" : (project.categoryName || UNCATEGORIZED),
    () => {
      els.projectInput.value = project.name;
      els.categoryInput.value = project.categoryName;
      pickedProjectId = project.id;
      hideProjectMenu();
      renderTimer();
    }
  )));
}

// カテゴリを変えた時: 選んだプロジェクトだけ見直す (手で打った名前は残す)
function onCategoryChanged() {
  const picked = state.projects.find((project) => project.id === pickedProjectId);
  if (!picked) return renderTimer();
  const categoryName = normCategory(els.categoryInput.value);
  if (sameText(picked.categoryName, categoryName)) return renderTimer();
  const twin = projectsInCategory(categoryName).find((project) => sameText(project.name, picked.name));
  if (twin) {
    pickedProjectId = twin.id;
  } else {
    pickedProjectId = null;
    els.projectInput.value = "";
  }
  renderTimer();
}

function showCategoryMenu(showAll = false) {
  hideProjectMenu();
  if (state.activeTimer.status !== "IDLE" || !state.categories.length) return hideCategoryMenu();
  const query = showAll ? "" : norm(els.categoryInput.value).toLowerCase();
  const categories = state.categories.filter((category) => !query || category.name.toLowerCase().includes(query));
  showMenu(els.categoryMenu, els.categoryInput, categories.map((category) => menuButton(
    category.name,
    "",
    () => {
      els.categoryInput.value = category.name;
      hideCategoryMenu();
      onCategoryChanged();
      els.projectInput.focus();
    }
  )));
}

// 「その他」カテゴリは毎日リセット (今日の分だけ数える)
const DAILY_RESET_CATEGORY = "その他";

function isDailyReset(project) {
  return Boolean(project) && sameText(project.categoryName, DAILY_RESET_CATEGORY);
}

function currentProject() {
  const timer = state.activeTimer;
  return timer.status !== "IDLE"
    ? state.projects.find((item) => item.id === timer.projectId)
    : selectedProject();
}

function currentProjectTotal() {
  const project = currentProject();
  if (!project) return 0;
  if (!isDailyReset(project)) return project.totalSeconds || 0;
  const today = localDayKey(new Date().toISOString());
  return state.entries
    .filter((entry) => entry.projectId === project.id && localDayKey(entry.startedAt) === today)
    .reduce((sum, entry) => sum + entry.activeSeconds, 0);
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
  const project = currentProject();
  const dailyReset = project ? isDailyReset(project) : sameText(els.categoryInput.value, DAILY_RESET_CATEGORY);
  els.projectTotalLabel.textContent = dailyReset ? "今日の累計" : "プロジェクト累計";

  const locked = status !== "IDLE";
  els.projectInput.disabled = locked;
  els.categoryInput.disabled = locked;
  if (locked && state.activeTimer.projectName) {
    els.projectInput.value = state.activeTimer.projectName;
    els.categoryInput.value = state.activeTimer.categoryName || "";
    pickedProjectId = state.activeTimer.projectId;
    hideProjectMenu();
    hideCategoryMenu();
  }

  els.startButton.disabled = status !== "IDLE";
  els.pauseButton.disabled = status !== "RUNNING";
  els.resumeButton.disabled = status !== "PAUSED";
  els.stopButton.disabled = status === "IDLE";
}

// カテゴリごとのまとまり (未分類は最後)
function categoryGroups() {
  const groups = state.categories.map((category) => ({
    key: `cat:${category.id}`,
    name: category.name,
    projects: state.projects.filter((project) => project.categoryId === category.id)
  }));
  const loose = state.projects.filter((project) => !project.categoryId);
  if (loose.length) groups.push({ key: "cat:none", name: UNCATEGORIZED, projects: loose });
  return groups;
}

function renderProjectOptions() {
  const previousFilter = els.historyProjectFilter.value || "all";
  const groups = categoryGroups();
  els.historyProjectFilter.replaceChildren(
    optionElement("all", "すべて"),
    ...groups.map((group) => {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.name;
      optgroup.append(
        optionElement(group.key, `${group.name} 全体`),
        ...group.projects.map((project) => optionElement(`proj:${project.id}`, project.name))
      );
      return optgroup;
    })
  );
  if ([...els.historyProjectFilter.options].some((option) => option.value === previousFilter)) {
    els.historyProjectFilter.value = previousFilter;
  }

  const previousEditProject = els.editProjectId.value;
  els.editProjectId.replaceChildren(...groups.filter((group) => group.projects.length).map((group) => {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.name;
    optgroup.append(...group.projects.map((project) => optionElement(project.id, project.name)));
    return optgroup;
  }));
  if (previousEditProject && state.projects.some((project) => project.id === previousEditProject)) {
    els.editProjectId.value = previousEditProject;
  }

  els.categoryList.replaceChildren(...state.categories.map((category) => optionElement(category.name, category.name)));
}

// 絞り込み: all / cat:<id> / cat:none / proj:<id>
function currentFilter() {
  const value = els.historyProjectFilter.value || "all";
  if (value.startsWith("proj:")) return { type: "project", id: value.slice(5) };
  if (value === "cat:none") return { type: "category", id: null };
  if (value.startsWith("cat:")) return { type: "category", id: value.slice(4) };
  return { type: "all" };
}

function matchesFilter(projectId, categoryId) {
  const filter = currentFilter();
  if (filter.type === "project") return projectId === filter.id;
  if (filter.type === "category") return (categoryId || null) === filter.id;
  return true;
}

function filterTitle() {
  const filter = currentFilter();
  if (filter.type === "project") {
    const project = state.projects.find((item) => item.id === filter.id);
    return project ? projectLabel(project) : "";
  }
  if (filter.type === "category") {
    return filter.id ? (state.categories.find((item) => item.id === filter.id)?.name || "") : UNCATEGORIZED;
  }
  return "すべて";
}

function filterTotalSeconds() {
  return state.projects
    .filter((project) => matchesFilter(project.id, project.categoryId))
    .reduce((sum, project) => sum + project.totalSeconds, 0);
}

function optionElement(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function entriesForFilter() {
  return state.entries
    .filter((entry) => matchesFilter(entry.projectId, entry.categoryId))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

const VIEW_KEY = "wtt-history-view";
let historyView = "entries";
try { historyView = localStorage.getItem(VIEW_KEY) === "daily" ? "daily" : "entries"; } catch {}

function setHistoryView(view) {
  historyView = view;
  try { localStorage.setItem(VIEW_KEY, view); } catch {}
  renderHistory();
}

function localDayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const week = "日月火水木金土"[date.getDay()];
  const today = localDayKey(new Date().toISOString());
  const label = `${m}/${d} (${week})`;
  return key === today ? `今日 ${label}` : label;
}

// 日別: 開始日 (ローカル) → カテゴリ → プロジェクト。計測中のタイマーは今日に加算
function dailyTotals() {
  const days = new Map();
  const add = (dayKey, item, seconds) => {
    if (!matchesFilter(item.projectId, item.categoryId)) return;
    if (!days.has(dayKey)) days.set(dayKey, { total: 0, categories: new Map() });
    const day = days.get(dayKey);
    day.total += seconds;
    const catKey = item.categoryId || "none";
    if (!day.categories.has(catKey)) {
      day.categories.set(catKey, { name: item.categoryName || UNCATEGORIZED, seconds: 0, projects: new Map() });
    }
    const category = day.categories.get(catKey);
    category.seconds += seconds;
    const project = category.projects.get(item.projectId) || { name: item.projectName, seconds: 0 };
    project.seconds += seconds;
    category.projects.set(item.projectId, project);
  };
  for (const entry of state.entries) add(localDayKey(entry.startedAt), entry, entry.activeSeconds);
  const timer = state.activeTimer;
  if (timer.status !== "IDLE" && timer.projectId) {
    add(localDayKey(new Date().toISOString()), timer, currentTimerSeconds());
  }
  return [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

function dayRow(className, name, seconds) {
  const row = document.createElement("div");
  row.className = className;
  row.innerHTML = `<span class="project-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span><span>${formatDuration(seconds)}</span>`;
  return row;
}

function renderDaily() {
  const days = dailyTotals();
  const periodTotal = days.reduce((sum, [, day]) => sum + day.total, 0);
  const range = days.length ? `${formatDayLabel(days[days.length - 1][0]).replace(/^今日 /, "")} 〜 ` : "";
  els.historySummary.textContent = `${filterTitle()} ${range}合計 ${formatDuration(periodTotal)}`;
  els.historyList.replaceChildren();

  if (!days.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "記録はまだありません。";
    els.historyList.append(empty);
    return;
  }

  for (const [key, day] of days) {
    const block = document.createElement("div");
    block.className = "day-block";
    const head = document.createElement("div");
    head.className = "day-head";
    head.innerHTML = `<span>${formatDayLabel(key)}</span><strong>${formatDuration(day.total)}</strong>`;
    block.append(head);
    const categories = [...day.categories.values()].sort((a, b) => b.seconds - a.seconds);
    for (const category of categories) {
      block.append(dayRow("day-category", category.name, category.seconds));
      const projects = [...category.projects.values()].sort((a, b) => b.seconds - a.seconds);
      for (const project of projects) block.append(dayRow("day-project", project.name, project.seconds));
    }
    els.historyList.append(block);
  }
}

function renderHistory() {
  els.viewEntriesButton.classList.toggle("active", historyView === "entries");
  els.viewDailyButton.classList.toggle("active", historyView === "daily");
  els.viewEntriesButton.setAttribute("aria-selected", String(historyView === "entries"));
  els.viewDailyButton.setAttribute("aria-selected", String(historyView === "daily"));
  const filter = currentFilter();
  const editable = filter.type === "project" || (filter.type === "category" && filter.id);
  els.renameProjectButton.disabled = !editable;
  els.deleteProjectButton.disabled = !editable;
  if (historyView === "daily") return renderDaily();
  const entries = entriesForFilter();
  els.historySummary.textContent = `${filterTitle()} 累計 ${formatClock(filterTotalSeconds())} / 表示履歴 ${entries.length}件`;
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
      <span class="project-name" title="${escapeHtml(projectLabel(entry))}">${escapeHtml(projectLabel(entry))}</span>
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
  state.categories = nextState.categories || [];
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

const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function openHistoryWindow() {
  // Safari の Web アプリでは別ウィンドウが Safari 本体で開くことがあるので、画面内ダイアログにする
  if (isStandalone) {
    renderHistory();
    els.historyDialog.showModal();
    return;
  }
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
    setMessage("先にプロジェクトを作成してください。", els.historyMessage);
    return;
  }

  const filter = currentFilter();
  const inFilter = state.projects.filter((project) => matchesFilter(project.id, project.categoryId)).sort(byRecent);
  const recent = [...state.projects].sort(byRecent)[0];
  const target = (filter.type !== "all" && inFilter[0]) || selectedProject() || recent;
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
      body: JSON.stringify(selectedProject() && pickedProjectId
        ? { projectId: pickedProjectId }
        : { categoryName: els.categoryInput.value, projectName: els.projectInput.value })
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
  pickedProjectId = null;
  renderTimer();
  showProjectMenu(false);
});

els.categoryInput.addEventListener("input", () => showCategoryMenu(false));
els.categoryInput.addEventListener("change", onCategoryChanged);
els.categoryInput.addEventListener("focus", () => showCategoryMenu(true));
els.categoryInput.addEventListener("click", () => showCategoryMenu(true));
els.categoryInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideCategoryMenu();
  if (event.key === "Enter") {
    hideCategoryMenu();
    onCategoryChanged();
    els.projectInput.focus();
  }
});

els.projectInput.addEventListener("focus", () => showProjectMenu(true));
els.projectInput.addEventListener("click", () => showProjectMenu(true));
els.projectInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideProjectMenu();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".project-combobox")) {
    hideProjectMenu();
    hideCategoryMenu();
  }
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

let projectDialogTarget = null;

els.renameProjectButton.addEventListener("click", () => {
  setMessage("", els.historyMessage);
  const filter = currentFilter();
  if (filter.type === "project") {
    const project = state.projects.find((item) => item.id === filter.id);
    if (!project) return;
    projectDialogTarget = { type: "project", id: project.id };
    els.projectDialogTitle.textContent = "プロジェクトを編集";
    els.projectCategoryLabel.hidden = false;
    els.projectCategoryInput.value = project.categoryName;
    els.projectNameInput.value = project.name;
  } else if (filter.type === "category" && filter.id) {
    const category = state.categories.find((item) => item.id === filter.id);
    if (!category) return;
    projectDialogTarget = { type: "category", id: category.id };
    els.projectDialogTitle.textContent = "カテゴリを編集";
    els.projectCategoryLabel.hidden = true;
    els.projectNameInput.value = category.name;
  } else {
    return;
  }
  setMessage("", els.projectMessage);
  els.projectDialog.showModal();
  els.projectNameInput.select();
});

els.cancelProjectButton.addEventListener("click", () => els.projectDialog.close());

els.projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = projectDialogTarget;
  if (!target) return;
  try {
    if (target.type === "project") {
      applyState(await api(`/api/projects/${target.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: els.projectNameInput.value, categoryName: els.projectCategoryInput.value })
      }));
      els.historyProjectFilter.value = `proj:${target.id}`;
    } else {
      applyState(await api(`/api/categories/${target.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: els.projectNameInput.value })
      }));
      els.historyProjectFilter.value = `cat:${target.id}`;
    }
    renderHistory();
    els.projectDialog.close();
  } catch (error) {
    setMessage(error.message, els.projectMessage);
  }
});

els.deleteProjectButton.addEventListener("click", async () => {
  setMessage("", els.historyMessage);
  const filter = currentFilter();
  try {
    if (filter.type === "project") {
      const project = state.projects.find((item) => item.id === filter.id);
      if (!confirm(`「${project ? projectLabel(project) : ""}」を削除します。作業履歴は一覧から消え、バックアップの CSV に移されます。`)) return;
      applyState(await api(`/api/projects/${filter.id}`, { method: "DELETE" }));
    } else if (filter.type === "category" && filter.id) {
      const category = state.categories.find((item) => item.id === filter.id);
      if (!confirm(`カテゴリ「${category?.name || ""}」を削除します。中のプロジェクトと記録は未分類に移ります。`)) return;
      applyState(await api(`/api/categories/${filter.id}`, { method: "DELETE" }));
    } else {
      return;
    }
    els.historyProjectFilter.value = "all";
    renderHistory();
  } catch (error) {
    setMessage(error.message, els.historyMessage);
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

els.viewEntriesButton.addEventListener("click", () => setHistoryView("entries"));
els.viewDailyButton.addEventListener("click", () => setHistoryView("daily"));

let lastDailyRender = 0;

function scheduleTimerRender() {
  renderTimer();
  if (historyView === "daily" && state.activeTimer.status === "RUNNING" && els.historyDialog.open && Date.now() - lastDailyRender > 60000) {
    lastDailyRender = Date.now();
    renderHistory();
  }
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
scheduleTimerRender();
