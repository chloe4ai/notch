// Tiny scheduler: at the configured local times each day, generate a summary
// for that slot and persist it. Intentionally simple — no cron lib, no DB.

import { loadDay, addSummary, todayString } from "./storage.js";
import { summarize } from "./summarizer.js";

function parseHHMM(s) {
  const [h, m] = s.split(":").map((n) => parseInt(n, 10));
  return { h, m };
}

const SLOT_FOR_HOUR = (h) => {
  if (h < 13) return "noon";
  if (h < 20) return "evening";
  return "night";
};

export function startScheduler({ schedule = "12:00,18:00,21:00" } = {}) {
  const times = schedule.split(",").map((t) => parseHHMM(t.trim()));
  // Track which (date, slotIndex) combos we've already fired for, so a single
  // long-running server doesn't double-fire across the same day.
  const fired = new Set();

  async function tick() {
    const now = new Date();
    const date = todayString(now);
    for (let i = 0; i < times.length; i++) {
      const { h, m } = times[i];
      // Fire once we've reached/passed the scheduled minute.
      if (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)) {
        const key = `${date}#${i}`;
        if (fired.has(key)) continue;
        fired.add(key);
        const slot = SLOT_FOR_HOUR(h);
        try {
          const day = await loadDay(date);
          if (day.entries.length === 0 && day.tasks.length === 0) {
            console.log(`[scheduler] ${slot} skipped — no activity logged yet.`);
            continue;
          }
          const { text, model } = await summarize(day, slot, process.env.SUMMARY_LANG || "zh");
          await addSummary(date, { slot, text, model });
          console.log(`[scheduler] wrote ${slot} summary for ${date}.`);
        } catch (err) {
          console.error(`[scheduler] ${slot} failed:`, err.message);
        }
      }
    }
  }

  // Run every minute. Cheap.
  setInterval(tick, 60 * 1000);
  // First check after 5s so a server started after a slot time still fires.
  setTimeout(tick, 5000);
}
