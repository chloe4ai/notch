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

function dayPath(date) {
  return path.join(DATA_DIR, `${date}.json`);
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function emptyDay(date) {
  return {
    date,
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

export async function loadDay(date) {
  await ensureDir();
  try {
    const raw = await fs.readFile(dayPath(date), "utf8");
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

export async function saveDay(day) {
  await ensureDir();
  const tmp = dayPath(day.date) + ".tmp";
  // Atomic write: write to .tmp then rename, so an interrupted write
  // never leaves a half-written file in iCloud/Dropbox.
  await fs.writeFile(tmp, JSON.stringify(day, null, 2), "utf8");
  await fs.rename(tmp, dayPath(day.date));
}

export function newId() {
  return crypto.randomBytes(8).toString("hex");
}

export async function addEntry(date, { text, tag }) {
  const day = await loadDay(date);
  const entry = {
    id: newId(),
    ts: new Date().toISOString(),
    text: String(text || "").trim(),
    tag: tag || null,
  };
  if (!entry.text) throw new Error("Entry text is required");
  day.entries.push(entry);
  await saveDay(day);
  return entry;
}

export async function startTask(date, name) {
  const day = await loadDay(date);
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
  await saveDay(day);
  return { task, autoClosed: open || null };
}

export async function stopCurrentTask(date) {
  const day = await loadDay(date);
  const open = day.tasks.find((t) => t.endTs == null);
  if (!open) return null;
  open.endTs = new Date().toISOString();
  open.durationMs = new Date(open.endTs) - new Date(open.startTs);
  await saveDay(day);
  return open;
}

export async function addSummary(date, { slot, text, model }) {
  const day = await loadDay(date);
  const summary = {
    id: newId(),
    ts: new Date().toISOString(),
    slot: slot || "adhoc",
    text,
    model: model || null,
  };
  day.summaries.push(summary);
  await saveDay(day);
  return summary;
}

// --- Activity tracking ---
export async function addAppActivity(date, { bundleId, name, durationMs }) {
  const day = await loadDay(date);
  const activity = {
    id: newId(),
    ts: new Date().toISOString(),
    bundleId,
    name,
    durationMs,
  };
  day.activities.apps.push(activity);
  await saveDay(day);
  return activity;
}

export async function addWindowActivity(date, { app, bundleId, title, durationMs }) {
  const day = await loadDay(date);
  const activity = {
    id: newId(),
    ts: new Date().toISOString(),
    app,
    bundleId: bundleId || null,
    title,
    durationMs,
  };
  day.activities.windows.push(activity);
  await saveDay(day);
  return activity;
}

export async function addKeylogActivity(date, { app, keys, count }) {
  const day = await loadDay(date);
  const activity = {
    id: newId(),
    ts: new Date().toISOString(),
    app,
    keys,
    count,
  };
  day.activities.keylogs.push(activity);
  await saveDay(day);
  return activity;
}

export async function addScreenshotActivity(date, { filename }) {
  const day = await loadDay(date);
  const activity = {
    id: newId(),
    ts: new Date().toISOString(),
    filename,
  };
  day.activities.screenshots.push(activity);
  await saveDay(day);
  return activity;
}

export async function saveScreenshotFile(date, filename, buffer) {
  const screenshotsDir = path.join(DATA_DIR, "screenshots", date);
  await fs.mkdir(screenshotsDir, { recursive: true });
  const filepath = path.join(screenshotsDir, filename);
  await fs.writeFile(filepath, buffer);
  return filepath;
}

export async function loadActivities(date) {
  const day = await loadDay(date);
  return day.activities;
}
