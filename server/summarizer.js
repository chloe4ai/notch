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
