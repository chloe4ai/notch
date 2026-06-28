// LittleJot — local web app: capture thoughts + track tasks + AI summaries.
// Run: `node server/index.js` (or `npm start`). Then open http://localhost:4174

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import multer from "multer";

import {
  setDataDir,
  getDataDir,
  loadDay,
  addEntry,
  startTask,
  stopCurrentTask,
  addSummary,
  addAppActivity,
  addKeylogActivity,
  addScreenshotActivity,
  saveScreenshotFile,
  loadActivities,
  todayString,
  addPlanItem,
  togglePlanItem,
  isoWeekId,
  weekRangeForDate,
  loadWeek,
  addWeekPriority,
  toggleWeekPriority,
  loadFeed,
} from "./storage.js";
import { summarize, ask } from "./summarizer.js";
import { startScheduler } from "./scheduler.js";
import { startTracking, toggleTracking, setEnabled, getStatus } from "./tracker.js";
import {
  buildDailyPlan,
  buildDailyReview,
  buildWeeklyPlan,
  buildWeeklyReview,
} from "./planner.js";
import { getRoutines, updateRoutine, runRoutine, startRoutines } from "./routines.js";
import { fetchCalendarSafe, eventsForDate, eventsForWeek } from "./calendar.js";

// Configure multer for screenshot uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

// --- minimal .env loader (avoids adding dotenv as a dep) -------------------
async function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), ".env");
  try {
    const raw = await fs.readFile(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m) continue;
      const [, k, v] = m;
      if (process.env[k] == null) {
        // strip optional quotes
        process.env[k] = v.replace(/^["']|["']$/g, "");
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("[.env] failed to load:", err.message);
  }
}

await loadEnvFile();

// Resolve DATA_DIR (supports ~ and relative paths).
{
  let dir = process.env.DATA_DIR || "./data";
  if (dir.startsWith("~")) dir = path.join(process.env.HOME || "", dir.slice(1));
  setDataDir(path.resolve(dir));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));
// Serve screenshots from data directory
app.use("/data/screenshots", express.static(path.join(getDataDir(), "screenshots")));

// --- API -------------------------------------------------------------------
app.get("/api/today", async (_req, res) => {
  const date = todayString();
  const day = await loadDay(date);
  res.json({
    ...day,
    config: {
      dataDir: getDataDir(),
      hasLLM: Boolean(process.env.ANTHROPIC_API_KEY),
      model: process.env.ANTHROPIC_MODEL || null,
      schedule: process.env.SUMMARY_SCHEDULE || "12:00,18:00,21:00",
      hasCalendar: Boolean(process.env.CALENDAR_ICS_URL),
      weekId: isoWeekId(date),
    },
  });
});

app.post("/api/entries", async (req, res) => {
  try {
    const { text, tag } = req.body || {};
    const entry = await addEntry(todayString(), { text, tag });
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/tasks/start", async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const result = await startTask(todayString(), name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tasks/stop", async (_req, res) => {
  try {
    const stopped = await stopCurrentTask(todayString());
    res.json({ stopped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/summarize", async (req, res) => {
  try {
    const slot = (req.body && req.body.slot) || "adhoc";
    const day = await loadDay(todayString());
    const { text, model } = await summarize(day, slot);
    const saved = await addSummary(todayString(), { slot, text, model });
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conversational Q&A about today ("what did I do in the past hour?").
app.post("/api/ask", async (req, res) => {
  try {
    const { question, history } = req.body || {};
    const day = await loadDay(todayString());
    const result = await ask(day, question, history);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Plan / Review / Routines (Little-Bird-style planning) -----------------

// Daily plan: generate (AI), read, add a manual item, toggle an item done.
app.post("/api/plan/today/generate", async (_req, res) => {
  try {
    const plan = await buildDailyPlan(todayString());
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/plan/today/items", async (req, res) => {
  try {
    const item = await addPlanItem(todayString(), (req.body || {}).text);
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/plan/today/items/:id/toggle", async (req, res) => {
  try {
    const { done } = req.body || {};
    const item = await togglePlanItem(todayString(), req.params.id, done);
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Daily review.
app.post("/api/review/today/generate", async (_req, res) => {
  try {
    const review = await buildDailyReview(todayString());
    res.json(review);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Weekly plan + review for the current (or ?date=) week.
function weekCtxFor(dateStr) {
  const date = dateStr || todayString();
  return { weekId: isoWeekId(date), range: weekRangeForDate(date) };
}

app.get("/api/week", async (req, res) => {
  try {
    const { weekId, range } = weekCtxFor(req.query.date);
    const week = await loadWeek(weekId, range);
    res.json({ ...week, range });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/week/plan/generate", async (req, res) => {
  try {
    const { weekId, range } = weekCtxFor((req.body || {}).date);
    const plan = await buildWeeklyPlan(weekId, range);
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/week/plan/items", async (req, res) => {
  try {
    const { weekId, range } = weekCtxFor((req.body || {}).date);
    const item = await addWeekPriority(weekId, range, (req.body || {}).text);
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/week/plan/items/:id/toggle", async (req, res) => {
  try {
    const { weekId, range } = weekCtxFor((req.body || {}).date);
    const item = await toggleWeekPriority(weekId, range, req.params.id, (req.body || {}).done);
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/week/review/generate", async (req, res) => {
  try {
    const { weekId, range } = weekCtxFor((req.body || {}).date);
    const review = await buildWeeklyReview(weekId, range);
    res.json(review);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Calendar feed (forward-looking integration).
app.get("/api/calendar/today", async (_req, res) => {
  try {
    const cal = await fetchCalendarSafe();
    res.json({ ok: cal.ok, reason: cal.reason || null, events: eventsForDate(cal.events, todayString()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/calendar/week", async (req, res) => {
  try {
    const { range } = weekCtxFor(req.query.date);
    const cal = await fetchCalendarSafe();
    res.json({ ok: cal.ok, reason: cal.reason || null, range, events: eventsForWeek(cal.events, range.monday, range.sunday) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Routines: list, toggle/update, run-now. Plus the proactive feed.
app.get("/api/routines", async (_req, res) => {
  try {
    res.json(await getRoutines());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/routines/:id", async (req, res) => {
  try {
    const updated = await updateRoutine(req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/routines/:id/run", async (req, res) => {
  try {
    const routines = await getRoutines();
    const routine = routines.find((r) => r.id === req.params.id);
    if (!routine) return res.status(404).json({ error: "routine not found" });
    const result = await runRoutine(routine.type);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/feed", async (_req, res) => {
  try {
    const feed = await loadFeed();
    res.json(feed.slice(-30).reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Activity tracking API ---
app.post("/api/activities/apps", async (req, res) => {
  try {
    const { bundleId, name, durationMs } = req.body || {};
    const activity = await addAppActivity(todayString(), { bundleId, name, durationMs });
    res.json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/activities/keylogs", async (req, res) => {
  try {
    const { app, keys, count } = req.body || {};
    const activity = await addKeylogActivity(todayString(), { app, keys, count });
    res.json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/activities/screenshots", upload.single("file"), async (req, res) => {
  try {
    const filename = req.body.filename || `screenshot_${Date.now()}.png`;
    const date = todayString();

    if (req.file) {
      await saveScreenshotFile(date, filename, req.file.buffer);
    }

    const activity = await addScreenshotActivity(date, { filename });
    res.json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tracker heartbeat - kept for backwards-compat with the old menu-bar app.
let lastHeartbeat = null;
app.post("/api/activities/heartbeat", (req, res) => {
  lastHeartbeat = Date.now();
  res.json({ ok: true, lastHeartbeat });
});

// IMPORTANT: /status must come before /:date to avoid being matched as a date.
// Tracking now runs inside this server, so status reflects the built-in tracker;
// the external heartbeat is still surfaced for the legacy tray app.
app.get("/api/activities/status", (_req, res) => {
  const status = getStatus();
  res.json({
    trackerConnected: status.running,
    ...status,
    lastHeartbeat,
  });
});

// Pause / resume the built-in tracker. Body: { enabled: bool } toggles to that
// state; omit `enabled` to flip.
app.post("/api/tracker/toggle", (req, res) => {
  const body = req.body || {};
  const enabled =
    typeof body.enabled === "boolean" ? setEnabled(body.enabled) : toggleTracking();
  res.json({ enabled, ...getStatus() });
});

app.get("/api/activities/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const activities = await loadActivities(date);
    res.json(activities);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- start -----------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "4174", 10);
const TRACKING_ON = (process.env.TRACKING || "on").toLowerCase() !== "off";
app.listen(PORT, () => {
  console.log(`LittleJot running at http://localhost:${PORT}`);
  console.log(`  data dir:        ${getDataDir()}`);
  console.log(`  AI summaries:    ${process.env.ANTHROPIC_API_KEY ? "ON (" + (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6") + ")" : "OFF (set ANTHROPIC_API_KEY in .env)"}`);
  console.log(`  schedule:        ${process.env.SUMMARY_SCHEDULE || "12:00,18:00,21:00"}`);
  console.log(`  activity track:  ${TRACKING_ON ? "ON (needs Accessibility + Screen Recording perms)" : "OFF (TRACKING=off)"}`);
});

startScheduler({ schedule: process.env.SUMMARY_SCHEDULE });
startRoutines();
if (TRACKING_ON) startTracking();
