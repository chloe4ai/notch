// The planner: turns gathered context into the four Little-Bird-style artifacts
// Chloe asked for — daily plan, daily review, weekly plan, weekly review.
//
// Every generator: (1) gathers context, (2) asks Claude (if a key is set) or
// falls back to a deterministic draft, (3) persists via storage, (4) returns
// the saved artifact. Plans use a tiny delimited format we parse into a
// checklist; reviews are free markdown.

import { callLLM, hasLLM, llmModel } from "./llm.js";
import {
  setDayPlan,
  setDayReview,
  setWeekPlan,
  setWeekReview,
  isoWeekId,
  weekRangeForDate,
} from "./storage.js";
import {
  gatherDailyPlanContext,
  gatherDailyReviewContext,
  gatherWeeklyPlanContext,
  gatherWeeklyReviewContext,
  fmtEvent,
} from "./context.js";

const VOICE = `你是 Chloe 的私人参谋（她是产品经理 / 创业者）。说话直接、口语化、不说废话、不打官腔。用中文写。`;

// Parse the delimited plan format the model is asked to emit:
//   HEADLINE: ...        (or THEME: ... for weekly)
//   FOCUS: / PRIORITIES:
//   - item
//   NOTES: ...
function parsePlanFormat(text) {
  const lines = String(text || "").split("\n");
  let headline = "";
  let note = "";
  let section = "";
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const mHead = line.match(/^(?:HEADLINE|THEME|主题|今日意图)\s*[:：]\s*(.*)$/i);
    if (mHead) {
      headline = mHead[1].trim();
      section = "";
      continue;
    }
    const mItems = line.match(/^(?:FOCUS|PRIORITIES|重点|今天要做|本周重点)\s*[:：]\s*(.*)$/i);
    if (mItems) {
      section = "items";
      if (mItems[1].trim()) items.push(stripBullet(mItems[1]));
      continue;
    }
    const mNote = line.match(/^(?:NOTES?|NOTE|备注|提醒)\s*[:：]\s*(.*)$/i);
    if (mNote) {
      section = "note";
      note = mNote[1].trim();
      continue;
    }
    if (section === "items") {
      const b = line.match(/^[-*•]\s*(?:\[.\]\s*)?(.+)$/);
      if (b) items.push(b[1].trim());
    } else if (section === "note") {
      note += (note ? " " : "") + line;
    }
  }
  return {
    headline,
    items: items.map(stripBullet).filter(Boolean),
    note: /^无$|^none$/i.test(note.trim()) ? "" : note.trim(),
  };
}

function stripBullet(s) {
  return String(s).replace(/^[-*•]\s*(?:\[.\]\s*)?/, "").trim();
}

// --- DAILY PLAN -----------------------------------------------------------

const DAILY_PLAN_PROMPT = `根据下面的背景，为今天起草一份计划。先想清楚今天「真正重要的 3 件事」是什么——别堆任务清单，要有取舍。把日历上的会议预留出准备/缓冲时间。把昨天没做完的事和本周重点纳入考虑，但只挑今天该做的。

严格用这个格式输出（不要别的）：
HEADLINE: 一句话点出今天的主线意图
FOCUS:
- 今天要完成的具体一件事（动词开头，可勾选）
- ...（3~5 条，按优先级排）
NOTES: 1~2 句话的提醒 / 风险 / 要留意的事；没有就写「无」

背景：
{{CONTEXT}}`;

function renderDailyPlanContext(ctx) {
  const L = [];
  L.push(`# 今天：${ctx.date}`);
  if (ctx.weekTheme) L.push(`\n本周主题：${ctx.weekTheme}`);
  if (ctx.weekPriorities.length) {
    L.push("\n## 本周重点");
    for (const p of ctx.weekPriorities) L.push(`- [${p.done ? "x" : " "}] ${p.text}`);
  }
  L.push("\n## 今天的日历");
  if (ctx.todayEvents.length) for (const e of ctx.todayEvents) L.push(`- ${fmtEvent(e)}`);
  else if (!ctx.calendar.ok) L.push(`(未接日历 — ${ctx.calendar.reason})`);
  else L.push("(今天没有日程)");
  L.push("\n## 昨天没做完的");
  if (ctx.carryOver.length) for (const c of ctx.carryOver) L.push(`- ${c.text}`);
  else L.push("(无)");
  if (ctx.yesterdayReview) {
    L.push("\n## 昨晚的复盘");
    L.push(ctx.yesterdayReview.slice(0, 600));
  }
  if (ctx.goals) {
    L.push("\n## 长期目标 / 在做的事 (goals.md)");
    L.push(ctx.goals.slice(0, 1500));
  }
  return L.join("\n");
}

function fallbackDailyPlan(ctx) {
  const items = [];
  for (const c of ctx.carryOver.slice(0, 3)) items.push(`${c.text}（昨天延续）`);
  for (const e of ctx.todayEvents.slice(0, 3)) {
    if (!e.allDay) items.push(`准备：${e.summary}`);
  }
  for (const p of ctx.weekPriorities.filter((x) => !x.done).slice(0, 2)) {
    items.push(`推进本周重点：${p.text}`);
  }
  if (!items.length) items.push("定下今天最重要的一件事");
  const note = ctx.calendar.ok
    ? `今天日历上有 ${ctx.todayEvents.length} 件事。`
    : "（未接日历，未设 ANTHROPIC_API_KEY — 这是本地草稿。）";
  return { headline: `${ctx.date} 的计划`, items: items.slice(0, 5), note };
}

export async function buildDailyPlan(date) {
  const ctx = await gatherDailyPlanContext(date);
  if (!hasLLM()) {
    return setDayPlan(date, { ...fallbackDailyPlan(ctx), model: null, source: "fallback" });
  }
  try {
    const text = await callLLM({
      system: VOICE,
      prompt: DAILY_PLAN_PROMPT.replace("{{CONTEXT}}", renderDailyPlanContext(ctx)),
      maxTokens: 900,
    });
    const parsed = parsePlanFormat(text);
    if (!parsed.items.length) parsed.items = fallbackDailyPlan(ctx).items;
    return setDayPlan(date, { ...parsed, model: llmModel(), source: "ai" });
  } catch (err) {
    console.error("[planner] daily-plan LLM failed:", err.message);
    return setDayPlan(date, { ...fallbackDailyPlan(ctx), model: null, source: "fallback" });
  }
}

// --- DAILY REVIEW ---------------------------------------------------------

const DAILY_REVIEW_PROMPT = `这是 Chloe 今天的「计划」和「实际发生了什么」。写一份晚间复盘——对照计划看落地情况，但别只盯着勾没勾上。用 markdown，结构如下：

# 今日复盘 — {{DATE}}

**一句话**：今天整体怎么样。

**计划 vs 实际**：哪些计划做到了、哪些没做到、为什么；以及有没有做了计划外但重要的事。诚实，别粉饰。

**亮点**：1~3 条今天值得记住的进展或决定。

**卡点 / 教训**：1~2 条卡住的地方或可改进的点。

**留给明天**：用 checkbox（- [ ]）列出该顺延或新冒出来的事。

规则：忠于数据，别编。简洁，是工作日志不是作文。用她的语气：直接、偏口语。

数据：
{{CONTEXT}}`;

function renderDailyReviewContext(ctx) {
  const L = [];
  L.push("## 今天的计划");
  if (ctx.plan) {
    if (ctx.plan.headline) L.push(`意图：${ctx.plan.headline}`);
    L.push(ctx.planItems);
    if (ctx.plan.note) L.push(`备注：${ctx.plan.note}`);
  } else {
    L.push("(今天没有事先定计划)");
  }
  L.push("\n## 实际发生 (追踪 + 记录)");
  L.push(ctx.dayForModel);
  return L.join("\n");
}

function fallbackDailyReview(ctx) {
  const L = [`# 今日复盘 — ${ctx.date}`, ""];
  if (ctx.plan?.items?.length) {
    const done = ctx.plan.items.filter((i) => i.done);
    const undone = ctx.plan.items.filter((i) => !i.done);
    L.push(`**计划完成度**：${done.length}/${ctx.plan.items.length}`);
    if (done.length) {
      L.push("\n**做到了：**");
      for (const i of done) L.push(`- ${i.text}`);
    }
    if (undone.length) {
      L.push("\n**没做到 / 留给明天：**");
      for (const i of undone) L.push(`- [ ] ${i.text}`);
    }
  } else {
    L.push("今天没有事先定计划。");
  }
  L.push(`\n**这一天**：记了 ${ctx.notesCount} 条，跑了 ${ctx.taskCount} 段任务。`);
  L.push("\n_(未设 ANTHROPIC_API_KEY — 这是本地草稿；填 key 后换成 Claude 写的复盘。)_");
  return L.join("\n");
}

export async function buildDailyReview(date) {
  const ctx = await gatherDailyReviewContext(date);
  if (!hasLLM()) return setDayReview(date, { text: fallbackDailyReview(ctx), model: null });
  try {
    const text = await callLLM({
      system: VOICE,
      prompt: DAILY_REVIEW_PROMPT.replace("{{DATE}}", date).replace(
        "{{CONTEXT}}",
        renderDailyReviewContext(ctx)
      ),
      maxTokens: 1400,
    });
    return setDayReview(date, { text: text || fallbackDailyReview(ctx), model: llmModel() });
  } catch (err) {
    console.error("[planner] daily-review LLM failed:", err.message);
    return setDayReview(date, { text: fallbackDailyReview(ctx), model: null });
  }
}

// --- WEEKLY PLAN ----------------------------------------------------------

const WEEKLY_PLAN_PROMPT = `根据背景，为这一周起草计划。重点是「取舍」：这一周如果只能推动 3~5 件事，是哪几件？把上周没做完的、本周日历上的大事、长期目标都纳入考虑。

严格用这个格式输出：
THEME: 一句话点出这周的主线
PRIORITIES:
- 这周要推动的一个重点（结果导向，可勾选）
- ...（3~5 条，按重要性排）
NOTES: 1~2 句话的提醒 / 风险；没有就写「无」

背景：
{{CONTEXT}}`;

function renderWeeklyPlanContext(ctx) {
  const L = [];
  L.push(`# 本周：${ctx.range.monday} ~ ${ctx.range.sunday} (${ctx.weekId})`);
  L.push("\n## 这周日历上的大事");
  if (ctx.weekEvents.length) {
    for (const e of ctx.weekEvents.slice(0, 25)) {
      const d = e.start.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
      L.push(`- ${d} ${fmtEvent(e)}`);
    }
  } else if (!ctx.calendar.ok) L.push(`(未接日历 — ${ctx.calendar.reason})`);
  else L.push("(这周日历是空的)");
  L.push("\n## 上周没做完的重点");
  if (ctx.carryOver.length) for (const c of ctx.carryOver) L.push(`- ${c.text}`);
  else L.push("(无)");
  if (ctx.lastWeekReview) {
    L.push("\n## 上周复盘");
    L.push(ctx.lastWeekReview.slice(0, 800));
  }
  if (ctx.goals) {
    L.push("\n## 长期目标 / 在做的事 (goals.md)");
    L.push(ctx.goals.slice(0, 1500));
  }
  return L.join("\n");
}

function fallbackWeeklyPlan(ctx) {
  const items = [];
  for (const c of ctx.carryOver.slice(0, 3)) items.push(`${c.text}（上周延续）`);
  if (items.length < 3) items.push("定下这周最重要的 3 个结果");
  const note = ctx.calendar.ok
    ? `这周日历上有 ${ctx.weekEvents.length} 件事。`
    : "（未接日历，未设 key — 本地草稿。）";
  return { theme: `${ctx.range.monday} 那一周`, items, note };
}

export async function buildWeeklyPlan(weekId, range) {
  const r = range || weekRangeForDate();
  const ctx = await gatherWeeklyPlanContext(weekId, r);
  if (!hasLLM()) {
    return setWeekPlan(weekId, r, { ...fallbackWeeklyPlan(ctx), model: null, source: "fallback" });
  }
  try {
    const text = await callLLM({
      system: VOICE,
      prompt: WEEKLY_PLAN_PROMPT.replace("{{CONTEXT}}", renderWeeklyPlanContext(ctx)),
      maxTokens: 900,
    });
    const parsed = parsePlanFormat(text);
    if (!parsed.items.length) parsed.items = fallbackWeeklyPlan(ctx).items;
    return setWeekPlan(weekId, r, {
      theme: parsed.headline,
      items: parsed.items,
      note: parsed.note,
      model: llmModel(),
      source: "ai",
    });
  } catch (err) {
    console.error("[planner] weekly-plan LLM failed:", err.message);
    return setWeekPlan(weekId, r, { ...fallbackWeeklyPlan(ctx), model: null, source: "fallback" });
  }
}

// --- WEEKLY REVIEW --------------------------------------------------------

const WEEKLY_REVIEW_PROMPT = `这是 Chloe 这一周的计划重点、每天的概况和每日复盘摘要。写一份周复盘。用 markdown：

# 周复盘 — {{WEEKID}}（{{RANGE}}）

**这一周**：2~3 句话总结这周的主线和状态。

**重点进展**：逐条看这周的重点（priorities）推进到哪了，做到没做到、为什么。

**主题与模式**：2~4 条，从一周里看出的规律——精力花在哪、什么有效、什么在反复消耗你。

**值得记住的**：1~3 条亮点或决定。

**下周的种子**：用 checkbox（- [ ]）列出下周该带上的事。

规则：忠于数据，看见模式但别硬编。直接、口语。

数据：
{{CONTEXT}}`;

function renderWeeklyReviewContext(ctx) {
  const L = [];
  L.push("## 这周的重点 (priorities)");
  if (ctx.priorities.length) {
    for (const p of ctx.priorities) L.push(`- [${p.done ? "x" : " "}] ${p.text}`);
    if (ctx.weekPlan?.theme) L.push(`主题：${ctx.weekPlan.theme}`);
  } else {
    L.push("(这周没有事先定计划)");
  }
  L.push("\n## 每天概况");
  L.push(ctx.daysDigest);
  return L.join("\n");
}

function fallbackWeeklyReview(ctx) {
  const L = [`# 周复盘 — ${ctx.weekId}（${ctx.range.monday} ~ ${ctx.range.sunday}）`, ""];
  if (ctx.priorities.length) {
    const done = ctx.priorities.filter((i) => i.done).length;
    L.push(`**重点完成度**：${done}/${ctx.priorities.length}`);
    for (const p of ctx.priorities) L.push(`- [${p.done ? "x" : " "}] ${p.text}`);
  } else {
    L.push("这周没有事先定计划。");
  }
  L.push("\n## 每天概况");
  L.push(ctx.daysDigest);
  L.push("\n_(未设 ANTHROPIC_API_KEY — 本地草稿；填 key 后换成 Claude 写的周复盘。)_");
  return L.join("\n");
}

export async function buildWeeklyReview(weekId, range) {
  const r = range || weekRangeForDate();
  const ctx = await gatherWeeklyReviewContext(weekId, r);
  if (!hasLLM()) return setWeekReview(weekId, r, { text: fallbackWeeklyReview(ctx), model: null });
  try {
    const text = await callLLM({
      system: VOICE,
      prompt: WEEKLY_REVIEW_PROMPT.replace("{{WEEKID}}", weekId)
        .replace("{{RANGE}}", `${r.monday} ~ ${r.sunday}`)
        .replace("{{CONTEXT}}", renderWeeklyReviewContext(ctx)),
      maxTokens: 1600,
    });
    return setWeekReview(weekId, r, { text: text || fallbackWeeklyReview(ctx), model: llmModel() });
  } catch (err) {
    console.error("[planner] weekly-review LLM failed:", err.message);
    return setWeekReview(weekId, r, { text: fallbackWeeklyReview(ctx), model: null });
  }
}
