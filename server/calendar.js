// Calendar integration via a read-only ICS feed (env CALENDAR_ICS_URL).
//
// This is the most pragmatic "look forward" integration: both Google Calendar
// ("Secret address in iCal format") and Apple Calendar (public/shared calendar
// link) expose a plain .ics URL that needs no OAuth. We fetch it, parse the
// VEVENTs we care about, and hand upcoming events to the planner so daily /
// weekly plans are grounded in what's actually on the calendar.
//
// Zero dependencies — a small RFC-5545 subset parser. We deliberately skip
// RRULE expansion (recurring events only surface on their first instance);
// for planning a day/week ahead the dated one-offs + meetings are what matter.

// Fetch + parse, swallowing errors so a bad/missing feed never breaks planning.
export async function fetchCalendarSafe() {
  const url = process.env.CALENDAR_ICS_URL;
  if (!url) return { ok: false, reason: "no-url", events: [] };
  try {
    const res = await fetch(url, { headers: { accept: "text/calendar" } });
    if (!res.ok) return { ok: false, reason: `http-${res.status}`, events: [] };
    const text = await res.text();
    return { ok: true, events: parseICS(text) };
  } catch (err) {
    return { ok: false, reason: err.message, events: [] };
  }
}

// Unfold folded lines (a leading space/tab continues the previous line),
// then walk VEVENT blocks pulling the fields we use.
export function parseICS(ics) {
  const unfolded = String(ics || "").replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur && cur.start) events.push(finalizeEvent(cur));
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const rawKey = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const key = rawKey.split(";")[0].toUpperCase();
    if (key === "DTSTART") {
      cur.start = parseICSDate(value, rawKey);
      cur.allDay = /VALUE=DATE\b/i.test(rawKey) || /^\d{8}$/.test(value.trim());
    } else if (key === "DTEND") {
      cur.end = parseICSDate(value, rawKey);
    } else if (key === "SUMMARY") {
      cur.summary = unescapeICS(value);
    } else if (key === "LOCATION") {
      cur.location = unescapeICS(value);
    }
  }
  return events
    .filter((e) => e.start instanceof Date && !isNaN(e.start))
    .sort((a, b) => a.start - b.start);
}

function finalizeEvent(cur) {
  return {
    summary: cur.summary || "(untitled)",
    location: cur.location || "",
    start: cur.start,
    end: cur.end || cur.start,
    allDay: Boolean(cur.allDay),
  };
}

// Handles: 20260627 (date), 20260627T093000Z (UTC), 20260627T093000 (local).
function parseICSDate(value, rawKey) {
  const v = value.trim();
  const dateOnly = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  const dt = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (dt) {
    const [, y, m, d, hh, mm, ss, z] = dt;
    if (z) return new Date(Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss));
    return new Date(+y, +m - 1, +d, +hh, +mm, +ss);
  }
  const parsed = new Date(v);
  return isNaN(parsed) ? null : parsed;
}

function unescapeICS(s) {
  return String(s)
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function sameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dateFromStr(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Events that touch a given local YYYY-MM-DD.
export function eventsForDate(events, dateStr) {
  const day = dateFromStr(dateStr);
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(day);
  dayEnd.setHours(23, 59, 59, 999);
  return (events || []).filter((e) => {
    if (e.allDay) return sameLocalDay(e.start, day);
    return e.start <= dayEnd && (e.end || e.start) >= dayStart;
  });
}

// Events anywhere inside [mondayStr, sundayStr] inclusive.
export function eventsForWeek(events, mondayStr, sundayStr) {
  const start = dateFromStr(mondayStr);
  start.setHours(0, 0, 0, 0);
  const end = dateFromStr(sundayStr);
  end.setHours(23, 59, 59, 999);
  return (events || []).filter((e) => e.start <= end && (e.end || e.start) >= start);
}

// One-line, model- and human-readable rendering of an event.
export function fmtEvent(e) {
  if (e.allDay) return `全天 · ${e.summary}`;
  const t = e.start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const loc = e.location ? ` @ ${e.location}` : "";
  return `${t} · ${e.summary}${loc}`;
}
