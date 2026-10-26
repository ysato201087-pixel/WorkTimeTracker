import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, "data");
const dbPath = process.env.WTT_DB_PATH || join(dataDir, "work-time-tracker.sqlite");
const port = Number(process.env.PORT || 47831);

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS time_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    active_seconds INTEGER NOT NULL CHECK(active_seconds >= 0),
    paused_seconds INTEGER NOT NULL CHECK(paused_seconds >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS active_timer (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    project_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('IDLE', 'RUNNING', 'PAUSED')),
    started_at TEXT,
    paused_at TEXT,
    total_paused_seconds INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
  );
`);

const nowIso = () => new Date().toISOString();
const toDate = (value) => new Date(value);
const secondsBetween = (start, end) => Math.max(0, Math.floor((toDate(end) - toDate(start)) / 1000));

function ensureActiveTimer() {
  const timer = db.prepare("SELECT * FROM active_timer WHERE id = 1").get();
  if (!timer) {
    db.prepare(`
      INSERT INTO active_timer (id, status, total_paused_seconds, updated_at)
      VALUES (1, 'IDLE', 0, ?)
    `).run(nowIso());
  }
}

ensureActiveTimer();
let rewriteAllCsvs = false;
migrate();

// v1.1: 10件制限を廃止し、古い記録は archived_entries へ保管 + CSV バックアップ
function migrate() {
  const version = () => Number(db.prepare("PRAGMA user_version").get().user_version || 0);
  if (version() < 1) migrateV1();
  if (version() < 2) migrateV2();
}

function backupBefore(tag) {
  const backupDir = join(dataDir, "backup");
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const today = localStamp(new Date()).slice(0, 10);
  if (readdirSync(backupDir).some((name) => name.startsWith(`pre-${tag}-${today}`))) return;
  const file = join(backupDir, `pre-${tag}-${localStamp(new Date()).replace(/[: ]/g, "-")}.sqlite`);
  db.prepare("VACUUM INTO ?").run(file);
}

// v1.2: カテゴリ。projects を作り直して一意性を「カテゴリ内で一意」にする
function migrateV2() {
  backupBefore("v1.2");
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  const before = { projects: count("projects"), entries: count("time_entries") };
  // 外部キーは BEGIN の前に切る (ON のまま DROP すると CASCADE で記録が消える)
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE projects_new (
          id TEXT PRIMARY KEY,
          category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
          name TEXT NOT NULL COLLATE NOCASE,
          archived_seconds INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      // 既存の名前も NFKC で正規化。重複したら「 (2)」等を付けて回避
      const insertProject = db.prepare(`
        INSERT INTO projects_new (id, category_id, name, archived_seconds, created_at, updated_at)
        VALUES (?, NULL, ?, ?, ?, ?)
      `);
      const used = new Set();
      for (const row of db.prepare("SELECT * FROM projects ORDER BY created_at").all()) {
        const base = cleanName(row.name) || row.name;
        let name = base;
        for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base} (${n})`;
        if (name !== row.name) console.error(`migrate v1.2: renamed "${row.name}" -> "${name}"`);
        used.add(name.toLowerCase());
        insertProject.run(row.id, name, row.archived_seconds, row.created_at, row.updated_at);
      }
      db.exec(`
        DROP TABLE projects;
        ALTER TABLE projects_new RENAME TO projects;
        CREATE UNIQUE INDEX idx_projects_category_name ON projects(COALESCE(category_id, ''), name COLLATE NOCASE);
      `);
      const archivedColumns = db.prepare("PRAGMA table_info(archived_entries)").all().map((c) => c.name);
      if (!archivedColumns.includes("category_name")) {
        db.exec("ALTER TABLE archived_entries ADD COLUMN category_name TEXT NOT NULL DEFAULT ''");
      }
      const problems = db.prepare("PRAGMA foreign_key_check").all();
      if (problems.length) throw new Error(`foreign_key_check failed: ${JSON.stringify(problems)}`);
      if (count("projects") !== before.projects || count("time_entries") !== before.entries) {
        throw new Error("row count mismatch after migration");
      }
      db.exec("PRAGMA user_version = 2");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  // CSV の列が変わったので全月を作り直す
  rewriteAllCsvs = true;
}


function migrateV1() {
  const backupDir = join(dataDir, "backup");
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const today = localStamp(new Date()).slice(0, 10);
  const alreadyBackedUp = readdirSync(backupDir).some((name) => name.startsWith(`pre-v1.1-${today}`));
  if (existsSync(dbPath) && !alreadyBackedUp) {
    copyFileSync(dbPath, join(backupDir, `pre-v1.1-${localStamp(new Date()).replace(/[: ]/g, "-")}.sqlite`));
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = db.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
    if (!columns.includes("archived_seconds")) {
      db.exec("ALTER TABLE projects ADD COLUMN archived_seconds INTEGER NOT NULL DEFAULT 0");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS archived_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        active_seconds INTEGER NOT NULL,
        paused_seconds INTEGER NOT NULL,
        archived_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entries_started ON time_entries(started_at);
      CREATE INDEX IF NOT EXISTS idx_entries_project_started ON time_entries(project_id, started_at);
      PRAGMA user_version = 1;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const UNCATEGORIZED = "未分類";

function cleanName(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function cleanCategoryName(value) {
  const name = cleanName(value);
  return name === UNCATEGORIZED ? "" : name;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function localStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function localMonthKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// 保持範囲の開始 = ローカル時刻で前月1日 00:00
function retentionCutoff(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
}

// 記録を archived_entries へ移す (呼び出し側のトランザクション内で使う)
function moveToArchive(rows, { addToTotal }) {
  const now = nowIso();
  const insert = db.prepare(`
    INSERT INTO archived_entries
      (id, project_id, project_name, category_name, started_at, ended_at, active_seconds, paused_seconds, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const addSeconds = db.prepare("UPDATE projects SET archived_seconds = archived_seconds + ? WHERE id = ?");
  const remove = db.prepare("DELETE FROM time_entries WHERE id = ?");
  for (const row of rows) {
    insert.run(row.id, row.project_id, row.project_name, row.category_name || "", row.started_at, row.ended_at, row.active_seconds, row.paused_seconds, now);
    if (addToTotal) addSeconds.run(row.active_seconds, row.project_id);
    remove.run(row.id);
  }
  return [...new Set(rows.map((row) => localMonthKey(row.started_at)))];
}

const selectEntriesWithName = `
  SELECT e.*, p.name AS project_name, COALESCE(c.name, '') AS category_name
  FROM time_entries e
  JOIN projects p ON p.id = e.project_id
  LEFT JOIN categories c ON c.id = p.category_id
`;

function archiveOldEntries() {
  const cutoffIso = retentionCutoff().toISOString();
  let months = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare(`${selectEntriesWithName} WHERE e.started_at < ?`).all(cutoffIso);
    months = moveToArchive(rows, { addToTotal: true });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("archive failed", error);
    return 0;
  }
  for (const month of months) writeMonthCsv(month);
  return months.length;
}

// CSV が無い月 (書き出し前に落ちた等) を作り直す
function ensureMonthCsvs() {
  const backupDir = join(dataDir, "backup");
  const months = new Set(db.prepare("SELECT started_at FROM archived_entries").all().map((row) => localMonthKey(row.started_at)));
  for (const month of months) {
    const file = join(backupDir, `entries-${month}.csv`);
    if (rewriteAllCsvs || !existsSync(file) || !readFileSync(file, "utf8").split("\n", 1)[0].includes("カテゴリ")) writeMonthCsv(month);
  }
  rewriteAllCsvs = false;
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function writeMonthCsv(month) {
  try {
    const backupDir = join(dataDir, "backup");
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
    const [y, m] = month.split("-").map(Number);
    const from = new Date(y, m - 1, 1).toISOString();
    const to = new Date(y, m, 1).toISOString();
    const rows = db.prepare("SELECT * FROM archived_entries WHERE started_at >= ? AND started_at < ? ORDER BY started_at").all(from, to);
    const header = ["記録ID", "プロジェクトID", "カテゴリ", "プロジェクト名", "開始", "終了", "作業秒", "作業時間", "一時停止秒"];
    const lines = [header.map(csvCell).join(",")];
    for (const row of rows) {
      const sec = Number(row.active_seconds);
      const hms = `${Math.floor(sec / 3600)}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
      lines.push([
        row.id, row.project_id, row.category_name || "", row.project_name,
        localStamp(new Date(row.started_at)), localStamp(new Date(row.ended_at)),
        sec, hms, row.paused_seconds
      ].map(csvCell).join(","));
    }
    const file = join(backupDir, `entries-${month}.csv`);
    writeFileSync(`${file}.tmp`, "\uFEFF" + lines.join("\r\n") + "\r\n");
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    console.error("csv backup failed", error);
  }
}

function publicProject(row) {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id || null,
    categoryName: row.category_name || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    totalSeconds: Number(row.total_seconds || 0),
    lastWorkedAt: row.last_worked_at || null
  };
}

function getProjects() {
  return db.prepare(`
    SELECT
      p.id,
      p.name,
      p.category_id,
      c.name AS category_name,
      p.created_at,
      p.updated_at,
      p.archived_seconds + COALESCE(SUM(e.active_seconds), 0) AS total_seconds,
      MAX(e.ended_at) AS last_worked_at
    FROM projects p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN time_entries e ON e.project_id = p.id
    GROUP BY p.id
    ORDER BY LOWER(COALESCE(c.name, '')), LOWER(p.name)
  `).all().map(publicProject);
}

function getCategories() {
  return db.prepare("SELECT id, name FROM categories ORDER BY LOWER(name)").all()
    .map((row) => ({ id: row.id, name: row.name }));
}

function getEntries() {
  return db.prepare(`
    SELECT
      e.id,
      e.project_id,
      p.name AS project_name,
      p.category_id,
      COALESCE(c.name, '') AS category_name,
      e.started_at,
      e.ended_at,
      e.active_seconds,
      e.paused_seconds,
      e.created_at,
      e.updated_at
    FROM time_entries e
    JOIN projects p ON p.id = e.project_id
    LEFT JOIN categories c ON c.id = p.category_id
    ORDER BY e.started_at DESC, e.created_at DESC
  `).all().map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    categoryId: row.category_id || null,
    categoryName: row.category_name || "",
    startedAt: row.started_at,
    endedAt: row.ended_at,
    activeSeconds: Number(row.active_seconds),
    pausedSeconds: Number(row.paused_seconds),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function getTimerRaw() {
  ensureActiveTimer();
  return db.prepare(`
    SELECT t.*, p.name AS project_name, p.category_id, c.name AS category_name
    FROM active_timer t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE t.id = 1
  `).get();
}

function publicTimer(row = getTimerRaw()) {
  const now = nowIso();
  let elapsedSeconds = 0;
  let pausedSeconds = Number(row.total_paused_seconds || 0);

  if (row.status === "RUNNING" && row.started_at) {
    elapsedSeconds = secondsBetween(row.started_at, now) - pausedSeconds;
  }

  if (row.status === "PAUSED" && row.started_at) {
    const pauseStartedAt = row.paused_at || now;
    pausedSeconds += secondsBetween(pauseStartedAt, now);
    elapsedSeconds = secondsBetween(row.started_at, pauseStartedAt) - Number(row.total_paused_seconds || 0);
  }

  return {
    status: row.status,
    projectId: row.project_id || null,
    projectName: row.project_name || "",
    categoryId: row.category_id || null,
    categoryName: row.category_name || "",
    startedAt: row.started_at || null,
    pausedAt: row.paused_at || null,
    totalPausedSeconds: pausedSeconds,
    activeSeconds: Math.max(0, elapsedSeconds),
    serverNow: now
  };
}

function getState() {
  return {
    categories: getCategories(),
    projects: getProjects(),
    entries: getEntries(),
    activeTimer: publicTimer()
  };
}

function findCategoryByName(name) {
  return name ? db.prepare("SELECT * FROM categories WHERE name = ? COLLATE NOCASE").get(name) : null;
}

function getOrCreateCategoryId(rawName) {
  const name = cleanCategoryName(rawName);
  if (!name) return null;
  const existing = findCategoryByName(name);
  if (existing) return existing.id;
  const now = nowIso();
  const id = randomUUID();
  db.prepare("INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, now, now);
  return id;
}

// スタート時のプロジェクト決定 (仕様 v1.2「スタート時に何を使うか」)
function resolveProjectForStart(body) {
  if (body.projectId) {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(String(body.projectId));
    if (!project) throw httpError(404, "プロジェクトが見つかりません。");
    return project;
  }
  const name = cleanName(body.projectName);
  if (!name) throw httpError(400, "プロジェクト名を入力してください。");
  const categoryName = cleanCategoryName(body.categoryName);

  if (!categoryName) {
    const matches = db.prepare("SELECT * FROM projects WHERE name = ? COLLATE NOCASE").all(name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw httpError(409, "同じ名前のプロジェクトが複数あります。カテゴリを選んでください。");
  } else {
    const category = findCategoryByName(categoryName);
    if (category) {
      const existing = db.prepare("SELECT * FROM projects WHERE COALESCE(category_id, '') = ? AND name = ? COLLATE NOCASE").get(category.id, name);
      if (existing) return existing;
    }
  }

  const now = nowIso();
  const id = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    const categoryId = getOrCreateCategoryId(categoryName);
    db.prepare("INSERT INTO projects (id, category_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, categoryId, name, now, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

function startTimer(body) {
  const timer = getTimerRaw();
  if (timer.status !== "IDLE") {
    throw httpError(409, "すでにタイマーが動作しています。ストップしてから別のプロジェクトを開始してください。");
  }

  const project = resolveProjectForStart(body);
  const now = nowIso();
  db.prepare(`
    UPDATE active_timer
    SET project_id = ?, status = 'RUNNING', started_at = ?, paused_at = NULL,
        total_paused_seconds = 0, updated_at = ?
    WHERE id = 1
  `).run(project.id, now, now);
  return getState();
}

function pauseTimer() {
  const timer = getTimerRaw();
  if (timer.status !== "RUNNING") throw httpError(409, "計測中のタイマーがありません。");

  const now = nowIso();
  db.prepare("UPDATE active_timer SET status = 'PAUSED', paused_at = ?, updated_at = ? WHERE id = 1")
    .run(now, now);
  return getState();
}

function resumeTimer() {
  const timer = getTimerRaw();
  if (timer.status !== "PAUSED") throw httpError(409, "一時停止中のタイマーがありません。");

  const now = nowIso();
  const pausedDelta = timer.paused_at ? secondsBetween(timer.paused_at, now) : 0;
  db.prepare(`
    UPDATE active_timer
    SET status = 'RUNNING',
        paused_at = NULL,
        total_paused_seconds = total_paused_seconds + ?,
        updated_at = ?
    WHERE id = 1
  `).run(pausedDelta, now);
  return getState();
}

function stopTimer() {
  const timer = getTimerRaw();
  if (timer.status === "IDLE") throw httpError(409, "停止するタイマーがありません。");

  const endedAt = nowIso();
  const startedAt = timer.started_at;
  let pausedSeconds = Number(timer.total_paused_seconds || 0);

  if (timer.status === "PAUSED" && timer.paused_at) {
    pausedSeconds += secondsBetween(timer.paused_at, endedAt);
  }

  const activeSeconds = Math.max(0, secondsBetween(startedAt, endedAt) - pausedSeconds);
  const entryId = randomUUID();

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO time_entries (
        id, project_id, started_at, ended_at, active_seconds, paused_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entryId, timer.project_id, startedAt, endedAt, activeSeconds, pausedSeconds, endedAt, endedAt);

    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(endedAt, timer.project_id);
    db.prepare(`
      UPDATE active_timer
      SET project_id = NULL, status = 'IDLE', started_at = NULL, paused_at = NULL,
          total_paused_seconds = 0, updated_at = ?
      WHERE id = 1
    `).run(endedAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getState();
}

function createEntry(body) {
  const projectId = String(body.projectId || "");
  const startedAt = parseIso(body.startedAt, "開始日時が不正です。");
  const endedAt = parseIso(body.endedAt, "終了日時が不正です。");
  if (endedAt < startedAt) throw httpError(400, "終了日時は開始日時より後にしてください。");

  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) throw httpError(400, "プロジェクトが見つかりません。");

  const elapsedSeconds = secondsBetween(startedAt.toISOString(), endedAt.toISOString());
  const activeSeconds = validateActiveSeconds(body.activeSeconds, elapsedSeconds);
  const pausedSeconds = elapsedSeconds - activeSeconds;
  const now = nowIso();

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO time_entries (
        id, project_id, started_at, ended_at, active_seconds, paused_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), projectId, startedAt.toISOString(), endedAt.toISOString(), activeSeconds, pausedSeconds, now, now);
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getState();
}

function updateProject(id, body) {
  const name = cleanName(body.name);
  if (!name) throw httpError(400, "プロジェクト名を入力してください。");
  const current = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!current) throw httpError(404, "プロジェクトが見つかりません。");
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    // categoryName キーが無ければカテゴリは変えない (空文字なら未分類)
    const categoryId = Object.hasOwn(body, "categoryName") ? getOrCreateCategoryId(body.categoryName) : current.category_id;
    const clash = db.prepare(`
      SELECT id FROM projects WHERE id <> ? AND COALESCE(category_id, '') = COALESCE(?, '') AND name = ? COLLATE NOCASE
    `).get(id, categoryId, name);
    if (clash) throw httpError(409, "移動先に同じ名前のプロジェクトがあります。");
    db.prepare("UPDATE projects SET name = ?, category_id = ?, updated_at = ? WHERE id = ?").run(name, categoryId, now, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getState();
}

function updateCategory(id, body) {
  const name = cleanCategoryName(body.name);
  if (!name) throw httpError(400, "カテゴリ名を入力してください。");
  const clash = db.prepare("SELECT id FROM categories WHERE id <> ? AND name = ? COLLATE NOCASE").get(id, name);
  if (clash) throw httpError(409, "同じ名前のカテゴリがすでにあります。");
  const result = db.prepare("UPDATE categories SET name = ?, updated_at = ? WHERE id = ?").run(name, nowIso(), id);
  if (!result.changes) throw httpError(404, "カテゴリが見つかりません。");
  return getState();
}

// カテゴリだけ削除し、中のプロジェクトは未分類へ (記録は消さない)
function deleteCategory(id) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const clashes = db.prepare(`
      SELECT p.name FROM projects p
      WHERE p.category_id = ?
        AND EXISTS (SELECT 1 FROM projects u WHERE u.category_id IS NULL AND u.name = p.name COLLATE NOCASE)
    `).all(id);
    if (clashes.length) {
      throw httpError(409, `未分類に同じ名前のプロジェクトがあります: ${clashes.map((row) => row.name).join(", ")}`);
    }
    db.prepare("UPDATE projects SET category_id = NULL, updated_at = ? WHERE category_id = ?").run(nowIso(), id);
    const result = db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    if (!result.changes) throw httpError(404, "カテゴリが見つかりません。");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getState();
}

function deleteProject(id) {
  const timer = getTimerRaw();
  if (timer.project_id === id && timer.status !== "IDLE") {
    throw httpError(409, "計測中のプロジェクトは削除できません。先にストップしてください。");
  }
  // 記録を保管 (CSV) に移してからプロジェクトを削除する
  let months = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare(`${selectEntriesWithName} WHERE e.project_id = ?`).all(id);
    months = moveToArchive(rows, { addToTotal: false });
    const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    if (!result.changes) throw httpError(404, "プロジェクトが見つかりません。");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  for (const month of months) writeMonthCsv(month);
  return getState();
}

function updateEntry(id, body) {
  const previousEntry = db.prepare("SELECT project_id FROM time_entries WHERE id = ?").get(id);
  if (!previousEntry) throw httpError(404, "履歴が見つかりません。");

  const projectId = String(body.projectId || "");
  const startedAt = parseIso(body.startedAt, "開始日時が不正です。");
  const endedAt = parseIso(body.endedAt, "終了日時が不正です。");
  if (endedAt < startedAt) throw httpError(400, "終了日時は開始日時より後にしてください。");

  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) throw httpError(400, "プロジェクトが見つかりません。");

  const elapsedSeconds = secondsBetween(startedAt.toISOString(), endedAt.toISOString());
  const activeSeconds = validateActiveSeconds(body.activeSeconds, elapsedSeconds);
  const pausedSeconds = elapsedSeconds - activeSeconds;
  const now = nowIso();
  const result = db.prepare(`
    UPDATE time_entries
    SET project_id = ?, started_at = ?, ended_at = ?, active_seconds = ?,
        paused_seconds = ?, updated_at = ?
    WHERE id = ?
  `).run(projectId, startedAt.toISOString(), endedAt.toISOString(), activeSeconds, pausedSeconds, now, id);

  if (!result.changes) throw httpError(404, "履歴が見つかりません。");
  db.prepare("UPDATE projects SET updated_at = ? WHERE id IN (?, ?)").run(now, projectId, previousEntry.project_id);
  return getState();
}

function deleteEntry(id) {
  const entry = db.prepare("SELECT project_id FROM time_entries WHERE id = ?").get(id);
  if (!entry) throw httpError(404, "履歴が見つかりません。");
  db.prepare("DELETE FROM time_entries WHERE id = ?").run(id);
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(nowIso(), entry.project_id);
  return getState();
}

function parseIso(value, message) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw httpError(400, message);
  return date;
}

function validateActiveSeconds(value, elapsedSeconds) {
  const activeSeconds = Number(value);
  if (!Number.isFinite(activeSeconds) || activeSeconds < 0) {
    throw httpError(400, "作業時間が不正です。");
  }
  const rounded = Math.floor(activeSeconds);
  if (rounded > elapsedSeconds) {
    throw httpError(400, "作業時間は開始から終了までの時間以下にしてください。");
  }
  return rounded;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "リクエストの形式が不正です。");
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

async function serveStatic(pathname, response) {
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = safePath === "\\" || safePath === "/" || safePath === "." || safePath === ""
    ? join(publicDir, "index.html")
    : join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) throw httpError(403, "Forbidden");

  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json; charset=utf-8"
  };
  const content = await readFile(filePath);
  response.writeHead(200, { "content-type": contentTypes[extname(filePath)] || "application/octet-stream" });
  response.end(content);
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;

  if (pathname === "/api/health") return sendJson(response, 200, { ok: true });
  if (pathname === "/api/state" && request.method === "GET") return sendJson(response, 200, getState());

  if (pathname === "/api/timer/start" && request.method === "POST") return sendJson(response, 200, startTimer(await readJson(request)));
  if (pathname === "/api/timer/pause" && request.method === "POST") return sendJson(response, 200, pauseTimer());
  if (pathname === "/api/timer/resume" && request.method === "POST") return sendJson(response, 200, resumeTimer());
  if (pathname === "/api/timer/stop" && request.method === "POST") return sendJson(response, 200, stopTimer());

  if (pathname === "/api/entries" && request.method === "POST") return sendJson(response, 200, createEntry(await readJson(request)));

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && request.method === "PUT") return sendJson(response, 200, updateProject(projectMatch[1], await readJson(request)));
  if (projectMatch && request.method === "DELETE") return sendJson(response, 200, deleteProject(projectMatch[1]));

  const categoryMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
  if (categoryMatch && request.method === "PUT") return sendJson(response, 200, updateCategory(categoryMatch[1], await readJson(request)));
  if (categoryMatch && request.method === "DELETE") return sendJson(response, 200, deleteCategory(categoryMatch[1]));

  const entryMatch = pathname.match(/^\/api\/entries\/([^/]+)$/);
  if (entryMatch && request.method === "PUT") return sendJson(response, 200, updateEntry(entryMatch[1], await readJson(request)));
  if (entryMatch && request.method === "DELETE") return sendJson(response, 200, deleteEntry(entryMatch[1]));

  if (request.method === "GET") return serveStatic(pathname, response);
  throw httpError(404, "Not found");
}

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    const status = error.status || 500;
    sendJson(response, status, { error: status === 500 ? "保存データの読み込みまたは処理に失敗しました。" : error.message });
    if (status === 500) console.error(error);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Work Time Tracker: http://127.0.0.1:${port}`);
  console.log(`SQLite: ${dbPath}`);
});

archiveOldEntries();
ensureMonthCsvs();
setInterval(archiveOldEntries, 6 * 60 * 60 * 1000);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    db.close();
    process.exit(0);
  });
}
