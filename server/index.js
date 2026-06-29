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
} from "./storage.js";
import { summarize, ask } from "./summarizer.js";
import { startScheduler } from "./scheduler.js";
import { startTracking, toggleTracking, setEnabled, getStatus } from "./tracker.js";

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
    const lang = (req.body && req.body.lang) || "zh";
    const day = await loadDay(todayString());
    const { text, model } = await summarize(day, slot, lang);
    const saved = await addSummary(todayString(), { slot, text, model });
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conversational Q&A about today ("what did I do in the past hour?").
app.post("/api/ask", async (req, res) => {
  try {
    const { question, history, lang } = req.body || {};
    const day = await loadDay(todayString());
    const result = await ask(day, question, history, lang || "zh");
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
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
if (TRACKING_ON) startTracking();
