// Routines: Notch's take on Little Bird's proactive "Routines". A small
// time-of-day engine that fires the planner on a schedule, writes the artifact,
// and drops a card in the feed so the app can surface "Bird drafted your daily
// plan" without the user asking. No cron lib — a once-a-minute tick, same shape
// as scheduler.js.
//
// Defaults: morning daily plan, evening daily review, Monday weekly plan, Friday
// weekly review. Users can disable any of them or change times via the API
// (persisted to data/routines.json).

import {
  todayString,
  isoWeekId,
  weekRangeForDate,
  loadRoutinesConfig,
  saveRoutinesConfig,
  pushFeed,
} from "./storage.js";
import {
  buildDailyPlan,
  buildDailyReview,
  buildWeeklyPlan,
  buildWeeklyReview,
} from "./planner.js";

// days: "daily" or an array of ISO weekday numbers (Mon=1 .. Sun=7).
export const DEFAULT_ROUTINES = [
  { id: "daily-plan", label: "晨间计划", type: "daily-plan", time: "08:30", days: "daily", enabled: true },
  { id: "daily-review", label: "晚间复盘", type: "daily-review", time: "21:30", days: "daily", enabled: true },
  { id: "weekly-plan", label: "周一规划", type: "weekly-plan", time: "08:00", days: [1], enabled: true },
  { id: "weekly-review", label: "周五复盘", type: "weekly-review", time: "17:00", days: [5], enabled: true },
];

const FEED_META = {
  "daily-plan": { title: "晨间计划已就绪", detail: "Bird 帮你把今天的重点理好了" },
  "daily-review": { title: "今日复盘已生成", detail: "对照计划看看今天落地得怎么样" },
  "weekly-plan": { title: "本周计划已就绪", detail: "这一周的重点和取舍" },
  "weekly-review": { title: "周复盘已生成", detail: "这一周的进展、模式和下周的种子" },
};

// Merge persisted overrides (by id) over the defaults.
export async function getRoutines() {
  const saved = await loadRoutinesConfig();
  if (!saved || !Array.isArray(saved)) return DEFAULT_ROUTINES.map((r) => ({ ...r }));
  const byId = new Map(saved.map((r) => [r.id, r]));
  return DEFAULT_ROUTINES.map((r) => ({ ...r, ...(byId.get(r.id) || {}) }));
}

export async function updateRoutine(id, patch) {
  const current = await getRoutines();
  const next = current.map((r) =>
    r.id === id ? { ...r, ...patch, id: r.id, type: r.type } : r
  );
  await saveRoutinesConfig(next);
  return next.find((r) => r.id === id);
}

// Run one routine now, persist its artifact, and post a feed card.
export async function runRoutine(type, { silent = false } = {}) {
  const date = todayString();
  let ref = null;
  if (type === "daily-plan") {
    await buildDailyPlan(date);
    ref = { kind: "day", date };
  } else if (type === "daily-review") {
    await buildDailyReview(date);
    ref = { kind: "day", date };
  } else if (type === "weekly-plan") {
    const weekId = isoWeekId(date);
    await buildWeeklyPlan(weekId, weekRangeForDate(date));
    ref = { kind: "week", weekId };
  } else if (type === "weekly-review") {
    const weekId = isoWeekId(date);
    await buildWeeklyReview(weekId, weekRangeForDate(date));
    ref = { kind: "week", weekId };
  } else {
    throw new Error(`Unknown routine type: ${type}`);
  }
  let card = null;
  if (!silent) {
    const meta = FEED_META[type] || { title: type, detail: "" };
    card = await pushFeed({ type, title: meta.title, detail: meta.detail, ref });
  }
  return { type, ref, card };
}

function parseHHMM(s) {
  const [h, m] = String(s).split(":").map((n) => parseInt(n, 10));
  return { h: h || 0, m: m || 0 };
}

function dueToday(routine, now) {
  if (routine.days === "daily") return true;
  if (Array.isArray(routine.days)) {
    const iso = ((now.getDay() + 6) % 7) + 1; // Mon=1..Sun=7
    return routine.days.includes(iso);
  }
  return false;
}

// Key a firing by day (daily) or week (weekly) so we fire once per period even
// across a long-running process.
function firedKey(routine, now) {
  if (routine.type.startsWith("weekly")) return `${routine.id}#${isoWeekId(todayString(now))}`;
  return `${routine.id}#${todayString(now)}`;
}

export function startRoutines() {
  const fired = new Set();

  async function tick() {
    const now = new Date();
    let routines;
    try {
      routines = await getRoutines();
    } catch (err) {
      console.error("[routines] failed to load config:", err.message);
      return;
    }
    for (const r of routines) {
      if (!r.enabled) continue;
      if (!dueToday(r, now)) continue;
      const { h, m } = parseHHMM(r.time);
      const reached = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
      if (!reached) continue;
      const key = firedKey(r, now);
      if (fired.has(key)) continue;
      fired.add(key);
      try {
        await runRoutine(r.type);
        console.log(`[routines] ran ${r.id} (${r.type}).`);
      } catch (err) {
        console.error(`[routines] ${r.id} failed:`, err.message);
        fired.delete(key); // allow a retry next tick
      }
    }
  }

  setInterval(tick, 60 * 1000);
  setTimeout(tick, 8000);
}
