// LittleJot — local web app: capture thoughts + track tasks + AI summaries.
// Run: `node server/index.js` (or `npm start`). Then open http://localhost:4174
//
// Two modes:
// - Single-user (default): one data store under DATA_DIR, activity tracking +
//   scheduled summaries on. This is the local desktop experience.
// - Multi-user (MULTIUSER=on): for public hosting. Each visitor gets an isolated
//   workspace keyed off an HttpOnly cookie, the host-local activity tracker and
//   the single-user scheduler are disabled, and the AI endpoints are rate-limited
//   so one shared API key can't be abused.

import express from "express";
import path from "node:path";
import crypto from "node:crypto";
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

// --- mode flags ------------------------------------------------------------
const MULTIUSER = (process.env.MULTIUSER || "off").toLowerCase() === "on";
const TRACKING_ON = (process.env.TRACKING || "on").toLowerCase() !== "off" && !MULTIUSER;
const SCHEDULER_ON = !MULTIUSER;
const SCHEDULE = process.env.SUMMARY_SCHEDULE || "12:00,18:00,21:00";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- per-visitor workspace (multi-user mode) -------------------------------
// In single-user mode req.workspace is "" and all storage lives under DATA_DIR,
// exactly as before. In multi-user mode each browser is assigned a random
// workspace id stored in an HttpOnly cookie; storage is isolated per workspace.
const WS_RE = /^[a-f0-9]{32}$/;
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
app.use((req, res, next) => {
  if (!MULTIUSER) {
    req.workspace = "";
    return next();
  }
  const cookies = parseCookies(req);
  let ws = cookies.nb_ws;
  if (!ws || !WS_RE.test(ws)) {
    ws = crypto.randomBytes(16).toString("hex");
    res.append(
      "Set-Cookie",
      `nb_ws=${ws}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`
    );
  }
  req.workspace = ws;
  next();
});

app.use(express.static(PUBLIC_DIR));

// Serve screenshots from the requesting visitor's workspace only (so one
// visitor can never read another's). No-op in practice on hosted multi-user
// since the host-local tracker is off there, but kept correct.
app.get("/data/screenshots/:date/:file", (req, res) => {
  const { date, file } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || /[\\/]/.test(file) || file.includes("..")) {
    return res.status(400).end();
  }
  const base = req.workspace
    ? path.join(getDataDir(), "workspaces", req.workspace, "screenshots", date)
    : path.join(getDataDir(), "screenshots", date);
  res.sendFile(path.join(base, file), (err) => {
    if (err) res.status(404).end();
  });
});

// --- AI rate limiting (multi-user only) ------------------------------------
// Protects the shared API key. Sliding window per workspace; in-memory, so it
// resets on redeploy — fine for a demo deployment.
const aiHits = new Map(); // ws -> [timestamps]
const AI_PER_HOUR = parseInt(process.env.AI_PER_HOUR || "40", 10);
const AI_PER_MIN = parseInt(process.env.AI_PER_MIN || "8", 10);
function aiRateLimited(ws) {
  if (!MULTIUSER) return false;
  const now = Date.now();
  const key = ws || "anon";
  const recent = (aiHits.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
  const perMin = recent.filter((t) => now - t < 60 * 1000).length;
  if (recent.length >= AI_PER_HOUR || perMin >= AI_PER_MIN) {
    aiHits.set(key, recent);
    return true;
  }
  recent.push(now);
  aiHits.set(key, recent);
  return false;
}

// --- API -------------------------------------------------------------------
app.get("/api/today", async (req, res) => {
  const date = todayString();
  const day = await loadDay(date, req.workspace);
  res.json({
    ...day,
    config: {
      dataDir: MULTIUSER ? "per-visitor" : getDataDir(),
      hasLLM: Boolean(process.env.ANTHROPIC_API_KEY),
      model: process.env.ANTHROPIC_MODEL || null,
      schedule: SCHEDULER_ON ? SCHEDULE : "off",
      multiuser: MULTIUSER,
    },
  });
});

app.post("/api/entries", async (req, res) => {
  try {
    const { text, tag } = req.body || {};
    const entry = await addEntry(todayString(), { text, tag }, req.workspace);
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/tasks/start", async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const result = await startTask(todayString(), name, req.workspace);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tasks/stop", async (req, res) => {
  try {
    const stopped = await stopCurrentTask(todayString(), req.workspace);
    res.json({ stopped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/summarize", async (req, res) => {
  try {
    if (aiRateLimited(req.workspace)) {
      return res.status(429).json({ error: "Rate limit reached. Try again in a bit." });
    }
    const slot = (req.body && req.body.slot) || "adhoc";
    const lang = (req.body && req.body.lang) || "en";
    const day = await loadDay(todayString(), req.workspace);
    const { text, model } = await summarize(day, slot, lang);
    const saved = await addSummary(todayString(), { slot, text, model }, req.workspace);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conversational Q&A about today ("what did I do in the past hour?").
app.post("/api/ask", async (req, res) => {
  try {
    if (aiRateLimited(req.workspace)) {
      return res.status(429).json({ error: "Rate limit reached. Try again in a bit." });
    }
    const { question, history, lang } = req.body || {};
    const day = await loadDay(todayString(), req.workspace);
    const result = await ask(day, question, history, lang || "en");
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Activity tracking API ---
app.post("/api/activities/apps", async (req, res) => {
  try {
    const { bundleId, name, durationMs } = req.body || {};
    const activity = await addAppActivity(todayString(), { bundleId, name, durationMs }, req.workspace);
    res.json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/activities/keylogs", async (req, res) => {
  try {
    const { app, keys, count } = req.body || {};
    const activity = await addKeylogActivity(todayString(), { app, keys, count }, req.workspace);
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
      await saveScreenshotFile(date, filename, req.file.buffer, req.workspace);
    }

    const activity = await addScreenshotActivity(date, { filename }, req.workspace);
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
    const activities = await loadActivities(date, req.workspace);
    res.json(activities);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- start -----------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "4174", 10);
app.listen(PORT, () => {
  console.log(`LittleJot running at http://localhost:${PORT}`);
  console.log(`  mode:            ${MULTIUSER ? "MULTI-USER (per-visitor workspaces)" : "single-user (local)"}`);
  console.log(`  data dir:        ${getDataDir()}`);
  console.log(`  AI summaries:    ${process.env.ANTHROPIC_API_KEY ? "ON (" + (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6") + ")" : "OFF (set ANTHROPIC_API_KEY in .env)"}`);
  console.log(`  schedule:        ${SCHEDULER_ON ? SCHEDULE : "off (multi-user)"}`);
  console.log(`  activity track:  ${TRACKING_ON ? "ON (needs Accessibility + Screen Recording perms)" : "OFF" + (MULTIUSER ? " (multi-user)" : " (TRACKING=off)")}`);
});

if (SCHEDULER_ON) startScheduler({ schedule: SCHEDULE });
if (TRACKING_ON) startTracking();
