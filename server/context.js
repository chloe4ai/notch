// Gathers the context the planner reasons over, so plans/reviews are grounded
// in the user's actual world rather than generated in a vacuum. This is Notch's
// answer to Little Bird's "already knows your work": instead of screen-watching
// + dozens of OAuth integrations, we stitch together what we already have —
// tracked activity, the calendar feed, a hand-written goals file, and recent
// plans/reviews — into one briefing string.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  loadDay,
  loadWeek,
  getDataDir,
  shiftDate,
  isoWeekId,
  weekRangeForDate,
} from "./storage.js";
import { renderDayForModel } from "./summarizer.js";
import { fetchCalendarSafe, eventsForDate, eventsForWeek, fmtEvent } from "./calendar.js";

// A user-editable long-horizon context file. Mirrors Little Bird "knowing your
// work" without any integration: the user writes their projects, goals, and
// the people/threads that matter, and every plan is anchored to it.
export async function readGoals() {
  try {
    const raw = await fs.readFile(path.join(getDataDir(), "goals.md"), "utf8");
    return raw.trim();
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

function renderPlanItems(plan) {
  if (!plan || !plan.items?.length) return "(none)";
  return plan.items
    .map((it) => `- [${it.done ? "x" : " "}] ${it.text}`)
    .join("\n");
}

// Context for generating a DAILY PLAN (forward-looking).
export async function gatherDailyPlanContext(date) {
  const goals = await readGoals();
  const cal = await fetchCalendarSafe();
  const todayEvents = eventsForDate(cal.events, date);

  const yDate = shiftDate(date, -1);
  const yesterday = await loadDay(yDate);
  const carryOver = (yesterday.plan?.items || []).filter((i) => !i.done);

  const weekId = isoWeekId(date);
  const range = weekRangeForDate(date);
  const week = await loadWeek(weekId, range);
  const weekPriorities = week.plan?.items || [];

  return {
    date,
    goals,
    calendar: cal,
    todayEvents,
    carryOver,
    yesterdayReview: yesterday.review?.text || "",
    weekTheme: week.plan?.theme || "",
    weekPriorities,
  };
}

// Context for generating a DAILY REVIEW (backward-looking, plan vs actual).
export async function gatherDailyReviewContext(date) {
  const day = await loadDay(date);
  return {
    date,
    plan: day.plan,
    planItems: renderPlanItems(day.plan),
    dayForModel: renderDayForModel(day),
    notesCount: day.entries.length,
    taskCount: day.tasks.length,
  };
}

// Context for generating a WEEKLY PLAN (forward-looking).
export async function gatherWeeklyPlanContext(weekId, range) {
  const goals = await readGoals();
  const cal = await fetchCalendarSafe();
  const weekEvents = eventsForWeek(cal.events, range.monday, range.sunday);

  // Last week's review + unfinished priorities to carry forward.
  const lastWeekMonday = shiftDate(range.monday, -7);
  const lastWeekId = isoWeekId(lastWeekMonday);
  const lastRange = weekRangeForDate(lastWeekMonday);
  const lastWeek = await loadWeek(lastWeekId, lastRange);
  const carryOver = (lastWeek.plan?.items || []).filter((i) => !i.done);

  return {
    weekId,
    range,
    goals,
    calendar: cal,
    weekEvents,
    lastWeekReview: lastWeek.review?.text || "",
    carryOver,
  };
}

// Context for generating a WEEKLY REVIEW: roll up the 7 days of the week.
export async function gatherWeeklyReviewContext(weekId, range) {
  const days = [];
  for (const d of range.dates) {
    const day = await loadDay(d);
    days.push(day);
  }
  const week = await loadWeek(weekId, range);

  const lines = [];
  for (const day of days) {
    const weekday = new Date(day.date + "T00:00:00").toLocaleDateString("zh-CN", {
      weekday: "short",
    });
    const head = `### ${day.date} (周${weekday.replace(/^周/, "")})`;
    const bits = [];
    if (day.plan?.items?.length) {
      const done = day.plan.items.filter((i) => i.done).length;
      bits.push(`计划 ${done}/${day.plan.items.length} 完成`);
    }
    if (day.tasks.length) bits.push(`${day.tasks.length} 段任务`);
    if (day.entries.length) bits.push(`${day.entries.length} 条记`);
    lines.push(head + (bits.length ? ` — ${bits.join(" · ")}` : " — (空)"));
    if (day.review?.text) {
      // Keep it compact: first ~280 chars of each daily review.
      lines.push(day.review.text.slice(0, 280));
    }
  }

  return {
    weekId,
    range,
    weekPlan: week.plan,
    priorities: week.plan?.items || [],
    daysDigest: lines.join("\n"),
  };
}

export { fmtEvent };
