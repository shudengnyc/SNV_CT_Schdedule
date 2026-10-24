// Snapshot the court schedule sheet and keep a ledger of bookings.
// Reuses the parser in index.html so the record matches what the app shows.
//
// data/bookings.csv  one row per court booking (date, place, court, time range),
//                    with when it first appeared and when it disappeared
// data/changes.csv   every add/remove seen, flagged when it happened on the day itself
// data/usage_daily.csv  court-hours per date and location (rebuilt each run)
import fs from "node:fs";
import vm from "node:vm";

const TZ = "America/Los_Angeles";
const SLOTS = [6, 12, 16];
const DATA = "data";
const BOOKING_COLS = ["date", "location", "court", "start", "end", "hours", "raw_time", "added_at", "removed_at"];
const CHANGE_COLS = ["snapshot_at", "change", "date", "location", "court", "start", "end", "hours", "same_day", "days_ahead"];

// ---- local time helpers ----
function localParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, stamp: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` };
}
const now = localParts();

// Cron fires at both PST and PDT offsets; keep only the run that lands on a slot hour
if (process.env.GITHUB_EVENT_NAME === "schedule" && !SLOTS.includes(now.hour)) {
  console.log(`Local hour ${now.hour} is not a snapshot slot; skipping.`);
  process.exit(0);
}

// ---- load the app's parser out of index.html ----
const html = fs.readFileSync("index.html", "utf8");
const pick = (re) => { const m = html.match(re); if (!m) throw new Error(`index.html: missing ${re}`); return m[0]; };
const fnNames = ["processCourt", "cleanSingleTime", "format24to12Hour", "processTimeRange", "processTime",
  "parseTimeToHours", "extractTimeRanges", "normalizeDay", "normalizeLocationName", "excelSerialToDate",
  "normalizeDateCell", "normalizeRawTimeValue", "parseSheetRows"];
const src = [
  pick(/const spreadsheetId = .*;/),
  pick(/const courtSheetTabs = \[[\s\S]*?\];/),
  pick(/const expectedDays = .*;/),
  ...fnNames.map(n => pick(new RegExp(`^function ${n}\\([\\s\\S]*?^}`, "m")))
].join("\n") + "\n({ spreadsheetId, courtSheetTabs, parseSheetRows, extractTimeRanges });";
const app = vm.runInNewContext(src, { console });

// ---- fetch every tab ----
async function fetchTab(sheet) {
  const url = `https://docs.google.com/spreadsheets/d/${app.spreadsheetId}/gviz/tq?sheet=${encodeURIComponent(sheet)}&range=A:E&tqx=out:json`;
  for (let attempt = 1; ; attempt++) {
    try {
      const text = await (await fetch(url)).text();
      const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      if (json.status !== "ok") throw new Error(json.status);
      return json.table.rows || [];
    } catch (err) {
      if (attempt >= 3) throw new Error(`${sheet}: ${err.message}`);
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
}
const tabs = await Promise.all(app.courtSheetTabs.map(fetchTab));

// ---- current bookings: one per court per time range ----
const iso = (mdy) => { const [m, d, y] = mdy.split("/"); return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`; };
const hhmm = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
const current = new Map();
tabs.forEach((rows, i) => {
  for (const r of app.parseSheetRows(app.courtSheetTabs[i], rows)) {
    if (r.Court === "N/A") continue;
    for (const { start, end } of app.extractTimeRanges(r.Time)) {
      if (!(end > start)) continue;
      const b = { date: iso(r.Date), location: r.Location, court: r.Court, start: hhmm(start), end: hhmm(end),
        hours: (end - start).toFixed(2), raw_time: r.RawTime };
      current.set(keyOf(b), b);
    }
  }
});
if (current.size === 0) throw new Error("Parsed zero bookings; refusing to record (sheet layout change?)");
function keyOf(b) { return [b.date, b.location, b.court, b.start, b.end].join("|"); }

// ---- CSV io ----
const esc = (v) => /[",\n]/.test(v ??= "") ? `"${v.replace(/"/g, '""')}"` : v;
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const rows = []; let row = [], field = "", q = false;
  const text = fs.readFileSync(file, "utf8");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, j) => [h, r[j] ?? ""])));
}
const writeCsv = (file, cols, rows) =>
  fs.writeFileSync(file, [cols.join(","), ...rows.map(r => cols.map(c => esc(String(r[c] ?? ""))).join(","))].join("\n") + "\n");

// ---- diff against the ledger ----
fs.mkdirSync(DATA, { recursive: true });
const ledger = readCsv(`${DATA}/bookings.csv`);
const firstRun = ledger.length === 0;
const open = new Map(ledger.filter(b => !b.removed_at).map(b => [keyOf(b), b]));
const sheetDates = new Set([...current.values()].map(b => b.date));
const changes = [];
const daysAhead = (date) => Math.round((Date.parse(date) - Date.parse(now.date)) / 86400000);
const event = (change, b) => changes.push({ snapshot_at: now.stamp, change, date: b.date, location: b.location,
  court: b.court, start: b.start, end: b.end, hours: b.hours, same_day: b.date === now.date ? "Y" : "", days_ahead: daysAhead(b.date) });

for (const [k, b] of current) {
  if (open.has(k)) continue;
  const row = { ...b, added_at: firstRun ? "" : now.stamp, removed_at: "" };
  ledger.push(row);
  if (!firstRun) event("added", b);
}
for (const [k, b] of open) {
  if (current.has(k)) continue;
  // Dates roll off the sheet as each weekday row moves to next week. A booking only
  // counts as cancelled if its date is still on the sheet (and not already past).
  if (b.date < now.date || !sheetDates.has(b.date)) continue;
  b.removed_at = now.stamp;
  event("removed", b);
}

ledger.sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || a.added_at.localeCompare(b.added_at));
writeCsv(`${DATA}/bookings.csv`, BOOKING_COLS, ledger);

if (changes.length) {
  const log = readCsv(`${DATA}/changes.csv`).concat(changes);
  writeCsv(`${DATA}/changes.csv`, CHANGE_COLS, log);
}

// ---- usage per date/location from bookings that were never cancelled ----
const usage = new Map();
for (const b of ledger) {
  if (b.removed_at) continue;
  const k = `${b.date}|${b.location}`;
  const u = usage.get(k) || { date: b.date, location: b.location, courts: new Set(), bookings: 0, court_hours: 0 };
  u.courts.add(b.court); u.bookings++; u.court_hours += +b.hours;
  usage.set(k, u);
}
writeCsv(`${DATA}/usage_daily.csv`, ["date", "location", "courts_used", "bookings", "court_hours"],
  [...usage.values()].sort((a, b) => (a.date + a.location).localeCompare(b.date + b.location))
    .map(u => ({ ...u, courts_used: u.courts.size, court_hours: u.court_hours.toFixed(2) })));

console.log(`${now.stamp}: ${current.size} bookings now, ${changes.filter(c => c.change === "added").length} added, ` +
  `${changes.filter(c => c.change === "removed").length} removed${firstRun ? " (baseline)" : ""}.`);
