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
    // Forward-looking: the morning plan for this day (set by the planner or by
    // hand). Backward-looking: the evening review. Both are null until made.
    plan: null,
    review: null,
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

// --- Daily plan & review --------------------------------------------------
// A plan is { id, ts, model, headline, items:[{id,text,done,source}], note }.
// A review is { id, ts, model, text }.

function normalizeItems(items, defaultSource) {
  return (items || []).map((it) =>
    typeof it === "string"
      ? { id: newId(), text: it, done: false, source: defaultSource || "ai" }
      : { id: it.id || newId(), text: it.text, done: Boolean(it.done), source: it.source || defaultSource || "ai" }
  );
}

export async function setDayPlan(date, plan) {
  const day = await loadDay(date);
  // Regenerating replaces AI items but keeps the user's hand-added ones (and
  // the done-state of anything that survives), so a re-run never eats edits.
  const manual = (day.plan?.items || []).filter((i) => i.source === "manual");
  day.plan = {
    id: day.plan?.id || newId(),
    ts: new Date().toISOString(),
    model: plan.model || null,
    headline: plan.headline || day.plan?.headline || "",
    items: [...normalizeItems(plan.items, plan.source), ...manual],
    note: plan.note || "",
  };
  await saveDay(day);
  return day.plan;
}

export async function addPlanItem(date, text) {
  const day = await loadDay(date);
  if (!day.plan) day.plan = { id: newId(), ts: new Date().toISOString(), model: null, headline: "", items: [], note: "" };
  const item = { id: newId(), text: String(text || "").trim(), done: false, source: "manual" };
  if (!item.text) throw new Error("Plan item text is required");
  day.plan.items.push(item);
  await saveDay(day);
  return item;
}

export async function togglePlanItem(date, itemId, done) {
  const day = await loadDay(date);
  const item = day.plan?.items?.find((i) => i.id === itemId);
  if (!item) throw new Error("Plan item not found");
  item.done = typeof done === "boolean" ? done : !item.done;
  await saveDay(day);
  return item;
}

export async function setDayReview(date, review) {
  const day = await loadDay(date);
  day.review = {
    id: day.review?.id || newId(),
    ts: new Date().toISOString(),
    model: review.model || null,
    text: review.text || "",
  };
  await saveDay(day);
  return day.review;
}

// --- ISO week helpers -----------------------------------------------------

// Local YYYY-MM-DD shifted by N days.
export function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return todayString(dt);
}

// ISO-8601 week id, e.g. "2026-W26". Monday-based; weeks belong to the year of
// their Thursday.
export function isoWeekId(dateStr = todayString()) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (dt.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3); // move to Thursday
  const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((dt - firstThursday) / (7 * 86400000));
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Monday & Sunday (local YYYY-MM-DD) of the week containing dateStr, plus the
// 7 day-strings in order.
export function weekRangeForDate(dateStr = todayString()) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dayNum = (dt.getDay() + 6) % 7; // Mon=0
  const monday = new Date(dt);
  monday.setDate(dt.getDate() - dayNum);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(monday);
    dd.setDate(monday.getDate() + i);
    dates.push(todayString(dd));
  }
  return { monday: dates[0], sunday: dates[6], dates };
}

// --- Weekly plan & review storage (one file per ISO week) -----------------

function weekPath(weekId) {
  return path.join(DATA_DIR, "weeks", `${weekId}.json`);
}

function emptyWeek(weekId, range) {
  return {
    weekId,
    start: range?.monday || null,
    end: range?.sunday || null,
    plan: null, // { id, ts, model, theme, items:[{id,text,done,source}], note }
    review: null, // { id, ts, model, text }
  };
}

export async function loadWeek(weekId, range) {
  await fs.mkdir(path.join(DATA_DIR, "weeks"), { recursive: true });
  try {
    const raw = await fs.readFile(weekPath(weekId), "utf8");
    return { ...emptyWeek(weekId, range), ...JSON.parse(raw) };
  } catch (err) {
    if (err.code === "ENOENT") return emptyWeek(weekId, range);
    throw err;
  }
}

async function saveWeek(week) {
  await fs.mkdir(path.join(DATA_DIR, "weeks"), { recursive: true });
  const tmp = weekPath(week.weekId) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(week, null, 2), "utf8");
  await fs.rename(tmp, weekPath(week.weekId));
}

export async function setWeekPlan(weekId, range, plan) {
  const week = await loadWeek(weekId, range);
  const manual = (week.plan?.items || []).filter((i) => i.source === "manual");
  week.plan = {
    id: week.plan?.id || newId(),
    ts: new Date().toISOString(),
    model: plan.model || null,
    theme: plan.theme || plan.headline || week.plan?.theme || "",
    items: [...normalizeItems(plan.items, plan.source), ...manual],
    note: plan.note || "",
  };
  await saveWeek(week);
  return week.plan;
}

export async function addWeekPriority(weekId, range, text) {
  const week = await loadWeek(weekId, range);
  if (!week.plan) week.plan = { id: newId(), ts: new Date().toISOString(), model: null, theme: "", items: [], note: "" };
  const item = { id: newId(), text: String(text || "").trim(), done: false, source: "manual" };
  if (!item.text) throw new Error("Priority text is required");
  week.plan.items.push(item);
  await saveWeek(week);
  return item;
}

export async function toggleWeekPriority(weekId, range, itemId, done) {
  const week = await loadWeek(weekId, range);
  const item = week.plan?.items?.find((i) => i.id === itemId);
  if (!item) throw new Error("Priority not found");
  item.done = typeof done === "boolean" ? done : !item.done;
  await saveWeek(week);
  return item;
}

export async function setWeekReview(weekId, range, review) {
  const week = await loadWeek(weekId, range);
  week.review = {
    id: week.review?.id || newId(),
    ts: new Date().toISOString(),
    model: review.model || null,
    text: review.text || "",
  };
  await saveWeek(week);
  return week.review;
}

// --- Routines config ------------------------------------------------------
// Persisted overrides (mainly enabled/disabled + custom times) layered over the
// defaults the routines engine ships with.

function routinesPath() {
  return path.join(DATA_DIR, "routines.json");
}

export async function loadRoutinesConfig() {
  await ensureDir();
  try {
    const raw = await fs.readFile(routinesPath(), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function saveRoutinesConfig(config) {
  await ensureDir();
  const tmp = routinesPath() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
  await fs.rename(tmp, routinesPath());
  return config;
}

// --- Feed -----------------------------------------------------------------
// A rolling log of proactive cards the routines engine produced ("Bird drafted
// your daily plan"), newest last. Capped so the file stays small.

function feedPath() {
  return path.join(DATA_DIR, "feed.json");
}

export async function loadFeed() {
  await ensureDir();
  try {
    const raw = await fs.readFile(feedPath(), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export async function pushFeed({ type, title, detail, ref }) {
  const feed = await loadFeed();
  const card = {
    id: newId(),
    ts: new Date().toISOString(),
    type,
    title,
    detail: detail || "",
    ref: ref || null,
  };
  feed.push(card);
  const trimmed = feed.slice(-100);
  const tmp = feedPath() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(trimmed, null, 2), "utf8");
  await fs.rename(tmp, feedPath());
  return card;
}
