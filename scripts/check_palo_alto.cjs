const { writeFileSync } = require('node:fs');
const { chromium } = require('playwright');

const catalogUrl = 'https://ca-paloalto.civicrec.com/CA/palo-alto-ca/catalog/index/6cd86da977fb5e151a43561e0431e868?filter=c2VhcmNoPWNvdXJ0cyZyZW50YWwlNUJmcm9tJTVEPSZyZW50YWwlNUJ0byU1RD0mcmVudGFsJTVCZnJvbVRpbWUlNUQ9JnJlbnRhbCU1QnRvVGltZSU1RD0mcmVudGFsJTVCZHVyYXRpb24lNUQ9MA%3D%3D';
const timeZone = 'America/Los_Angeles';
const slotMinutes = 30;
const windows = [
  { time: '08:00 AM', startMinute: 480, count: 10 },
  { time: '01:00 PM', startMinute: 780, count: 10 },
  { time: '06:00 PM', startMinute: 1080, count: 8 },
];

function datesFrom(start) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('Expected a start date in YYYY-MM-DD format');
  const day = new Date(start + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== start) {
    throw new Error('Invalid start date');
  }
  return Array.from({ length: 7 }, (_, i) =>
    new Date(day.getTime() + i * 86400000).toISOString().slice(0, 10));
}

function localSlotStamp(date, minute) {
  const [year, month, day] = date.split('-');
  const hour = Math.floor(minute / 60);
  return `${month}/${day}/${year} ${String(hour % 12 || 12).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

function clockTime(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

async function fetchSchedule(dates) {
  const browser = await chromium.launch({
    executablePath: process.env.PALO_ALTO_CHROME_PATH || undefined,
  });
  try {
    const page = await browser.newPage({ timezoneId: timeZone });
    const [grid, availability] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/catalog/facilityGridData/'), { timeout: 25000 }),
      page.waitForResponse(r => r.url().includes('/permits/getMultiFacilityAvailabilityBySlot/'), { timeout: 25000 }),
      (async () => {
        const catalog = await page.goto(catalogUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (!catalog?.ok()) throw new Error(`CivicRec catalog returned HTTP ${catalog?.status()}`);
        await page.getByText('Facility Rentals', { exact: true }).first().click({ timeout: 5000 })
          .catch(() => {}); // The linked catalog can load the grid on its own.
      })(),
    ]);

    if (!grid.ok() || !availability.ok()) throw new Error('CivicRec did not load the public court grid');
    const { location } = await grid.json();
    const fields = new URLSearchParams(availability.request().postData());
    const courtIds = new Set(fields.getAll('facilityIds[]'));
    const courts = location.facilities
      .filter(({ id }) => courtIds.has(String(id)))
      .map(({ id, name }) => ({ id: String(id), name }));
    if (location.name !== 'Courts' || !courts.length || courts.length !== courtIds.size) {
      throw new Error('CivicRec court list does not match the public grid');
    }

    const data = await page.evaluate(async ({ url, input, dates, windows, slotMinutes }) => {
      const responses = [];
      for (const date of dates) {
        for (const { time, count } of windows) {
          const form = new URLSearchParams(input);
          form.set('date', date);
          form.set('time', time);
          form.set('slotSize', String(slotMinutes * 60));
          form.set('slotCount', String(count));
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            body: form,
            signal: AbortSignal.timeout(12000),
          });
          if (!response.ok) throw new Error(`CivicRec returned HTTP ${response.status} for ${date} ${time}`);
          responses.push((await response.json()).availability);
        }
      }
      return responses;
    }, { url: availability.url(), input: fields.toString(), dates, windows, slotMinutes });

    return dates.map((date, dayIndex) => ({
      date,
      courts: courts.map(({ id, name }) => {
        const blocks = [];
        windows.forEach(({ startMinute, count }, windowIndex) => {
          const slots = data[dayIndex * windows.length + windowIndex]?.[id];
          if (!Array.isArray(slots) || slots.length !== count) {
            throw new Error(`Incomplete slots for ${name} on ${date}`);
          }
          slots.forEach(({ date: stamp, status }, i) => {
            const minute = startMinute + i * slotMinutes;
            if (stamp !== localSlotStamp(date, minute) || ![0, 1, 2].includes(status)) {
              throw new Error(`Unexpected slot for ${name} on ${date}`);
            }
            if (status === 2) return;
            const label = status === 1 ? 'partially available' : 'unavailable';
            const start = clockTime(minute);
            const end = clockTime(minute + slotMinutes);
            const previous = blocks.at(-1);
            if (previous?.status === label && previous.end === start) previous.end = end;
            else blocks.push({ start, end, status: label });
          });
        });
        return { name, blocks };
      }),
    }));
  } finally {
    await browser.close();
  }
}

async function main() {
  const [start, output] = process.argv.slice(2);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date());
  const dates = datesFrom(start ?? today);
  const days = await fetchSchedule(dates);
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    timeZone,
    hours: { start: '08:00', end: '22:00' },
    days,
  };
  if (output) writeFileSync(output, JSON.stringify(snapshot, null, 2) + '\n');
  for (const { date, courts } of days) {
    const blocks = courts.reduce((total, court) => total + court.blocks.length, 0);
    console.log(`${date}: ${courts.length} courts, ${blocks} unavailable or partially available blocks`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
