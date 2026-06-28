// Builds a "what happened today" summary from raw entries + task timers.
// Uses Anthropic's Messages API if ANTHROPIC_API_KEY is set; otherwise falls
// back to a deterministic bullet aggregate so the app is fully usable offline.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function fmtDuration(ms) {
  if (!ms || ms < 0) return "0m";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// Aggregate raw activity segments (one record per focus stretch) into totals
// keyed by name, sorted by time spent. Used for both the model prompt and the
// deterministic fallback.
function topByDuration(records, keyFn, limit) {
  const totals = new Map();
  for (const r of records || []) {
    const k = keyFn(r);
    if (!k) continue;
    totals.set(k, (totals.get(k) || 0) + (r.durationMs || 0));
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

// A compact, model-readable rendering of the day so the LLM can reason over it.
export function renderDayForModel(day) {
  const lines = [];
  lines.push(`# Day: ${day.date}`);
  lines.push("");
  lines.push("## Tasks (named timers)");
  if (day.tasks.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of day.tasks) {
      const dur = t.durationMs
        ? fmtDuration(t.durationMs)
        : fmtDuration(Date.now() - new Date(t.startTs));
      const end = t.endTs ? fmtTime(t.endTs) : "ongoing";
      lines.push(`- "${t.name}" — ${fmtTime(t.startTs)}→${end} (${dur})`);
    }
  }
  lines.push("");
  lines.push("## Notes / thoughts (chronological)");
  if (day.entries.length === 0) {
    lines.push("(none)");
  } else {
    for (const e of day.entries) {
      lines.push(`- [${fmtTime(e.ts)}] ${e.text}`);
    }
  }

  // Auto-tracked activity gives the model ground truth about where time
  // actually went, even on days with few manual notes/timers.
  const acts = day.activities || {};
  const topApps = topByDuration(acts.apps, (a) => a.name || a.bundleId, 8);
  const topWindows = topByDuration(acts.windows, (w) => w.title, 8);
  if (topApps.length) {
    lines.push("");
    lines.push("## Auto-tracked app usage (foreground time)");
    for (const [name, ms] of topApps) lines.push(`- ${name} — ${fmtDuration(ms)}`);
  }
  if (topWindows.length) {
    lines.push("");
    lines.push("## Auto-tracked window titles (what was on screen)");
    for (const [title, ms] of topWindows) lines.push(`- ${title} — ${fmtDuration(ms)}`);
  }
  return lines.join("\n");
}

function fallbackSummary(day, slot) {
  const totalMs = day.tasks.reduce((s, t) => s + (t.durationMs || 0), 0);
  const byName = new Map();
  for (const t of day.tasks) {
    byName.set(t.name, (byName.get(t.name) || 0) + (t.durationMs || 0));
  }
  const top = [...byName.entries()].sort((a, b) => b[1] - a[1]);

  const lines = [];
  lines.push(`# ${slot.charAt(0).toUpperCase() + slot.slice(1)} update — ${day.date}`);
  lines.push("");
  lines.push(`**Tracked time:** ${fmtDuration(totalMs)} across ${day.tasks.length} task block(s).`);
  if (top.length) {
    lines.push("");
    lines.push("**Where time went:**");
    for (const [name, ms] of top) lines.push(`- ${name} — ${fmtDuration(ms)}`);
  }
  if (day.entries.length) {
    lines.push("");
    lines.push("**Notes captured:**");
    for (const e of day.entries) lines.push(`- [${fmtTime(e.ts)}] ${e.text}`);
  }
  const topApps = topByDuration((day.activities || {}).apps, (a) => a.name || a.bundleId, 8);
  if (topApps.length) {
    lines.push("");
    lines.push("**Where the day went (auto-tracked):**");
    for (const [name, ms] of topApps) lines.push(`- ${name} — ${fmtDuration(ms)}`);
  }
  lines.push("");
  lines.push("_(No ANTHROPIC_API_KEY set — this is a plain aggregate. Add a key to .env for an AI-generated narrative.)_");
  return lines.join("\n");
}

const PROMPT = `You are Chloe's personal work journaler. She is a product manager / founder who dictates raw thoughts and starts/stops named task timers throughout the day. Your job is to turn that messy stream into a clean update.

Write the {{SLOT}} update in this exact structure, in markdown:

# {{SLOT_TITLE}} — {{DATE}}

**Headline:** one sentence summarizing the period.

**Time spent:** a tight bullet list of the tasks she actually worked on, with durations. Combine duplicate task names. Round to the nearest 5 minutes.

**Themes & decisions:** 2–5 bullets grouping her scattered notes by topic. Pull out anything that looks like a decision, a blocker, or an open question. Quote her own words when it sharpens the point.

**Action items:** explicit todos she mentioned or that are clearly implied. Use checkbox bullets ("- [ ] ..."). If none, write "None captured."

**Tomorrow / next:** 1–3 bullets only if she signaled forward intent. Otherwise omit this section.

Rules:
- Be faithful. Don't invent tasks, times, or commitments she didn't mention.
- Be concise. This is a working log, not a essay.
- Use her voice: direct, lower-case-y, slightly clipped. No corporate filler.
- If the day is sparse, say so plainly.
- The data may include auto-tracked app usage and window titles. Use them to ground "where time went" and to corroborate her notes, but don't over-index on them — they're context, not the headline. Don't list raw app names unless they actually clarify what she was doing.

Here is today's raw data:

{{DAY}}`;

async function callAnthropic({ apiKey, model, prompt }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return text.trim();
}

export async function summarize(day, slot = "adhoc") {
  const slotTitle = {
    noon: "Noon update",
    afternoon: "Afternoon update",
    evening: "Evening wrap",
    night: "Night wrap",
    adhoc: "Update",
  }[slot] || "Update";

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  if (!apiKey) {
    return { text: fallbackSummary(day, slot), model: null };
  }

  const prompt = PROMPT
    .replaceAll("{{SLOT}}", slot)
    .replaceAll("{{SLOT_TITLE}}", slotTitle)
    .replaceAll("{{DATE}}", day.date)
    .replaceAll("{{DAY}}", renderDayForModel(day));

  try {
    const text = await callAnthropic({ apiKey, model, prompt });
    return { text, model };
  } catch (err) {
    console.error("[summarizer] LLM call failed, using fallback:", err.message);
    return {
      text:
        `_(LLM call failed: ${err.message}. Falling back to plain aggregate.)_\n\n` +
        fallbackSummary(day, slot),
      model: null,
    };
  }
}

// --- Q&A chat -------------------------------------------------------------
// Lets Chloe ask free-form questions about her day ("what did I do in the past
// hour?", "where did my time go?"). Time-aware: the prompt includes the current
// clock and a timestamped activity timeline so the model can scope answers.

const CHAT_SYSTEM = `You are Chloe's personal work-journal assistant. She asks questions about her own work history and you answer ONLY from the data given below. Two kinds of data may be present:
- TODAY (always): her task timers, notes, and an auto-tracked timeline of which apps/windows she had in focus (each line stamped with the local time it ended).
- EARLIER (when she asks about the past): a compact digest spanning past days/weeks — daily plans (with completion), daily reviews, daily summaries, task totals, and weekly plans/reviews. Use this to answer "上周做了什么 / 这个月推进了什么 / 周二干了啥".

Guidelines:
- Reply in the same language she asks in (usually Chinese). Keep it tight.
- Scope to what she asked. For an intraday window ("过去一小时" / "刚才" / "下午") use today's timestamps + the current time. For a past day/week/month, use the EARLIER digest.
- ALWAYS synthesize, never transcribe. Do NOT dump a timestamped or per-day log. Instead:
  1. Open with a one-sentence headline answering her question.
  2. Group into a few meaningful themes (e.g. 编程/开发, 浏览/调研, 求职, 沟通, 写作/笔记, 杂务), or for a multi-day question, group by project/theme and note progress/trends across days.
  3. Add 1–3 sentences of narrative, pulling out anything notable (a specific repo, a job application, a decision, a pattern). Fold near-duplicates together; ignore noise like "New Tab".
- When she asks about plans/reviews/progress, lean on the plan-completion and review text in the digest.
- If the data doesn't cover what she asks, say so plainly. Never invent activity that isn't in the data.`;

// A detailed, timestamped rendering for Q&A (vs. the aggregate one used for
// scheduled summaries).
export function renderDayContextForChat(day, now = new Date()) {
  const lines = [];
  lines.push(`Current local time: ${day.date} ${fmtTime(now.toISOString())}.`);
  lines.push("");
  lines.push("## Task timers");
  if (!day.tasks.length) lines.push("(none)");
  else
    for (const t of day.tasks) {
      const end = t.endTs ? fmtTime(t.endTs) : "ongoing";
      const dur = t.durationMs
        ? fmtDuration(t.durationMs)
        : fmtDuration(Date.now() - new Date(t.startTs));
      lines.push(`- "${t.name}" ${fmtTime(t.startTs)}→${end} (${dur})`);
    }
  lines.push("");
  lines.push("## Notes");
  if (!day.entries.length) lines.push("(none)");
  else for (const e of day.entries) lines.push(`- [${fmtTime(e.ts)}] ${e.text}`);

  const acts = day.activities || {};
  const appTotals = topByDuration(acts.apps, (a) => a.name || a.bundleId, 12);
  if (appTotals.length) {
    lines.push("");
    lines.push("## App time totals (today)");
    for (const [n, ms] of appTotals) lines.push(`- ${n}: ${fmtDuration(ms)}`);
  }

  const wins = (acts.windows || []).slice(-160);
  if (wins.length) {
    lines.push("");
    lines.push("## Activity timeline (time = when each focused stretch ended)");
    for (const w of wins)
      lines.push(`- [${fmtTime(w.ts)}] ${w.app}: ${w.title} (${fmtDuration(w.durationMs)})`);
  } else {
    const apps = (acts.apps || []).slice(-160);
    if (apps.length) {
      lines.push("");
      lines.push("## Activity timeline (app focus; time = when it ended)");
      for (const a of apps)
        lines.push(`- [${fmtTime(a.ts)}] ${a.name || a.bundleId} (${fmtDuration(a.durationMs)})`);
    }
  }
  return lines.join("\n");
}

async function callAnthropicChat({ apiKey, model, system, messages, maxTokens = 1024 }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

// Group apps into human themes so the no-key fallback reads like a summary
// rather than a raw log.
const CATEGORIES = [
  { name: "编程 / 开发", test: /iterm|terminal|warp|visual studio code|vscode|xcode|cursor|sublime|\bnova\b|littlejot/i },
  { name: "AI 助手", test: /\bclaude\b|chatgpt|copilot|perplexity/i },
  { name: "浏览 / 调研", test: /chrome|safari|firefox|\barc\b|edge|brave/i },
  { name: "沟通", test: /wechat|weixin|slack|\bmail\b|messages|telegram|lark|feishu|zoom|discord|outlook|teams/i },
  { name: "笔记 / 写作", test: /obsidian|notion|\bnotes\b|\bbear\b|typora|craft|word|pages/i },
  { name: "设计 / 媒体", test: /figma|sketch|photoshop|illustrator|photos|preview|quicktime|music|spotify/i },
];

function categoryOf(name) {
  for (const c of CATEGORIES) if (c.test.test(name || "")) return c.name;
  return "其他";
}

// Strip browser/app noise from window titles so highlights read cleanly.
function cleanTitle(title, app) {
  let s = String(title || "");
  // Leading terminal spinner / braille / bullet glyphs (keep CJK & letters).
  s = s.replace(/^[\s⠀-⣿*✳✦✧◌◐◑◒◓●○•·‣⁃▪▸►–—-]+/, "");
  s = s.replace(/\s*[-–|]\s*High memory usage.*$/i, "");
  s = s.replace(/\s*[-–]\s*\d+(\.\d+)?\s*[GM]B\s*$/i, "");
  if (app) {
    const esc = app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp("\\s*[-–]\\s*" + esc + "\\s*$"), "");
  }
  return s.trim();
}

const TITLE_NOISE = /^(new tab|无标题|untitled|home|主页|loading|notifications?)$/i;

// Deterministic answer when no API key — categorizes activity in the implied
// time window into themes + a few cleaned highlights. Not a per-minute log.
function fallbackAnswer(day, q) {
  const now = Date.now();
  let sinceMs = now - 60 * 60 * 1000;
  let label = "过去一小时";
  const mHours = q.match(/(\d+)\s*(小时|个钟|hours?|hrs?)/i);
  if (/今天|today|全天|一天|一整天/i.test(q)) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    sinceMs = d.getTime();
    label = "今天";
  } else if (mHours) {
    const n = parseInt(mHours[1], 10) || 1;
    sinceMs = now - n * 60 * 60 * 1000;
    label = `过去 ${n} 小时`;
  } else if (/半小时|30\s*分钟|half.?hour/i.test(q)) {
    sinceMs = now - 30 * 60 * 1000;
    label = "过去半小时";
  }

  const acts = day.activities || {};
  const since = (arr) => (arr || []).filter((r) => new Date(r.ts).getTime() >= sinceMs);
  const apps = since(acts.apps);
  const wins = since(acts.windows);
  const notes = since(day.entries);

  if (!apps.length && !wins.length && !notes.length) {
    return `**${label}**：这段时间没有追踪到活动记录。`;
  }

  // Time by theme.
  const byCat = new Map();
  for (const a of apps) {
    const c = categoryOf(a.name || a.bundleId);
    byCat.set(c, (byCat.get(c) || 0) + (a.durationMs || 0));
  }
  const allCats = [...byCat.entries()].sort((x, y) => y[1] - x[1]);
  const totalMs = allCats.reduce((s, [, ms]) => s + ms, 0);
  // Hide themes that round to 0m; always keep at least the top one.
  const bigCats = allCats.filter(([, ms]) => Math.round(ms / 60000) >= 1);
  const cats = bigCats.length ? bigCats : allCats.slice(0, 1);

  // Distinct cleaned highlights (longest-focused first).
  const titleMs = new Map();
  for (const w of wins) {
    const t = cleanTitle(w.title, w.app);
    if (!t || TITLE_NOISE.test(t)) continue;
    titleMs.set(t, (titleMs.get(t) || 0) + (w.durationMs || 0));
  }
  const highlights = [...titleMs.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6);

  const lines = [];
  const topCats = cats.slice(0, 2).map(([n]) => n).join("、");
  lines.push(
    `**${label}小结** — 主要在 ${topCats || "电脑"} 上，共约 ${fmtDuration(totalMs)}。`
  );
  if (cats.length) {
    lines.push("");
    lines.push("**时间分配**");
    for (const [n, ms] of cats) lines.push(`- ${n} — ${fmtDuration(ms)}`);
  }
  if (highlights.length) {
    lines.push("");
    lines.push("**具体在做**");
    for (const [t] of highlights) lines.push(`- ${t}`);
  }
  if (notes.length) {
    lines.push("");
    lines.push("**随手记**");
    for (const e of notes) lines.push(`- ${e.text}`);
  }
  lines.push("");
  lines.push("_（这是无 AI key 时的本地归类汇总；在 .env 填入 ANTHROPIC_API_KEY 后，会换成 Claude 写的连贯总结。）_");
  return lines.join("\n");
}

export async function ask(day, question, history = [], opts = {}) {
  const q = String(question || "").trim();
  if (!q) throw new Error("Question is required");
  const { historyContext = "", rangeLabel = "" } = opts;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  if (!apiKey) {
    // Without a key: if the question spans past days, the digest is already a
    // readable summary — hand it back directly; else use the today-window logic.
    if (historyContext) {
      return {
        text:
          `**${rangeLabel || "这段时间"}的记录**\n\n${historyContext}\n\n` +
          "_（无 AI key：这是按你的问题范围拉出的原始汇总；填入 ANTHROPIC_API_KEY 后会换成 Claude 写的连贯回答。）_",
        model: null,
      };
    }
    return { text: fallbackAnswer(day, q), model: null };
  }

  let system = CHAT_SYSTEM + "\n\n---\n\n## 今天\n" + renderDayContextForChat(day, new Date());
  if (historyContext) {
    system += `\n\n---\n\n## 更早的记录（${rangeLabel}）\n${historyContext}`;
  }

  // Sanitize prior turns: valid roles, non-empty, must start with a user turn.
  const clean = (Array.isArray(history) ? history : [])
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content }));
  while (clean.length && clean[0].role !== "user") clean.shift();

  const messages = [...clean, { role: "user", content: q }];
  try {
    const text = await callAnthropicChat({
      apiKey, model, system, messages,
      maxTokens: historyContext ? 1600 : 1024,
    });
    return { text: text || "(没有内容)", model };
  } catch (err) {
    console.error("[ask] LLM call failed:", err.message);
    return { text: `（AI 调用失败：${err.message}）\n\n` + fallbackAnswer(day, q), model: null };
  }
}
