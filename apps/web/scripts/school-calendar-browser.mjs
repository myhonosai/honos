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

// 0551 card details: programs, instructors (synthetic names), kinds and booked counts, and the commands the page sends.
const programs = { kids: { programId: id(4001), name: 'Kids Karate' }, adults: { programId: id(4002), name: 'Adult Kickboxing' } };
const instructors = [{ principalId: id(4101), displayName: 'Coach Sample' }, { principalId: id(4102), displayName: 'Coach Example' }];
const cardOf = new Map(sessions.map((x) => [x.sessionId, { version: 1, kind: x.name === 'Private lesson' ? 'PRIVATE_LESSON' : 'CLASS',
  program: x.name === 'Adult Kickboxing' ? programs.adults : programs.kids, instructor: x.name === 'Little Tigers' ? instructors[0] : x.name === 'Adult Kickboxing' ? instructors[1] : null,
  booked: x.name === 'Adult Kickboxing' ? 2 : 0, seriesId: x.name === 'Private lesson' ? null : id(4200) }]));
const commands = []; let refuseNextMove = null;
const pacific = (date, minutes) => new Date(Date.parse(`${date}T00:00:00Z`) + (minutes + 8 * 60) * 60_000).toISOString();
function calendarCommand(route, path, body) {
  commands.push({ path: path.slice(prefix.length), body, command: route.request().headers()['x-hon-human-command'], key: route.request().headers()['idempotency-key'] });
  if (path === `${prefix}/schedule/calendar/cards`) {
    const [hh, mm] = body.localStartTime.split(':').map(Number), dates = [];
    if (body.repeatWeekdays) { for (let d = body.localDate, n = 0; n < 84; n++, d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
      const iso = new Date(`${d}T00:00:00Z`).getUTCDay() || 7; if (body.repeatWeekdays.includes(iso) && (!body.repeatUntil || d <= body.repeatUntil)) dates.push(d); } }
    else dates.push(body.localDate);
    const seriesId = body.repeatWeekdays ? id(4300 + commands.length) : null, made = [];
    for (const d of dates) {
      const startsAt = pacific(d, hh * 60 + mm), sessionId = id(5000 + sessions.length);
      sessions.push({ sessionId, name: body.name, startsAt, endsAt: new Date(Date.parse(startsAt) + body.durationMinutes * 60_000).toISOString(), roomName: body.roomName ?? null,
        capacity: body.capacity, bookingPolicy: body.bookingPolicy, status: 'SCHEDULED', createdAt: '2026-11-16T00:00:00.000Z' });
      cardOf.set(sessionId, { version: 1, kind: body.kind, program: Object.values(programs).find((g) => g.programId === body.programId), seriesId,
        instructor: instructors.find((i) => i.principalId === body.instructorPrincipalId) ?? null, booked: 0 });
      made.push(sessionId);
    }
    sessions.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    return json(route, 200, { data: { repeats: !!body.repeatWeekdays, sessionKind: body.kind, sessionId: made[0], seriesId, created: made.length, skippedDates: [] }, meta: meta({ replayed: false }) });
  }
  const sessionId = path.split('/').at(-2), x = sessions.find((y) => y.sessionId === sessionId), c = cardOf.get(sessionId);
  if (refuseNextMove) { const code = refuseNextMove; refuseNextMove = null; return json(route, 409, { code }); }
  if (!x || !c) return json(route, 404, { code: 'CALENDAR_CARD_NOT_FOUND' });
  if (body.expectedVersion !== c.version) return json(route, 409, { code: 'VERSION_CONFLICT' });
  x.startsAt = body.startsAt; x.endsAt = body.endsAt; c.version += 1;
  sessions.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return json(route, 200, { data: { sessionId, version: c.version, startsAt: body.startsAt, endsAt: body.endsAt, detachedFromRoster: c.seriesId !== null }, meta: meta({ replayed: false }) });
}

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
  if (path === `${prefix}/schedule/calendar/cards` && method === 'GET') {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    const cards = sessions.filter((x) => localDate(x.startsAt) >= from && localDate(x.startsAt) <= to).map((x) => { const c = cardOf.get(x.sessionId);
      return { sessionId: x.sessionId, version: c.version, kind: c.kind, programId: c.program.programId, programName: c.program.name, seriesId: c.seriesId, instructor: c.instructor,
        booked: c.booked, attended: x.status === 'COMPLETED' }; });
    return json(route, 200, { data: { timezone: ZONE, localToday: TODAY, from, to, truncated: false, canManage: true, cards, programs: Object.values(programs), instructors }, meta: meta() });
  }
  if (path.startsWith(`${prefix}/schedule/calendar/cards`) && method === 'POST') return calendarCommand(route, path, JSON.parse(route.request().postData() ?? '{}'));
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
const cardButton = (page, name, dayLabel) => calendar(page).locator(`section[aria-label="${dayLabel}"]`).getByRole('button', { name: new RegExp(name) }).first();
await check('click an empty time to add a trial class with a program and instructor', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule');
  await calendar(page).getByTestId('calendar-week').waitFor();
  await calendar(page).getByRole('button', { name: 'Add a class on Nov 20, 2026 at 1:00 PM' }).click({ position: { x: 40, y: 34 } });
  const form = page.getByTestId('calendar-create-form'); await form.waitFor();
  assert.equal(await form.getByLabel('Start time').inputValue(), '13:30');
  assert.equal(await form.getByLabel('Date').inputValue(), '2026-11-20');
  await form.getByText('Trial class', { exact: true }).click();
  await form.getByLabel('Title').fill('Free trial class');
  await form.getByLabel('Program').selectOption({ label: 'Kids Karate' });
  await form.getByLabel('Instructor').selectOption({ label: 'Coach Sample' });
  await shot(page, 'calendar-create-form-desktop-1440');
  await form.getByRole('button', { name: 'Add to calendar' }).click();
  await page.getByTestId('calendar-message').getByText('Added Free trial class.').waitFor();
  const sent = commands.at(-1);
  assert.equal(sent.command, 'schedule.calendar.create'); assert.match(sent.key, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent.body, { kind: 'TRIAL', programId: id(4001), name: 'Free trial class', capacity: 10, bookingPolicy: 'OPTIONAL_BOOKING', localDate: '2026-11-20', localStartTime: '13:30',
    durationMinutes: 60, instructorPrincipalId: id(4101), roomName: null });
  const added = cardButton(page, 'Free trial class', 'Friday, November 20, 2026'); await added.waitFor();
  assert.equal(await added.getAttribute('data-card-kind'), 'TRIAL');
  await shot(page, 'calendar-created-trial-desktop-1440');
  await ctx.close();
});
await check('Add a class makes a weekly roster from the calendar', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule');
  await calendar(page).getByTestId('calendar-week').waitFor();
  await page.getByTestId('calendar-add-class').click();
  const form = page.getByTestId('calendar-create-form'); await form.waitFor();
  await form.getByLabel('Title').fill('Teen Sparring');
  await form.getByLabel('Program').selectOption({ label: 'Adult Kickboxing' });
  await form.getByLabel('Date').fill('2026-11-21'); await form.getByLabel('Start time').fill('11:00');
  await form.getByLabel('Repeats every week').check();
  await form.locator('label', { hasText: /^Wed$/ }).click();
  await shot(page, 'calendar-create-roster-desktop-1440');
  await form.getByRole('button', { name: 'Add to calendar' }).click();
  await page.getByTestId('calendar-message').getByText(/Roster Teen Sparring created with \d+ classes\./).waitFor();
  assert.deepEqual(commands.at(-1).body.repeatWeekdays, [3, 6]);
  await cardButton(page, 'Teen Sparring', 'Saturday, November 21, 2026').waitFor();
  await ctx.close();
});
await check('drag a class to another day and time, drag its bottom edge, and use the keyboard', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule');
  await calendar(page).getByTestId('calendar-week').waitFor();
  const card = cardButton(page, 'Little Tigers', 'Thursday, November 19, 2026');
  assert.equal(await card.getAttribute('data-draggable'), 'true');
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox(), friday = await calendar(page).locator('section[aria-label="Friday, November 20, 2026"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 10); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + 30, { steps: 4 });
  await page.mouse.move(friday.x + friday.width / 2, box.y + 10 + 64, { steps: 6 });
  await calendar(page).getByTestId('calendar-ghost').waitFor();
  assert.match(await calendar(page).getByTestId('calendar-ghost').innerText(), /5:30\s*PM\s*–\s*6:15\s*PM/);
  await shot(page, 'calendar-drag-ghost-desktop-1440');
  await page.mouse.up();
  await page.getByTestId('calendar-message').getByText(/Moved Little Tigers to Fri, Nov 20, 5:30\s*PM\. It no longer follows its roster\./).waitFor();
  let sent = commands.at(-1);
  assert.equal(sent.command, 'schedule.calendar.move');
  assert.deepEqual(sent.body, { expectedVersion: 1, startsAt: '2026-11-21T01:30:00.000Z', endsAt: '2026-11-21T02:15:00.000Z' });
  await shot(page, 'calendar-dropped-desktop-1440');
  // Resize: drag the bottom edge of Friday's 6 PM Adult... (booked) is covered below; resize the Junior Black Belt Club on Thursday.
  const jbbc = calendar(page).locator('section[aria-label="Thursday, November 19, 2026"] li', { hasText: 'Junior Black Belt Club' });
  const handle = jbbc.getByTestId('calendar-resize');
  await handle.scrollIntoViewIfNeeded();
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 36, { steps: 5 });
  await calendar(page).getByTestId('calendar-ghost').waitFor();
  await page.mouse.up();
  await page.getByTestId('calendar-message').getByText(/Moved Junior Black Belt Club/).waitFor();
  sent = commands.at(-1);
  assert.equal((Date.parse(sent.body.endsAt) - Date.parse(sent.body.startsAt)) / 60_000, 90);
  // Keyboard: Alt+Arrow Down moves the focused class 15 minutes later.
  const sat = cardButton(page, 'Family Class', 'Saturday, November 21, 2026');
  await sat.focus(); await page.keyboard.press('Alt+ArrowDown');
  await page.getByTestId('calendar-message').getByText(/Moved Family Class to Sat, Nov 21, 10:15\s*AM/).waitFor();
  // Escape cancels a drag: nothing is sent.
  const before = commands.length, mon = cardButton(page, 'Little Tigers', 'Friday, November 20, 2026');
  await mon.scrollIntoViewIfNeeded();
  const mb = await mon.boundingBox();
  await page.mouse.move(mb.x + 10, mb.y + 10); await page.mouse.down(); await page.mouse.move(mb.x + 10, mb.y + 80, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(commands.length, before);
  assert.equal(await page.getByTestId('calendar-drawer').count(), 0, 'a cancelled drag does not open the panel');
  await noOverflow(page); await ctx.close();
});
await check('a booked class asks first; a stale or locked move is refused and the card stays', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule');
  await calendar(page).getByTestId('calendar-week').waitFor();
  const booked = cardButton(page, 'Adult Kickboxing', 'Friday, November 20, 2026');
  assert.match(await booked.innerText(), /2 booked/);
  const before = commands.length;
  await booked.focus(); await page.keyboard.press('Alt+ArrowRight');
  const bar = page.getByTestId('calendar-message'); await bar.getByText('2 students are booked on Adult Kickboxing. They are not told about the new time.').waitFor();
  assert.equal(commands.length, before, 'nothing is sent before the answer');
  await shot(page, 'calendar-move-booked-confirm-desktop-1440');
  await bar.getByRole('button', { name: 'Keep the old time' }).click();
  assert.equal(commands.length, before);
  refuseNextMove = 'CALENDAR_CARD_LOCKED';
  await booked.focus(); await page.keyboard.press('Alt+ArrowDown');
  await bar.getByRole('button', { name: 'Move it' }).click();
  await bar.getByText('This class has started, ended, been cancelled or has attendance, so it cannot be moved.').waitFor();
  await shot(page, 'calendar-move-refused-desktop-1440');
  assert.equal(await calendar(page).getByTestId('calendar-ghost').count(), 0);
  await ctx.close();
});
await check('Program and Instructor filters combine', async () => {
  const { ctx, page } = await open(viewports.desktop, '/staff/schedule');
  await calendar(page).getByTestId('calendar-week').waitFor();
  const filter = calendar(page).getByTestId('calendar-filter');
  await filter.locator('summary').click();
  await filter.getByRole('group', { name: 'Programs' }).getByLabel('Kids Karate').check();
  await filter.getByRole('group', { name: 'Instructors' }).getByLabel('No instructor').check();
  await shot(page, 'calendar-filter-program-instructor-desktop-1440');
  await page.keyboard.press('Escape');
  assert.equal(await calendar(page).getByRole('button', { name: /Little Tigers|Adult Kickboxing/ }).count(), 0);
  assert.ok(await calendar(page).getByRole('button', { name: /Junior Black Belt Club/ }).count() >= 1);
  await ctx.close();
});
await check('phone: the create form fits the screen', async () => {
  const { ctx, page } = await open(viewports.phone, '/staff/schedule');
  await calendar(page).getByTestId('calendar-week').waitFor();
  await page.getByTestId('calendar-add-class').click();
  await page.getByTestId('calendar-create-form').waitFor();
  await noOverflow(page); await shot(page, 'calendar-create-form-phone-390');
  await ctx.close();
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
