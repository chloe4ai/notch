// Cross-day / cross-week context for the "ask" chat. The base chat only ever
// saw today's file, so "上周做了什么 / 这个月的复盘" had nothing to answer from.
// This resolves a time range out of the question, then builds a COMPACT digest
// over that range (summaries, reviews, task totals, top apps, weekly artifacts)
// that stays small even across a month — today's fine-grained timeline still
// comes from summarizer.renderDayContextForChat.

import { shiftDate, weekRangeForDate, isoWeekId } from "./storage.js";

const MAX_RANGE_DAYS = 92; // hard cap so a "今年" question can't load 365 files

const WEEKDAYS = [
  { iso: 1, re: /周一|週一|星期一|礼拜一|拜一|\bmonday\b|\bmon\b/i },
  { iso: 2, re: /周二|週二|星期二|礼拜二|拜二|\btuesday\b|\btue\b/i },
  { iso: 3, re: /周三|週三|星期三|礼拜三|拜三|\bwednesday\b|\bwed\b/i },
  { iso: 4, re: /周四|週四|星期四|礼拜四|拜四|\bthursday\b|\bthu\b/i },
  { iso: 5, re: /周五|週五|星期五|礼拜五|拜五|\bfriday\b|\bfri\b/i },
  { iso: 6, re: /周六|週六|星期六|礼拜六|拜六|\bsaturday\b|\bsat\b/i },
  { iso: 7, re: /周日|週日|周天|星期日|星期天|礼拜天|礼拜日|\bsunday\b|\bsun\b/i },
];

function clampStart(start, end) {
  // Keep at most MAX_RANGE_DAYS ending at `end`.
  let s = start;
  const dates = datesBetween(start, end);
  if (dates.length > MAX_RANGE_DAYS) s = shiftDate(end, -(MAX_RANGE_DAYS - 1));
  return s;
}

// Inclusive list of YYYY-MM-DD between start and end (capped).
export function datesBetween(start, end) {
  const out = [];
  let cur = start;
  for (let i = 0; i < MAX_RANGE_DAYS + 1 && cur <= end; i++) {
    out.push(cur);
    cur = shiftDate(cur, 1);
  }
  return out;
}

// Distinct ISO week ids touched by [start, end].
export function weekIdsBetween(start, end) {
  const ids = [];
  for (const d of datesBetween(start, end)) {
    const id = isoWeekId(d);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function firstOfMonth(dateStr) {
  return dateStr.slice(0, 7) + "-01";
}
function lastOfMonth(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const last = new Date(y, m, 0).getDate(); // day 0 of next month = last of this
  return `${dateStr.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

// Resolve a question into a date range. Defaults to "today" (so existing
// behavior is untouched when nothing temporal is mentioned).
export function resolveRange(question, today) {
  const q = String(question || "");
  const mk = (start, end, label, includeWeeks = false) => ({
    start: clampStart(start, end),
    end,
    label,
    scope: start === today && end === today ? "today" : "range",
    includeWeeks,
  });

  let m;

  // Explicit ISO date, e.g. 2026-06-25
  if ((m = q.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    const d = `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
    return mk(d, d, d);
  }

  // 昨天 / 前天 / 大前天
  if (/大前天/.test(q)) { const d = shiftDate(today, -3); return mk(d, d, "大前天"); }
  if (/前天|day before yesterday/i.test(q)) { const d = shiftDate(today, -2); return mk(d, d, "前天"); }
  if (/昨天|昨日|yesterday/i.test(q)) { const d = shiftDate(today, -1); return mk(d, d, "昨天"); }

  // 最近/过去 N 天 / 周 / 个月
  if ((m = q.match(/(?:最近|过去|近|past|last)\s*(\d+)\s*(?:天|days?)/i))) {
    const n = Math.max(1, +m[1]);
    return mk(shiftDate(today, -(n - 1)), today, `最近 ${n} 天`, n > 10);
  }
  if ((m = q.match(/(?:最近|过去|近|past|last)\s*(\d+)\s*(?:周|週|个?星期|weeks?)/i))) {
    const n = Math.max(1, +m[1]);
    return mk(shiftDate(today, -(7 * n - 1)), today, `最近 ${n} 周`, true);
  }
  if ((m = q.match(/(?:最近|过去|近|past|last)\s*(\d+)\s*(?:个月|months?)/i))) {
    const n = Math.max(1, +m[1]);
    return mk(shiftDate(today, -(30 * n - 1)), today, `最近 ${n} 个月`, true);
  }

  // 上周 / 这周(本周) / 上个月 / 这个月(本月)
  if (/上上周|前一周/.test(q)) {
    const monday = shiftDate(weekRangeForDate(today).monday, -14);
    const r = weekRangeForDate(monday);
    return mk(r.monday, r.sunday, "上上周", true);
  }
  if (/上周|上週|上个星期|last week/i.test(q)) {
    const monday = shiftDate(weekRangeForDate(today).monday, -7);
    const r = weekRangeForDate(monday);
    return mk(r.monday, r.sunday, "上周", true);
  }
  if (/这周|本周|這週|这个星期|this week/i.test(q)) {
    const r = weekRangeForDate(today);
    return mk(r.monday, today, "这周", true);
  }
  if (/上个月|上月|上個月|last month/i.test(q)) {
    const lastMonthDay = firstOfMonth(today).slice(0, 8) + "01";
    const prev = shiftDate(firstOfMonth(today), -1); // last day of prev month
    return mk(firstOfMonth(prev), lastOfMonth(prev), "上个月", true);
  }
  if (/这个月|本月|這個月|this month/i.test(q)) {
    return mk(firstOfMonth(today), today, "这个月", true);
  }

  // Single weekday → that day within the current week (or last week if it'd be
  // in the future relative to today).
  for (const w of WEEKDAYS) {
    if (w.re.test(q)) {
      const r = weekRangeForDate(today);
      let d = r.dates[w.iso - 1];
      if (d > today) d = shiftDate(d, -7);
      const name = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][w.iso - 1];
      return mk(d, d, name);
    }
  }

  // Vague "recently" → last 7 days.
  if (/最近|这几天|這幾天|这阵子|这段时间|近期|recently|lately/i.test(q)) {
    return mk(shiftDate(today, -6), today, "最近一周", true);
  }

  return mk(today, today, "今天");
}

// --- digest rendering -----------------------------------------------------

function fmtDuration(ms) {
  if (!ms || ms < 0) return "0m";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function topAppsLine(day, n) {
  const totals = new Map();
  for (const a of day.activities?.apps || []) {
    const k = a.name || a.bundleId;
    if (!k) continue;
    totals.set(k, (totals.get(k) || 0) + (a.durationMs || 0));
  }
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return top.map(([k, ms]) => `${k} ${fmtDuration(ms)}`).join("、");
}

function weekday(dateStr) {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
    new Date(dateStr + "T00:00:00").getDay()
  ];
}

// Compact, model-readable digest over a range. `days` chronological (oldest
// first), `weeks` the weekly artifacts touched by the range.
export function renderHistoryForChat(days, weeks, range) {
  const compact = days.length > 31;
  const L = [];

  const weeksWithContent = (weeks || []).filter((w) => w && (w.plan || w.review));
  if (weeksWithContent.length) {
    L.push("## 周计划 / 周复盘");
    for (const w of weeksWithContent) {
      L.push(`### ${w.weekId}（${w.start || "?"} ~ ${w.end || "?"}）`);
      if (w.plan) {
        if (w.plan.theme) L.push(`主题：${w.plan.theme}`);
        for (const it of w.plan.items || []) L.push(`- [${it.done ? "x" : " "}] ${it.text}`);
      }
      if (w.review?.text) L.push(`复盘：${w.review.text.slice(0, compact ? 200 : 400)}`);
    }
    L.push("");
  }

  const daysWithContent = days.filter(
    (day) =>
      day.entries.length || day.tasks.length || day.summaries.length ||
      day.plan || day.review || (day.activities?.apps || []).length
  );
  if (daysWithContent.length) L.push("## 每天");
  for (const day of daysWithContent) {
    L.push(`### ${day.date}（${weekday(day.date)}）`);

    // Plan intent + completion, if present.
    if (day.plan?.items?.length) {
      const done = day.plan.items.filter((i) => i.done).length;
      L.push(`计划 ${done}/${day.plan.items.length}${day.plan.headline ? "：" + day.plan.headline : ""}`);
    }

    // Prefer the review (it's the richest synthesis); else the latest summary.
    if (day.review?.text) {
      L.push(`复盘：${day.review.text.slice(0, compact ? 160 : 320)}`);
    } else if (day.summaries.length) {
      const s = day.summaries[day.summaries.length - 1];
      L.push(`小结：${s.text.slice(0, compact ? 160 : 320)}`);
    } else {
      // No synthesis on file — fall back to raw signals.
      if (day.tasks.length) {
        const byName = new Map();
        for (const t of day.tasks) byName.set(t.name, (byName.get(t.name) || 0) + (t.durationMs || 0));
        const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        L.push("任务：" + top.map(([n, ms]) => `${n} ${fmtDuration(ms)}`).join("、"));
      }
      if (!compact && day.entries.length) {
        for (const e of day.entries.slice(0, 6)) L.push(`- ${e.text}`);
      } else if (day.entries.length) {
        L.push(`（${day.entries.length} 条随手记）`);
      }
      const apps = topAppsLine(day, 3);
      if (apps) L.push("时间：" + apps);
    }
  }

  if (L.length <= 1) return "（这段时间没有任何记录。）";
  return L.join("\n");
}
