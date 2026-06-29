// Per-day JSON file storage. Each day file has the shape:
// {
//   date: "YYYY-MM-DD",
//   entries: [{ id, ts, text, tag? }],
//   tasks:   [{ id, name, startTs, endTs|null, durationMs|null }],
//   summaries: [{ id, ts, slot, text, model }],
//   activities: {
//     apps: [{ id, ts, bundleId, name, durationMs }],
//     keylogs: [{ id, ts, app, keys, count }],
//     screenshots: [{ id, ts, filename }]
//   }
// }
//
// We read+write the whole file each time. At human scale (a few thousand entries
// per day max), this is more than fast enough and trivially syncs through
// iCloud/Dropbox without locking concerns.
//
// Multi-user: every function takes an optional trailing `ws` (workspace id). When
// empty (the default — single-user local mode), files live directly under
// DATA_DIR, exactly as before. When set (public multi-user mode), each visitor's
// data is isolated under DATA_DIR/workspaces/<ws>/, keyed off an HttpOnly cookie.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

let DATA_DIR = path.resolve(process.cwd(), "data");

export function setDataDir(dir) {
  DATA_DIR = path.resolve(dir);
}

export function getDataDir() {
  return DATA_DIR;
}

export function todayString(now = new Date()) {
  // Local YYYY-MM-DD so day boundaries match the user's wall clock.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Resolve the base directory for a workspace. An empty/invalid ws falls back to
// the root DATA_DIR (single-user mode). ws is restricted to hex so it can never
// escape the data dir via path traversal.
function wsDir(ws) {
  if (ws && /^[a-f0-9]{8,64}$/.test(ws)) {
    return path.join(DATA_DIR, "workspaces", ws);
  }
  return DATA_DIR;
}

function dayPath(date, ws) {
  return path.join(wsDir(ws), `${date}.json`);
}

async function ensureDir(ws) {
  await fs.mkdir(wsDir(ws), { recursive: true });
}

function emptyDay(date) {
  return {
    date,
    plan: "",
    entries: [],
    tasks: [],
    summaries: [],
    activities: {
      apps: [],
      windows: [],
      keylogs: [],
      screenshots: [],
    },
  };
}

export async function loadDay(date, ws = "") {
  await ensureDir(ws);
  try {
    const raw = await fs.readFile(dayPath(date, ws), "utf8");
    const parsed = JSON.parse(raw);
    // Migrate / fill in missing keys defensively. The activities sub-object
    // needs a *deep* merge — a shallow spread would let an old file's
    // `activities` (missing e.g. `windows`) clobber the defaults entirely.
    const base = emptyDay(date);
    const day = { ...base, ...parsed };
    day.activities = { ...base.activities, ...(parsed.activities || {}) };
    return day;
  } catch (err) {
    if (err.code === "ENOENT") return emptyDay(date);
    throw err;
  }
}

export async function saveDay(day, ws = "") {
  await ensureDir(ws);
  const tmp = dayPath(day.date, ws) + ".tmp";
  // Atomic write: write to .tmp then rename, so an interrupted write
  // never leaves a half-written file in iCloud/Dropbox.
  await fs.writeFile(tmp, JSON.stringify(day, null, 2), "utf8");
  await fs.rename(tmp, dayPath(day.date, ws));
}

export function newId() {
  return crypto.randomBytes(8).toString("hex");
}

export async function addEntry(date, { text, tag }, ws = "") {
  const day = await loadDay(date, ws);
  const entry = {
    id: newId(),
    ts: new Date().toISOString(),
    text: String(text || "").trim(),
    tag: tag || null,
  };
  if (!entry.text) throw new Error("Entry text is required");
  day.entries.push(entry);
  await saveDay(day, ws);
  return entry;
}

export async function startTask(date, name, ws = "") {
  const day = await loadDay(date, ws);
  // Auto-stop any currently-open task before starting a new one.
  const open = day.tasks.find((t) => t.endTs == null);
  const now = new Date().toISOString();
  if (open) {
    open.endTs = now;
    open.durationMs = new Date(open.endTs) - new Date(open.startTs);
  }
  const task = {
    id: newId(),
    name: String(name || "Untitled").trim(),
    startTs: now,
    endTs: null,
    durationMs: null,
  };
  day.tasks.push(task);
  await saveDay(day, ws);
  return { task, autoClosed: open || null };
}

export async function stopCurrentTask(date, ws = "") {
  const day = await loadDay(date, ws);
  const open = day.tasks.find((t) => t.endTs == null);
  if (!open) return null;
  open.endTs = new Date().toISOString();
  open.durationMs = new Date(open.endTs) - new Date(open.startTs);
  await saveDay(day, ws);
  return open;
}

export async function addSummary(date, { slot, text, model }, ws = "") {
  const day = await loadDay(date, ws);
  const summary = {
    id: newId(),
    ts: new Date().toISOString(),
    slot: slot || "adhoc",
    text,
    model: model || null,
  };
  day.summaries.push(summary);
  await saveDay(day, ws);
  return summary;
}

// --- Activity tracking ---
export async function addAppActivity(date, { bundleId, name, durationMs }, ws = "") {
  const day = await loadDay(date, ws);
  const activity = {
    id: newId(),
    ts: new Date().toISOString(),
    bundleId,
    name,
    durationMs,
  };
  day.activities.apps.push(activity);
  await saveDay(day, ws);
  return activity;
}

export async function addWindowActivity(date, { app, bundleId, title, durationMs }, ws = "") {
  const day = await loadDay(date, ws);
  const activity = {
    id: newId(),
    ts: new Date().toISOString(),
    app,
    bundleId: bundleId || null,
    title,
    durationMs,
  };
  day.activities.windows.push(activity);
  await saveDay(day, ws);
  return activity;
}

export async function addKeylogActivity(date, { app, keys, count }, ws = "") {
  const day = await loadDay(date, ws);
  const activity = {
    id: newId(),
    ts: new Date().toISOString(),
    app,
    keys,
    count,
  };
  day.activities.keylogs.push(activity);
  await saveDay(day, ws);
  return activity;
}

export async function addScreenshotActivity(date, { filename }, ws = "") {
  const day = await loadDay(date, ws);
  const activity = {
    id: newId(),
    ts: new Date().toISOString(),
    filename,
  };
  day.activities.screenshots.push(activity);
  await saveDay(day, ws);
  return activity;
}

export async function saveScreenshotFile(date, filename, buffer, ws = "") {
  const screenshotsDir = path.join(wsDir(ws), "screenshots", date);
  await fs.mkdir(screenshotsDir, { recursive: true });
  const filepath = path.join(screenshotsDir, filename);
  await fs.writeFile(filepath, buffer);
  return filepath;
}

export async function loadActivities(date, ws = "") {
  const day = await loadDay(date, ws);
  return day.activities;
}

// --- Daily plan (what you intend to do today) ---
export async function setDayPlan(date, text, ws = "") {
  const day = await loadDay(date, ws);
  day.plan = String(text == null ? "" : text);
  await saveDay(day, ws);
  return day.plan;
}

// --- Weekly: plan + summaries live in a per-week file keyed by the Monday. ---
export function weekStartString(now = new Date()) {
  const d = new Date(now);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  d.setDate(d.getDate() - dow);
  return todayString(d);
}

function weekPath(weekStart, ws) {
  return path.join(wsDir(ws), `week-${weekStart}.json`);
}

function emptyWeek(weekStart) {
  return { weekStart, plan: "", summaries: [] };
}

export async function loadWeek(weekStart, ws = "") {
  await ensureDir(ws);
  try {
    const raw = await fs.readFile(weekPath(weekStart, ws), "utf8");
    return { ...emptyWeek(weekStart), ...JSON.parse(raw) };
  } catch (err) {
    if (err.code === "ENOENT") return emptyWeek(weekStart);
    throw err;
  }
}

async function saveWeek(week, ws = "") {
  await ensureDir(ws);
  const tmp = weekPath(week.weekStart, ws) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(week, null, 2), "utf8");
  await fs.rename(tmp, weekPath(week.weekStart, ws));
}

export async function setWeekPlan(weekStart, text, ws = "") {
  const week = await loadWeek(weekStart, ws);
  week.plan = String(text == null ? "" : text);
  await saveWeek(week, ws);
  return week.plan;
}

export async function addWeekSummary(weekStart, { text, model }, ws = "") {
  const week = await loadWeek(weekStart, ws);
  const summary = { id: newId(), ts: new Date().toISOString(), text, model: model || null };
  week.summaries.push(summary);
  await saveWeek(week, ws);
  return summary;
}

// Load the 7 day-files (Mon→Sun) for a week. Missing days come back empty.
export async function loadWeekDays(weekStart, ws = "") {
  const start = new Date(weekStart + "T00:00:00");
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(await loadDay(todayString(d), ws));
  }
  return days;
}
