// Builds a "what happened today" summary from raw entries + task timers.
// Uses Anthropic's Messages API if ANTHROPIC_API_KEY is set; otherwise falls
// back to a deterministic bullet aggregate so the app is fully usable offline.
//
// All user-facing copy is language-aware (zh / en / ja). The chosen language
// is passed in from the frontend's language switcher; it controls both the
// instruction given to the model and the wording of the offline fallbacks.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const LANGS = ["zh", "en", "ja"];
function normLang(lang) {
  return LANGS.includes(lang) ? lang : "zh";
}

// Human-readable language names handed to the model so it replies in kind.
const LANG_NAMES = {
  zh: "Chinese (简体中文)",
  en: "English",
  ja: "Japanese (日本語)",
};

// Section/slot titles per language.
const SLOT_TITLES = {
  zh: { noon: "午间小结", afternoon: "下午小结", evening: "晚间小结", night: "夜间收尾", adhoc: "即时小结" },
  en: { noon: "Noon update", afternoon: "Afternoon update", evening: "Evening wrap", night: "Night wrap", adhoc: "Update" },
  ja: { noon: "昼のまとめ", afternoon: "午後のまとめ", evening: "夜のまとめ", night: "一日の締め", adhoc: "いまのまとめ" },
};

function slotTitleOf(slot, lang) {
  const table = SLOT_TITLES[normLang(lang)];
  return table[slot] || table.adhoc;
}

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

// Localized copy for the deterministic (no-API-key) summary fallback.
const FB_SUMMARY = {
  zh: {
    tracked: (dur, n) => `**已记录时间：** ${dur}，分布在 ${n} 段任务里。`,
    whereTime: "**时间花在哪：**",
    notes: "**记下的内容：**",
    autoWhere: "**这一天去了哪（自动追踪）：**",
    noKey: "_（未设置 ANTHROPIC_API_KEY —— 这是纯聚合。在 .env 填入 key 即可换成 AI 生成的叙述。）_",
  },
  en: {
    tracked: (dur, n) => `**Tracked time:** ${dur} across ${n} task block(s).`,
    whereTime: "**Where time went:**",
    notes: "**Notes captured:**",
    autoWhere: "**Where the day went (auto-tracked):**",
    noKey: "_(No ANTHROPIC_API_KEY set — this is a plain aggregate. Add a key to .env for an AI-generated narrative.)_",
  },
  ja: {
    tracked: (dur, n) => `**記録した時間：** ${dur}（${n} 件のタスク）。`,
    whereTime: "**時間の使い道：**",
    notes: "**メモした内容：**",
    autoWhere: "**一日の行き先（自動追跡）：**",
    noKey: "_（ANTHROPIC_API_KEY が未設定 —— これは単純な集計です。.env に key を入れると AI 生成の文章に変わります。）_",
  },
};

function fallbackSummary(day, slot, lang) {
  const L = normLang(lang);
  const c = FB_SUMMARY[L];
  const totalMs = day.tasks.reduce((s, t) => s + (t.durationMs || 0), 0);
  const byName = new Map();
  for (const t of day.tasks) {
    byName.set(t.name, (byName.get(t.name) || 0) + (t.durationMs || 0));
  }
  const top = [...byName.entries()].sort((a, b) => b[1] - a[1]);

  const lines = [];
  lines.push(`# ${slotTitleOf(slot, L)} — ${day.date}`);
  lines.push("");
  lines.push(c.tracked(fmtDuration(totalMs), day.tasks.length));
  if (top.length) {
    lines.push("");
    lines.push(c.whereTime);
    for (const [name, ms] of top) lines.push(`- ${name} — ${fmtDuration(ms)}`);
  }
  if (day.entries.length) {
    lines.push("");
    lines.push(c.notes);
    for (const e of day.entries) lines.push(`- [${fmtTime(e.ts)}] ${e.text}`);
  }
  const topApps = topByDuration((day.activities || {}).apps, (a) => a.name || a.bundleId, 8);
  if (topApps.length) {
    lines.push("");
    lines.push(c.autoWhere);
    for (const [name, ms] of topApps) lines.push(`- ${name} — ${fmtDuration(ms)}`);
  }
  lines.push("");
  lines.push(c.noKey);
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
- Write the ENTIRE update — including every section label (Headline, Time spent, etc.) — in {{LANG_NAME}}. Translate the structure naturally; keep the markdown.
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

export async function summarize(day, slot = "adhoc", lang = "zh") {
  const L = normLang(lang);
  const slotTitle = slotTitleOf(slot, L);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  if (!apiKey) {
    return { text: fallbackSummary(day, slot, L), model: null };
  }

  const prompt = PROMPT
    .replaceAll("{{SLOT}}", slot)
    .replaceAll("{{SLOT_TITLE}}", slotTitle)
    .replaceAll("{{DATE}}", day.date)
    .replaceAll("{{LANG_NAME}}", LANG_NAMES[L])
    .replaceAll("{{DAY}}", renderDayForModel(day));

  try {
    const text = await callAnthropic({ apiKey, model, prompt });
    return { text, model };
  } catch (err) {
    console.error("[summarizer] LLM call failed, using fallback:", err.message);
    return {
      text:
        `_(LLM call failed: ${err.message}. Falling back to plain aggregate.)_\n\n` +
        fallbackSummary(day, slot, L),
      model: null,
    };
  }
}

// --- Q&A chat -------------------------------------------------------------
// Lets Chloe ask free-form questions about her day ("what did I do in the past
// hour?", "where did my time go?"). Time-aware: the prompt includes the current
// clock and a timestamped activity timeline so the model can scope answers.

const CHAT_SYSTEM = `You are Chloe's personal work-journal assistant. She asks questions about her own day and you answer ONLY from the tracked data given below: her task timers, her notes, and an auto-tracked timeline of which apps/windows she had in focus (each line stamped with the local time it ended).

Guidelines:
- Always write your answer in {{LANG_NAME}}, regardless of the language she asks in. Keep it tight.
- When she asks about a time window ("过去一小时" / "the past hour" / "下午" / "刚才"), use the timestamps and the current time below to scope the answer.
- ALWAYS synthesize, never transcribe. Do NOT produce a timestamped or per-window log — she can see the raw timeline elsewhere. Instead:
  1. Open with a one-sentence headline of what the period was mostly about.
  2. Group the activity into a few meaningful themes/categories (e.g. coding/dev, browsing/research, job-hunt, communication, writing/notes, chores) with a rough time estimate for each.
  3. Add 1–3 sentences of narrative on what she was actually working on, pulling out anything notable (a specific repo, a job application, a doc). Fold near-duplicate window titles together and ignore noise like "New Tab" or "High memory usage".
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

async function callAnthropicChat({ apiKey, model, system, messages }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 1024, system, messages }),
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
// rather than a raw log. Each category has a stable key + per-language label.
const CATEGORIES = [
  { key: "dev", test: /iterm|terminal|warp|visual studio code|vscode|xcode|cursor|sublime|\bnova\b|littlejot/i },
  { key: "ai", test: /\bclaude\b|chatgpt|copilot|perplexity/i },
  { key: "browse", test: /chrome|safari|firefox|\barc\b|edge|brave/i },
  { key: "comms", test: /wechat|weixin|slack|\bmail\b|messages|telegram|lark|feishu|zoom|discord|outlook|teams/i },
  { key: "notes", test: /obsidian|notion|\bnotes\b|\bbear\b|typora|craft|word|pages/i },
  { key: "design", test: /figma|sketch|photoshop|illustrator|photos|preview|quicktime|music|spotify/i },
];

const CAT_LABELS = {
  zh: { dev: "编程 / 开发", ai: "AI 助手", browse: "浏览 / 调研", comms: "沟通", notes: "笔记 / 写作", design: "设计 / 媒体", other: "其他" },
  en: { dev: "Coding / dev", ai: "AI assistants", browse: "Browsing / research", comms: "Communication", notes: "Notes / writing", design: "Design / media", other: "Other" },
  ja: { dev: "開発 / コーディング", ai: "AI アシスタント", browse: "ブラウジング / 調査", comms: "コミュニケーション", notes: "ノート / 執筆", design: "デザイン / メディア", other: "その他" },
};

function categoryOf(name, lang) {
  const labels = CAT_LABELS[normLang(lang)];
  for (const c of CATEGORIES) if (c.test.test(name || "")) return labels[c.key];
  return labels.other;
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

// Localized copy for the deterministic (no-API-key) chat answer.
const FB_CHAT = {
  zh: {
    pastHour: "过去一小时",
    today: "今天",
    pastNHours: (n) => `过去 ${n} 小时`,
    pastHalfHour: "过去半小时",
    noActivity: (label) => `**${label}**：这段时间没有追踪到活动记录。`,
    computer: "电脑",
    headline: (label, cats, dur) => `**${label}小结** — 主要在 ${cats} 上，共约 ${dur}。`,
    breakdown: "**时间分配**",
    doingWhat: "**具体在做**",
    quickNotes: "**随手记**",
    noKey: "_（这是无 AI key 时的本地归类汇总；在 .env 填入 ANTHROPIC_API_KEY 后，会换成 Claude 写的连贯总结。）_",
  },
  en: {
    pastHour: "the past hour",
    today: "today",
    pastNHours: (n) => `the past ${n} hours`,
    pastHalfHour: "the past half hour",
    noActivity: (label) => `**${label}**: no tracked activity in this window.`,
    computer: "the computer",
    headline: (label, cats, dur) => `**${label} recap** — mostly on ${cats}, about ${dur} total.`,
    breakdown: "**Time breakdown**",
    doingWhat: "**What you were doing**",
    quickNotes: "**Notes**",
    noKey: "_(Local category roll-up — no AI key. Add ANTHROPIC_API_KEY to .env for a coherent Claude-written summary.)_",
  },
  ja: {
    pastHour: "直近1時間",
    today: "今日",
    pastNHours: (n) => `直近 ${n} 時間`,
    pastHalfHour: "直近30分",
    noActivity: (label) => `**${label}**：この時間帯に記録されたアクティビティはありません。`,
    computer: "パソコン",
    headline: (label, cats, dur) => `**${label}のまとめ** — 主に ${cats}、合計およそ ${dur}。`,
    breakdown: "**時間の配分**",
    doingWhat: "**具体的な作業**",
    quickNotes: "**メモ**",
    noKey: "_（AI key 未設定時のローカル集計です。.env に ANTHROPIC_API_KEY を入れると Claude による文章に変わります。）_",
  },
};

// Deterministic answer when no API key — categorizes activity in the implied
// time window into themes + a few cleaned highlights. Not a per-minute log.
function fallbackAnswer(day, q, lang) {
  const L = normLang(lang);
  const c = FB_CHAT[L];
  const now = Date.now();
  let sinceMs = now - 60 * 60 * 1000;
  let label = c.pastHour;
  const mHours = q.match(/(\d+)\s*(小时|个钟|時間|hours?|hrs?)/i);
  if (/今天|today|全天|一天|一整天|今日|きょう/i.test(q)) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    sinceMs = d.getTime();
    label = c.today;
  } else if (mHours) {
    const n = parseInt(mHours[1], 10) || 1;
    sinceMs = now - n * 60 * 60 * 1000;
    label = c.pastNHours(n);
  } else if (/半小时|30\s*分钟|30\s*分|half.?hour/i.test(q)) {
    sinceMs = now - 30 * 60 * 1000;
    label = c.pastHalfHour;
  }

  const acts = day.activities || {};
  const since = (arr) => (arr || []).filter((r) => new Date(r.ts).getTime() >= sinceMs);
  const apps = since(acts.apps);
  const wins = since(acts.windows);
  const notes = since(day.entries);

  if (!apps.length && !wins.length && !notes.length) {
    return c.noActivity(label);
  }

  // Time by theme.
  const byCat = new Map();
  for (const a of apps) {
    const cat = categoryOf(a.name || a.bundleId, L);
    byCat.set(cat, (byCat.get(cat) || 0) + (a.durationMs || 0));
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
  const sep = L === "en" ? ", " : "、";
  const topCats = cats.slice(0, 2).map(([n]) => n).join(sep);
  lines.push(c.headline(label, topCats || c.computer, fmtDuration(totalMs)));
  if (cats.length) {
    lines.push("");
    lines.push(c.breakdown);
    for (const [n, ms] of cats) lines.push(`- ${n} — ${fmtDuration(ms)}`);
  }
  if (highlights.length) {
    lines.push("");
    lines.push(c.doingWhat);
    for (const [t] of highlights) lines.push(`- ${t}`);
  }
  if (notes.length) {
    lines.push("");
    lines.push(c.quickNotes);
    for (const e of notes) lines.push(`- ${e.text}`);
  }
  lines.push("");
  lines.push(c.noKey);
  return lines.join("\n");
}

export async function ask(day, question, history = [], lang = "zh") {
  const L = normLang(lang);
  const q = String(question || "").trim();
  if (!q) throw new Error("Question is required");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  if (!apiKey) return { text: fallbackAnswer(day, q, L), model: null };

  const system =
    CHAT_SYSTEM.replaceAll("{{LANG_NAME}}", LANG_NAMES[L]) +
    "\n\n---\n\n" +
    renderDayContextForChat(day, new Date());

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
    const text = await callAnthropicChat({ apiKey, model, system, messages });
    return { text: text || "(empty)", model };
  } catch (err) {
    console.error("[ask] LLM call failed:", err.message);
    return { text: `(AI call failed: ${err.message})\n\n` + fallbackAnswer(day, q, L), model: null };
  }
}
