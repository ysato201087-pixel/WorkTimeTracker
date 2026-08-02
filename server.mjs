import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
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

function publicProject(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    totalSeconds: Number(row.total_seconds || 0),
    lastWorkedAt: row.last_worked_at || null
  };
}

function getProjects() {
  return db.prepare(`
    WITH ranked_entries AS (
      SELECT
        e.*,
        ROW_NUMBER() OVER (
          PARTITION BY e.project_id
          ORDER BY e.started_at DESC, e.created_at DESC
        ) AS entry_rank
      FROM time_entries e
    )
    SELECT
      p.id,
      p.name,
      p.created_at,
      p.updated_at,
      COALESCE(SUM(e.active_seconds), 0) AS total_seconds,
      MAX(e.ended_at) AS last_worked_at
    FROM projects p
    LEFT JOIN ranked_entries e ON e.project_id = p.id AND e.entry_rank <= 10
    GROUP BY p.id
    ORDER BY LOWER(p.name)
  `).all().map(publicProject);
}

function getEntries() {
  return db.prepare(`
    WITH ranked_entries AS (
      SELECT
        e.*,
        ROW_NUMBER() OVER (
          PARTITION BY e.project_id
          ORDER BY e.started_at DESC, e.created_at DESC
        ) AS entry_rank
      FROM time_entries e
    )
    SELECT
      e.id,
      e.project_id,
      p.name AS project_name,
      e.started_at,
      e.ended_at,
      e.active_seconds,
      e.paused_seconds,
      e.created_at,
      e.updated_at
    FROM ranked_entries e
    JOIN projects p ON p.id = e.project_id
    WHERE e.entry_rank <= 10
    ORDER BY e.started_at DESC, e.created_at DESC
  `).all().map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
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
    SELECT t.*, p.name AS project_name
    FROM active_timer t
    LEFT JOIN projects p ON p.id = t.project_id
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
    startedAt: row.started_at || null,
    pausedAt: row.paused_at || null,
    totalPausedSeconds: pausedSeconds,
    activeSeconds: Math.max(0, elapsedSeconds),
    serverNow: now
  };
}

function getState() {
  return {
    projects: getProjects(),
    entries: getEntries(),
    activeTimer: publicTimer()
  };
}

function getOrCreateProject(name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw httpError(400, "プロジェクト名を入力してください。");

  const existing = db.prepare("SELECT * FROM projects WHERE name = ? COLLATE NOCASE").get(cleanName);
  if (existing) return existing;

  const now = nowIso();
  const id = randomUUID();
  db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, cleanName, now, now);
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

function startTimer(body) {
  const timer = getTimerRaw();
  if (timer.status !== "IDLE") {
    throw httpError(409, "すでにタイマーが動作しています。ストップしてから別のプロジェクトを開始してください。");
  }

  const project = getOrCreateProject(body.projectName);
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
    enforceEntryLimit(timer.project_id);
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
    enforceEntryLimit(projectId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getState();
}

function updateProject(id, body) {
  const name = String(body.name || "").trim();
  if (!name) throw httpError(400, "プロジェクト名を入力してください。");
  const now = nowIso();
  try {
    const result = db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id);
    if (!result.changes) throw httpError(404, "プロジェクトが見つかりません。");
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      throw httpError(409, "同じ名前のプロジェクトがすでに存在します。");
    }
    throw error;
  }
  return getState();
}

function deleteProject(id) {
  const timer = getTimerRaw();
  if (timer.project_id === id && timer.status !== "IDLE") {
    throw httpError(409, "計測中のプロジェクトは削除できません。先にストップしてください。");
  }
  const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  if (!result.changes) throw httpError(404, "プロジェクトが見つかりません。");
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
  enforceEntryLimit(projectId);
  if (previousEntry.project_id !== projectId) enforceEntryLimit(previousEntry.project_id);
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

function enforceEntryLimit(projectId) {
  db.prepare(`
    DELETE FROM time_entries
    WHERE project_id = ?
      AND id NOT IN (
        SELECT id
        FROM time_entries
        WHERE project_id = ?
        ORDER BY started_at DESC, created_at DESC
        LIMIT 10
      )
  `).run(projectId, projectId);
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
    ".svg": "image/svg+xml; charset=utf-8"
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

process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});
