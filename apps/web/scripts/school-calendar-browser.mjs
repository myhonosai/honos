/**
 * Disposable local browser proof for the School Calendar page (Classes > Calendar). Synthetic fixtures only: every /api
 * request is answered in the browser by this script. No database, provider, payment or production backend is used.
 * Requires `pnpm build` first.
 *
 *   HON_CALENDAR_BROWSER_LOCAL=1 HON_CALENDAR_BROWSER_RESULTS=<dir> node apps/web/scripts/school-calendar-browser.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';

if (process.env.HON_CALENDAR_BROWSER_LOCAL !== '1') throw new Error('Opt in with HON_CALENDAR_BROWSER_LOCAL=1.');
for (const key of ['DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) {
  if (process.env[key]) throw new Error('Browser verification refuses inherited database/provider credentials.');
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = process.env.HON_CALENDAR_BROWSER_RESULTS;
assert(results, 'HON_CALENDAR_BROWSER_RESULTS is required.');
const { chromium } = createRequire(import.meta.url)(process.env.HON_CALENDAR_PLAYWRIGHT ?? 'playwright');
await mkdir(results, { recursive: true });

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const school = { organizationId: id(1), schoolId: id(2) };
const prefix = `/api/v1/organizations/${school.organizationId}/schools/${school.schoolId}`;
const report = { syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], pageErrors: [], apiRequests: [] };
const ZONE = 'America/Los_Angeles', TODAY = '2026-11-16';
let eventsDenied = false;

// Classes in November and December 2026 (Pacific Standard Time, UTC-8), in start order.
const sessions = [];
for (let t = Date.UTC(2026, 10, 1); t < Date.UTC(2027, 0, 1); t += 86_400_000) {
  const date = new Date(t).toISOString().slice(0, 10), weekday = new Date(t).getUTCDay();
  const add = (name, hh, mm, room, minutes = 60, status = 'SCHEDULED') => {
    const startsAt = new Date(t + ((hh + 8) * 60 + mm) * 60_000).toISOString();
    sessions.push({ sessionId: id(1000 + sessions.length), name, startsAt, endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(), roomName: room, capacity: 20,
      bookingPolicy: 'OPTIONAL_BOOKING', status: date < TODAY ? 'COMPLETED' : status, createdAt: '2026-10-01T00:00:00.000Z' });
  };
  const thanksgiving = date === '2026-11-26' ? 'CANCELLED' : 'SCHEDULED';
  if (weekday >= 1 && weekday <= 5) { add('Little Tigers', 16, 30, 'Main mat', 45, thanksgiving); add('Adult Kickboxing', 18, 0, 'Studio B', 60, thanksgiving); }
  if (weekday === 2 || weekday === 4) add('Junior Black Belt Club', 17, 15, 'Main mat', 60, thanksgiving);
  if (weekday === 2) add('Private lesson', 15, 0, 'Studio B', 30);
  if (weekday === 6) add('Family Class', 10, 0, 'Main mat');
}
sessions.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
const localDate = (instant) => new Date(Date.parse(instant) - 8 * 3_600_000).toISOString().slice(0, 10);
const hex = (n) => n.toString(16).padStart(48, '0');
const event = (n, title, date, opensAt, closesAt, status, booked) => ({ eventId: id(2000 + n), publicId: hex(n + 1), title, description: '', place: 'Front desk', localDate: date, opensAt, closesAt,
  slotMinutes: 30, spotsPerSlot: 4, status, version: 1, slotCount: 8, bookedCount: booked, createdAt: '2026-11-01T00:00:00.000Z' });
const events = [event(1, 'Open house', '2026-11-21', '10:00', '12:00', 'PUBLISHED', 6), event(2, 'Black Friday sale day', '2026-11-27', '09:00', '13:00', 'PUBLISHED', 11),
  event(3, 'Belt test', '2026-12-12', '09:00', '12:00', 'DRAFT', 0)];
const students = [['Avery', 'Sample'], ['Rowan', 'Example'], ['Kim', 'Placeholder'], ['Jordan', 'Synthetic']].map(([givenName, familyName], n) => ({ studentProfileId: id(3000 + n), givenName, familyName }));
const roster = students.slice(0, 3).map((s, n) => ({ ...s, personId: id(3100 + n), studentStatus: 'ACTIVE',
  booking: { id: id(3200 + n), kind: n === 2 ? 'TRIAL' : 'REGULAR', status: 'BOOKED', source: 'STAFF', bookedAt: '2026-11-10T00:00:00.000Z', cancelledAt: null, version: 1 },
  attendance: n === 0 ? { id: id(3300), status: 'PRESENT', category: 'REGULAR_PARTICIPANT', recordedAt: '2026-11-16T00:40:00.000Z', version: 1 } : null }));

const json = (route, status, body) => route.fulfill({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
const meta = (extra = {}) => ({ requestId: id(9000), correlationId: id(9000), ...extra });
function api(route) {
  const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
  report.apiRequests.push(`${method} ${path}${url.search}`);
  if (path === '/api/identity/me') return json(route, 200, { data: { externalSubject: 'calendar-synthetic-owner', displayName: 'Synthetic Owner' } });
  if (path === '/api/v1/staff/current-reporting-school') return json(route, 200, { data: { state: 'RESOLVED', ...school } });
  if (path === '/api/v1/staff/reporting-schools') return json(route, 200, { data: { state: 'MANUAL_ENTRY_REQUIRED' } });
  if (path === `${prefix}/reports/operations`) return json(route, 200, { data: { operationalSnapshot: { organizationId: school.organizationId, schoolId: school.schoolId, generatedAt: '2026-11-16T09:00:00.000Z',
    from: '2026-10-17T09:00:00.000Z', to: '2026-11-16T09:00:00.000Z', studentProfiles: { total: 148 }, leads: { byStatus: { OPEN: 23, WON: 9, LOST: 4, ARCHIVED: 2 } },
    classSessions: { inRange: { scheduled: 64, completed: 58, cancelled: 2 } }, attendance: { inRangeByStatus: { PRESENT: 812, LATE: 31, EXCUSED_ABSENCE: 22, UNEXCUSED_ABSENCE: 15, MAKEUP: 6 } },
    memberships: { byState: { DRAFT: 3, ACTIVE: 131, FROZEN: 4, CANCELLATION_PENDING: 2, CANCELLED: 7, EXPIRED: 5 } }, invoices: { inRangeByStatus: { DRAFT: 2, ISSUED: 6, PAID: 118, VOID: 1, UNCOLLECTIBLE: 0 } },
    paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 1, SUCCEEDED: 118, FAILED: 3, REQUIRES_ACTION: 0, UNKNOWN: 0, REFUNDED: 1 } } } }, meta: {} });
  if (path === `${prefix}/schedule/sessions/list`) {
    const from = url.searchParams.get('from') ?? TODAY, offset = Number(url.searchParams.get('cursor') ?? '0');
    const all = sessions.filter((s) => localDate(s.startsAt) >= from), page = all.slice(offset, offset + 50);
    return json(route, 200, { data: page, meta: meta({ limit: 50, nextCursor: offset + 50 < all.length ? String(offset + 50) : null, schoolTimezone: ZONE, localToday: TODAY, fromDate: from }) });
  }
  if (/\/schedule\/sessions\/[0-9a-f-]{36}\/roster$/.test(path)) return json(route, 200, { data: roster, meta: meta({ limit: 50, nextCursor: null }) });
  if (path === `${prefix}/schedule/sessions`) return json(route, 200, { data: sessions.filter((s) => s.status === 'SCHEDULED').slice(0, 40), meta: meta() });
  if (path === `${prefix}/schedule/bookable-students`) return json(route, 200, { data: students, meta: meta() });
  if (path === `${prefix}/schedule/events`) return eventsDenied ? json(route, 403, { code: 'FORBIDDEN' }) : json(route, 200, { data: { localToday: TODAY, timezone: ZONE, events }, meta: meta() });
  if (path === `${prefix}/schedule/class-series`) {
    const roster = (n, name, weekdays, localStartTime, durationMinutes, futureSessions) => ({ seriesId: id(4000 + n), programId: id(4100 + n), name, roomName: 'Main mat', capacity: 20,
      bookingPolicy: 'OPTIONAL_BOOKING', weekdays, localStartTime, durationMinutes, startsOn: '2026-11-02', endsOn: null, generatedThrough: '2027-01-24', status: 'ACTIVE', endReason: null,
      version: 2, ongoing: n === 1, futureSessions, createdAt: '2026-11-01T08:00:00.000Z' });
    return json(route, 200, { data: { localToday: TODAY, timezone: ZONE, fillLimit: '2027-02-08', topUpDue: false,
      series: [roster(1, 'Little Tigers', [1, 2, 3, 4, 5], '16:30', 45, 50), roster(2, 'Junior Black Belt Club', [2, 4], '17:15', 60, 20)],
      programs: [{ programId: id(4101), name: 'Little Tigers' }, { programId: id(4102), name: 'Junior Black Belt Club' }] }, meta: meta() });
  }
  if (path === `${prefix}/schedule/timetable`) {
    const of = Date.parse(`${url.searchParams.get('weekOf') ?? TODAY}T00:00:00Z`), start = of - ((new Date(of).getUTCDay() + 6) % 7) * 86_400_000;
    const weekStart = new Date(start).toISOString().slice(0, 10);
    const weekEnd = new Date(start + 6 * 86_400_000).toISOString().slice(0, 10);
    const inWeek = sessions.filter((x) => localDate(x.startsAt) >= weekStart && localDate(x.startsAt) <= weekEnd).map((x) => {
      const local = new Date(Date.parse(x.startsAt) - 8 * 3_600_000).toISOString(), end = new Date(Date.parse(x.endsAt) - 8 * 3_600_000).toISOString();
      return { sessionId: x.sessionId, seriesId: x.name === 'Little Tigers' ? id(4001) : x.name === 'Junior Black Belt Club' ? id(4002) : null, name: x.name, roomName: x.roomName,
        startsAt: x.startsAt, endsAt: x.endsAt, localDate: local.slice(0, 10), localStart: local.slice(11, 16), localEnd: end.slice(11, 16), capacity: x.capacity,
        bookingPolicy: x.bookingPolicy, status: x.status, booked: 3 };
    });
    return json(route, 200, { data: { timezone: ZONE, localToday: TODAY, weekStart, weekEnd, truncated: false, sessions: inWeek }, meta: meta() });
  }
  return json(route, 403, { code: 'FORBIDDEN' });
}

const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const session = { mode: 'OIDC', audience: 'school-calendar-browser-synthetic', secret: randomBytes(32).toString('hex') };
const server = spawn(join(webRoot, 'node_modules/.bin/next'), ['start', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: webRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
  NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:9', HON_AUTH_MODE: session.mode,
  HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 240; i += 1) { try { const r = await fetch(`${origin}/auth/login`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((done) => setTimeout(done, 500)); }

const browser = await chromium.launch();
const viewports = { desktop: { width: 1440, height: 1000 }, phone: { width: 390, height: 844 } };
async function open(viewport, path) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: Number(process.env.HON_CALENDAR_SCALE ?? '1'), reducedMotion: 'reduce' });
  await ctx.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'calendar-synthetic-owner' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) return api(route);
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(String(error)));
  await page.goto(`${origin}${path}`);
  return { ctx, page };
}
async function check(name, work) { try { await work(); report.checks.push(name); } catch (error) { report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
async function shot(page, name, fullPage = false) { await page.screenshot({ path: join(results, `${name}.png`), fullPage }); report.screenshots.push(`${name}.png`); }
const noOverflow = async (page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'page scrolls horizontally');
const calendar = (page) => page.getByTestId('school-calendar');

await check('week view shows classes and sale days; a class opens its students and books in place', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule');
  await calendar(page).getByTestId('calendar-week').waitFor();
  assert.match(await page.getByTestId('calendar-range').innerText(), /Nov 16.*22, 2026/);
  await calendar(page).getByRole('button', { name: /Open house/ }).waitFor();
  assert.ok(await calendar(page).getByRole('button', { name: /Little Tigers/ }).count() >= 5);
  await shot(page, 'calendar-week-desktop-1440');
  await calendar(page).getByRole('button', { name: /Little Tigers/ }).nth(1).click();
  await page.getByTestId('roster-table').waitFor();
  assert.ok(await page.getByText('Avery Sample').isVisible());
  await shot(page, 'calendar-class-roster-desktop-1440');
  await page.getByRole('button', { name: 'Book a student on this class' }).click();
  await page.getByTestId('calendar-booking').waitFor();
  await shot(page, 'calendar-class-booking-desktop-1440');
  await page.getByRole('button', { name: 'Back to the students' }).click();
  await page.getByTestId('roster-table').waitFor();
  await noOverflow(page); await ctx.close();
});
await check('one compact Filter menu narrows the calendar to the chosen classes', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule');
  await calendar(page).getByTestId('calendar-week').waitFor();
  const filter = calendar(page).getByTestId('calendar-filter');
  await filter.locator('summary').click();
  await shot(page, 'calendar-filter-open-desktop-1440');
  await filter.getByLabel('Little Tigers').check();
  await filter.getByLabel('Junior Black Belt Club').check();
  await page.keyboard.press('Escape'); await filter.locator('summary').click();
  assert.equal(await calendar(page).getByRole('button', { name: /Adult Kickboxing/ }).count(), 0);
  assert.ok(await calendar(page).getByRole('button', { name: /Little Tigers/ }).count() >= 5);
  assert.match(await filter.locator('summary').getAttribute('aria-label'), /Show classes: 2 classes/);
  await shot(page, 'calendar-filter-applied-desktop-1440');
  await calendar(page).getByRole('button', { name: 'Show all' }).last().click();
  assert.ok(await calendar(page).getByRole('button', { name: /Adult Kickboxing/ }).count() >= 5);
  await ctx.close();
});
await check('Weekly timetable tab calls repeating classes Rosters', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule?tab=timetable');
  await page.getByRole('heading', { name: 'Rosters' }).waitFor();
  await shot(page, 'timetable-rosters-desktop-1440', true);
  await ctx.close();
});
await check('month view, "+N more" day links, an event panel and the events tab', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule?view=month');
  await calendar(page).getByTestId('calendar-month').waitFor();
  assert.equal(await page.getByTestId('calendar-range').innerText(), 'November 2026');
  await calendar(page).getByRole('button', { name: /Black Friday sale day/ }).click();
  await page.getByTestId('calendar-event-detail').waitFor();
  assert.ok(await page.getByText('11 of 32').isVisible());
  await shot(page, 'calendar-month-event-desktop-1440');
  assert.ok(await calendar(page).getByRole('button', { name: /^Show all \d+ items on/ }).count() > 0);
  await page.getByRole('button', { name: 'Manage on Sale days & events' }).click();
  await page.waitForFunction(() => location.search === '?tab=events');
  assert.equal(await page.getByRole('tab', { name: 'Sale days & events' }).getAttribute('aria-selected'), 'true');
  await ctx.close();
});
await check('day view from a date, previous and next, a cancelled class', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule?view=month');
  await calendar(page).getByTestId('calendar-month').waitFor();
  await calendar(page).getByRole('button', { name: 'Thursday, November 26, 2026' }).click();
  await calendar(page).getByTestId('calendar-day').waitFor();
  assert.ok(await calendar(page).getByText('Cancelled').first().isVisible());
  await page.getByRole('button', { name: 'Next' }).click();
  await calendar(page).getByRole('button', { name: /Black Friday sale day/ }).waitFor();
  await shot(page, 'calendar-day-desktop-1440');
  await ctx.close();
});
await check('old addresses land on the Calendar page tabs; the menu has one Calendar entry', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule/timetable');
  await page.waitForURL(/\/staff\/schedule\?tab=timetable$/);
  assert.equal(await page.getByRole('tab', { name: 'Weekly timetable' }).getAttribute('aria-selected'), 'true');
  await page.goto(`${origin}/staff/schedule/events`); await page.waitForURL(/\/staff\/schedule\?tab=events$/);
  await page.goto(`${origin}/staff/schedule/sessions`); await page.waitForURL(/\/staff\/schedule$/);
  await calendar(page).getByTestId('calendar-week').waitFor();
  await ctx.close();
});
await check('classes still show when sale days are hidden for the role', async () => {
  eventsDenied = true;
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule');
  await page.getByText('Sale days and events are shown only to staff who manage the schedule.').waitFor();
  assert.ok(await calendar(page).getByRole('button', { name: /Little Tigers/ }).count() >= 5);
  eventsDenied = false; await ctx.close();
});
await check('phone: week and month fit the screen', async () => {
  const { ctx, page } = await open(viewports.phone, '/staff/schedule');
  await calendar(page).getByTestId('calendar-week').waitFor();
  await noOverflow(page); await shot(page, 'calendar-week-phone-390');
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await calendar(page).getByTestId('calendar-month').waitFor();
  await noOverflow(page); await shot(page, 'calendar-month-phone-390');
  await ctx.close();
});

await browser.close(); server.kill('SIGTERM');
report.pageErrors = [...new Set(report.pageErrors)];
await writeFile(join(results, 'school-calendar-browser-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures, pageErrors: report.pageErrors.slice(0, 5) }, null, 2));
if (report.failures.length || report.pageErrors.length) { console.error(serverLog.slice(-3000)); process.exitCode = 1; }
