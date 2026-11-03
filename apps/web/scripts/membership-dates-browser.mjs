/** Test-only localhost fixtures. Real session gate and production Next UI; no application auth bypass. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MEMBERSHIP_DATE_REVISION_CONFIRMATION, MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED, validateMembershipDateRevisionPreviewInput,
  validateConfirmMembershipDateRevisionInput, validateMembershipDateConfirmationQueueInput, verifyMembershipDateRevisionPreview,
  verifyMembershipDateRevisionReceipt, verifyMembershipDateHistory, verifySchoolMembershipStatusSummary, verifyMembershipActivationReceipt } from '@hon/contracts';

export function createDateFixture({ id, scope, origin, send, rejected }) {
  let membershipId = id(90), boundPlan = null, planCode = 'JUNIOR-MONTHLY';
  const prefix = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}`, root = `${prefix}/billing/memberships`;
  const original = { source: 'ACTIVATION', periodVersion: 1, changeKind: 'INITIAL', startDate: '2026-10-01', endDate: '2026-10-31', endDateInclusive: true, schoolTimezone: 'America/Los_Angeles', termStartedAt: '2026-10-01T07:00:00.000Z', termEndsAt: '2026-11-01T07:00:00.000Z' };
  let mode, version, period, keys, commands, reads, finish, held, signalHeld, lastReason, lastReasonCode;
  function reset(next = 'routine') { membershipId = id(90); boundPlan = null; planCode = 'JUNIOR-MONTHLY'; mode = next; lastReason='Synthetic staff reviewed the dates.'; lastReasonCode='MEMBER_REQUESTED'; version = 2; period = next === 'legacy' ? null : { ...original }; keys = new Map(); commands = []; reads = []; finish = null; held = new Promise(done => { signalHeld = done; }); }
  function bindActivation(recorded) {
    assert(recorded); const receipt = verifyMembershipActivationReceipt(recorded.receipt, recorded.receipt.membershipId);
    assert([id(7),id(70),id(71),id(80)].includes(receipt.membershipId)); reset(); membershipId = receipt.membershipId; version = receipt.version; boundPlan = recorded.plan; planCode = recorded.planCode;
    const p = receipt.effectivePeriod; period = {source:'ACTIVATION',changeKind:'INITIAL',periodVersion:p.periodVersion,startDate:p.startDate,endDate:p.endDate,endDateInclusive:true,schoolTimezone:p.schoolTimezone,termStartedAt:p.termStartedAt,termEndsAt:p.termEndsAt};
  }
  reset();
  const postRead = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify({ data, meta: { requestId: id(8), correlationId: id(8) } })); };
  function history() {
    return verifyMembershipDateHistory({ membershipId, state: 'ACTIVE', version, schoolTimezone: original.schoolTimezone, localToday: '2026-10-23', effectiveStatus: period ? period.startDate > '2026-10-23' ? 'SCHEDULED' : period.endDate && period.endDate < '2026-10-23' ? 'ENDED' : 'IN_EFFECT' : 'UNDATED', datesConfirmed: !!period, currentPeriod: period, legacyStoredTerm: period ? null : { termStartedAt: null, termEndsAt: null }, versions: period ? [{ periodVersion: period.periodVersion, changeKind: period.changeKind, startDate: period.startDate, endDate: period.endDate, schoolTimezone: period.schoolTimezone, dateSource: 'SUGGESTED', reasonCode: lastReasonCode, reasonText: lastReason, actorDisplayName: 'Synthetic Staff', recordedAt: '2026-10-23T12:00:00.000Z', retroactiveDays: null, acknowledgedWarnings: [] }] : [] });
  }
  function preview(input) {
    const suggested = { startDate: period?.startDate ?? '2026-11-01', endDate: input.changeKind === 'EXTENSION' ? '2026-11-30' : period?.endDate ?? null };
    const dates = 'startDate' in input ? { startDate: input.startDate, endDate: input.endDate } : suggested;
    const future = dates.startDate > '2026-10-23', retro = mode === 'retroactive', financial = mode === 'financial';
    const unchanged = period && dates.startDate === period.startDate && dates.endDate === period.endDate;
    const data = { membershipId, state: 'ACTIVE', version, participantPersonId: id(91), participantDisplayName: 'Synthetic Morgan Lee', planCode, plan: boundPlan ?? { membershipPlanId: id(92), membershipPlanVersion: 2, terms: { displayName: 'Junior martial arts', termKind: 'FIXED_MONTHS', termMonths: 1 } },
      schoolTimezone: original.schoolTimezone, localToday: '2026-10-23', changeKind: input.changeKind, currentPeriod: period, legacyStoredTerm: period ? null : { termStartedAt: null, termEndsAt: null },
      suggestedDates: { ...suggested, startBasis: period ? 'CURRENT_START' : 'LEGACY_STORED_START', endBasis: 'PLAN_FIXED_TERM_ANCHORED' }, proposedDates: { ...dates, dateSource: dates.startDate === suggested.startDate && dates.endDate === suggested.endDate ? 'SUGGESTED' : 'STAFF_ADJUSTED' },
      projection: unchanged ? {termStartedAt:period.termStartedAt,termEndsAt:period.termEndsAt} : { termStartedAt: `${dates.startDate}T07:00:00.000Z`, termEndsAt: dates.endDate === null ? null : '2026-12-01T08:00:00.000Z' }, effectiveStatusNow: history().effectiveStatus, effectiveStatusIfConfirmedNow: future ? 'SCHEDULED' : 'IN_EFFECT',
      retroactiveDays: { added: retro ? 2 : 0, removed: 0 }, financialFacts: { invoices: financial ? [{ invoiceId: id(93), status: 'PAID', dueDate: '2026-10-01' }] : [], invoicesTruncated: false, schedules: [], schedulesTruncated: false },
      warnings: [...(future ? [{ code: 'START_DATE_IN_FUTURE', days: 9 }] : []), ...(retro ? [{ code: 'RETROACTIVE_CHANGE', added: 2, removed: 0 }] : []), ...(financial ? [{ code: 'PAID_INVOICE_NOT_REFUNDED_OR_CREDITED', count: 1 }] : [])],
      blocks: mode === 'blocked' ? [{ code: 'DATE_CHANGE_CONFLICTS_WITH_OPEN_INVOICE' }] : unchanged ? [{ code: 'DATES_UNCHANGED' }] : [], requiredPermissions: ['billing.membership.dates.revise', ...(retro ? ['billing.membership.dates.retroactive'] : [])], requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED], canConfirm: !retro && mode !== 'blocked' && !unchanged, previewDigest: 'a'.repeat(64), confirmation: MEMBERSHIP_DATE_REVISION_CONFIRMATION };
    data.previewDigest = createHash('sha256').update(JSON.stringify(data)).digest('hex'); return verifyMembershipDateRevisionPreview(data);
  }
  async function handle(req, res, url) {
    if (!(url.pathname.startsWith(`${root}/${membershipId}/effective-period/`) || url.pathname === `${root}/date-confirmation-queue` || url.pathname === `${prefix}/reports/membership-status`)) return false;
    if (mode === 'revoked') { rejected(res, 403, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'); return true; }
    const step = url.pathname.endsWith('/history') ? 'history' : url.pathname.endsWith('/preview') ? 'preview' : url.pathname.endsWith('/revisions') ? 'revise' : url.pathname.endsWith('/date-confirmation-queue') ? 'queue' : 'summary';
    const markers = { history: 'billing.membership.dates.history', preview: 'billing.membership.dates.preview', revise: 'billing.membership.dates.revise', queue: 'billing.membership.dates.queue' };
    assert.equal(url.search, '');
    if (step === 'summary') {
      assert.equal(req.method, 'GET'); assert.equal(req.headers['idempotency-key'], undefined); reads.push({ step });
      postRead(res, verifySchoolMembershipStatusSummary({ ...scope, generatedAt: '2026-10-23T12:00:00.000Z', schoolTimezone: original.schoolTimezone, localToday: '2026-10-23', windowEndDate: '2026-11-22', lifecycle: { DRAFT: 1, ACTIVE: 4, FROZEN: 0, CANCELLATION_PENDING: 0, CANCELLED: 0, EXPIRED: 0 }, activeByEffectiveStatus: { SCHEDULED: 1, IN_EFFECT: 1, ENDED: 1, UNDATED: 1 }, undatedHints: { storedTermInEffect: 0, storedTermEnded: 0, storedTermFuture: 0, noStoredStart: 1 }, confirmedStartingNext30Days: 1, confirmedEndingNext30Days: 1 })); return true;
    }
    assert.equal(req.method, 'POST'); assert.equal(req.headers.origin, origin); assert.equal(req.headers['sec-fetch-site'], 'same-origin'); assert.equal(req.headers['sec-fetch-mode'], 'same-origin'); assert.equal(req.headers['x-hon-human-command'], markers[step]);
    let raw = ''; for await (const chunk of req) { raw += chunk; assert(raw.length < 8000); } const input = JSON.parse(raw), key = req.headers['idempotency-key'];
    if (mode === 'readonly' && step === 'preview') { rejected(res, 403, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'); return true; }
    if (step !== 'revise') { assert.equal(key, undefined); reads.push({ step, input }); }
    if (step === 'history') { assert.deepEqual(input, {}); postRead(res, history()); return true; }
    if (step === 'queue') { validateMembershipDateConfirmationQueueInput(input); postRead(res, { items: period ? [] : [{ membershipId, participantDisplayName: 'Synthetic Morgan Lee', planCode: 'JUNIOR-MONTHLY', legacyStoredTerm: { termStartedAt: null, termEndsAt: null }, createdAt: '2026-10-01T12:00:00.000Z' }], next: null }); return true; }
    if (step === 'preview') { validateMembershipDateRevisionPreviewInput(input); send(res, 200, preview(input)); return true; }
    validateConfirmMembershipDateRevisionInput(input); assert.match(key, /^[a-f0-9-]{36}$/); commands.push({ raw, key });
    if (keys.has(key)) { const old = keys.get(key); assert.equal(old.raw, raw); send(res, 200, old.data, true); return true; }
    if (mode === 'stale') { rejected(res, 409, 'DATE_REVISION_PREVIEW_STALE'); return true; }
    const p = preview({ changeKind: input.changeKind, startDate: input.startDate, endDate: input.endDate }); assert.equal(p.canConfirm, true); assert.equal(p.previewDigest, input.previewDigest); assert.equal(input.expectedVersion, version); assert.equal(input.expectedPeriodVersion, period?.periodVersion ?? null); assert.deepEqual(input.acknowledgedWarnings, p.warnings.map(w => w.code));
    const data = verifyMembershipDateRevisionReceipt({ membershipId, state: 'ACTIVE', previousVersion: version, version: version + 1, revisionId: id(94), changeKind: input.changeKind, decisionBasis: 'STAFF_REVISION_PRE_POLICY', authorizingPermission: 'billing.membership.dates.revise', retroactivePermission: null,
      previousPeriod: { periodVersion: period?.periodVersion ?? null, startDate: period?.startDate ?? null, endDate: period?.endDate ?? null, legacyTermStartedAt: null, legacyTermEndsAt: null },
      effectivePeriod: { periodVersion: (period?.periodVersion ?? 0) + 1, startDate: input.startDate, endDate: input.endDate, endDateInclusive: true, schoolTimezone: p.schoolTimezone, dateSource: input.dateSource, ...p.projection }, effectiveStatusAtRevision: p.effectiveStatusIfConfirmedNow, retroactiveDays: p.retroactiveDays, acknowledgedWarnings: input.acknowledgedWarnings, reasonCode: input.reasonCode, financialEffects: [], followUps: mode === 'financial' ? [{ kind: 'BILLING_REVIEW', workItemId: id(95) }] : [], requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED], approval: null, recordedAt: '2026-10-23T12:00:00.000Z' });
    keys.set(key, { raw, data }); lastReason=input.reasonText; lastReasonCode=input.reasonCode; version++; period = { source: 'REVISION', changeKind: input.changeKind, ...data.effectivePeriod }; delete period.dateSource;
    if (mode.startsWith('hold-')) await new Promise(done => { finish = done; signalHeld(); });
    if (mode.includes('unknown')) { mode = 'routine'; rejected(res, 503, 'MEMBERSHIP_LIFECYCLE_UNAVAILABLE'); } else send(res, 200, data);
    return true;
  }
  return { reset, bindActivation, handle, scope, get membershipId() { return membershipId; }, get commands() { return commands; }, get reads() { return reads; }, waitUntilHeld: () => held, release() { assert(finish); finish(); }, setMode(next) { mode = next; } };
}

export async function runDateBrowserChecks({ fixture, open, visual, check, origin }) {
  async function begin(page, legacy = false) {
    await page.goto(origin + '/staff/billing/membership-dates'); assert.equal(fixture.reads.length, 0); assert.equal(fixture.commands.length, 0);
    await page.getByLabel('Organization ID', { exact: true }).fill(fixture.scope.organizationId); await page.getByLabel('School ID', { exact: true }).fill(fixture.scope.schoolId); await page.getByLabel('Already-known membership ID').fill(fixture.membershipId);
    await page.getByRole('button', { name: 'Load membership dates', exact: true }).focus(); await page.keyboard.press('Enter'); await page.getByRole('heading', { name: 'Verified current membership' }).waitFor();
    if (!legacy) { await page.getByRole('button', { name: 'Extend', exact: true }).click(); await page.getByText('Nov 30, 2026', { exact: true }).first().waitFor(); }
    else { await page.getByLabel('Start date', { exact: true }).fill('2026-11-01'); await page.getByRole('heading', { name: 'Step 1 · Review date change' }).waitFor(); }
  }
  async function final(page, legacy = false) {
    const warnings = page.getByRole('checkbox').filter({ hasNotText: /^I confirm/ }); // final confirmation is not mounted yet
    for (let i = 0; i < await warnings.count(); i++) await warnings.nth(i).check();
    await page.getByLabel('Reason category', { exact: true }).selectOption(legacy ? 'LEGACY_RECORDS_REVIEWED' : 'MEMBER_REQUESTED');
    await page.getByLabel('Reason for this change', { exact: false }).fill('The school reviewed and confirmed these exact dates.');
    await page.getByRole('button', { name: 'Review final date confirmation', exact: true }).click(); await page.getByRole('heading', { name: 'Step 2 · Confirm date change' }).waitFor();
    await page.getByRole('checkbox', { name: /^I confirm this exact date change/ }).check();
  }
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const event of ['pagehide', 'hon:session-invalidated', 'hon:school-context-changed']) await check(`${size}: ${event} immediately conceals mounted facts and requires an explicit authorized read`, async () => {
      fixture.reset(); const { context, page } = await open(viewport);
      try {
        await begin(page);
        const synchronous = await page.evaluate(name => {
          window.dispatchEvent(new Event(name));
          return [...document.querySelectorAll('main [hidden][inert]')].some(node => node.textContent.includes('Synthetic Morgan Lee'));
        }, event);
        assert.equal(synchronous, true, 'Protected DOM must be hidden before a React rerender');
        await page.getByRole('heading', { name: 'Membership information hidden' }).waitFor();
        assert.equal(await page.getByText('Synthetic Morgan Lee', { exact: true }).count(), 0);
        const reads = fixture.reads.length;
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        assert.equal(fixture.reads.length, reads, 'Focus alone must not read or reveal');
        await page.getByRole('button', { name: 'Verify access and resume' }).click();
        await page.getByRole('heading', { name: 'Verified current membership' }).waitFor();
        assert(fixture.reads.length > reads); assert.equal(fixture.commands.length, 0);
        await visual(page, `${size}-dates-${event.replaceAll(':', '-')}`);
      } finally { await context.close(); }
    });
    await check(`${size}: date extension, distinct final confirmation, immutable receipt/history, keyboard and axe`, async () => {
      fixture.reset(); const { context, page } = await open(viewport); try {
        await begin(page); assert.equal(fixture.commands.length, 0); await visual(page, `${size}-dates-preview`); await final(page); await visual(page, `${size}-dates-confirm`);
        await page.getByRole('button', { name: 'Confirm membership date change', exact: true }).focus(); await page.keyboard.press('Enter'); await page.getByRole('heading', { name: 'Membership date revision receipt' }).waitFor(); assert.equal(fixture.commands.length, 1); await visual(page, `${size}-dates-receipt`);
        await page.getByRole('button', { name: 'Refresh verified current dates and history' }).click(); await page.getByRole('heading', { name: 'Date history · newest first' }).waitFor(); assert((await page.getByRole('main').innerText()).includes('Period 2')); await visual(page, `${size}-dates-history`);
      } finally { await context.close(); }
    });
    for (const outcome of ['success', 'unknown']) await check(`${size}: date ${outcome} settles concealed, access restore and exact retry without reload`, async () => {
      fixture.reset('hold-' + outcome); const { context, page } = await open(viewport); try {
        await begin(page); await final(page); await page.getByRole('button', { name: 'Confirm membership date change', exact: true }).evaluate(b => { b.click(); b.click(); }); await fixture.waitUntilHeld(); assert.equal(fixture.commands.length, 1);
        await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.getByRole('heading', { name: 'Membership information hidden' }).waitFor(); assert(await page.getByRole('button', { name: 'Verify access and resume' }).isDisabled()); assert.equal(await page.getByText('Synthetic Morgan Lee', { exact: true }).count(), 0);
        fixture.release(); await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Verify access and resume')?.disabled);
        await page.getByRole('button', { name: 'Verify access and resume' }).click(); await page.getByRole('heading', { name: 'Verified current membership' }).waitFor();
        if (outcome === 'unknown') { assert.equal(fixture.commands.length, 1); await page.getByRole('button', { name: 'Retry exact retained date change' }).click(); await page.getByText('Verified idempotent replay.', { exact: false }).waitFor(); assert.deepEqual(fixture.commands[1], fixture.commands[0]); }
        else await page.getByRole('heading', { name: 'Membership date revision receipt' }).waitFor();
        await visual(page, `${size}-dates-restored-${outcome}`);
      } finally { await context.close(); }
    });
    await check(`${size}: missing retroactive permission, blockers and stale previews cannot silently revise`, async () => {
      fixture.reset('retroactive'); const { context, page } = await open(viewport); try { await begin(page); assert(await page.getByRole('button', { name: 'Review final date confirmation' }).isDisabled()); await visual(page, `${size}-dates-retroactive-denied`); assert.equal(fixture.commands.length, 0); } finally { await context.close(); }
      fixture.reset('blocked'); const b = await open(viewport); try { await begin(b.page); assert(await b.page.getByRole('button', { name: 'Review final date confirmation' }).isDisabled()); assert.equal(fixture.commands.length, 0); } finally { await b.context.close(); }
      fixture.reset('stale'); const c = await open(viewport); try {
        await begin(c.page); await final(c.page);
        await c.page.getByRole('button', { name: 'Confirm membership date change', exact: true }).click();
        // The global HON shell may independently announce an unavailable feature. Only
        // the exact date-contract refusal proves that this command actually settled.
        await c.page.getByRole('alert').filter({ hasText: 'The reviewed facts changed.' }).waitFor();
        assert.equal(fixture.commands.length, 1);
        assert.equal(await c.page.getByRole('button', { name: 'Retry exact retained date change' }).count(), 0);
      } catch (error) {
        await visual(c.page, `${size}-dates-stale-failure`);
        throw error;
      } finally { await c.context.close(); }
    });
    await check(`${size}: individually confirm legacy dates; load separate summary without financial commands`, async () => {
      fixture.reset('legacy'); const { context, page } = await open(viewport); try {
        await begin(page, true); await visual(page, `${size}-dates-legacy`); await final(page, true); await page.getByRole('button', { name: 'Confirm membership date change', exact: true }).click(); await page.getByRole('heading', { name: 'Membership date revision receipt' }).waitFor(); assert.equal(JSON.parse(fixture.commands[0].raw).expectedPeriodVersion, null);
        await page.getByRole('button', { name: 'Load status summary', exact: true }).click(); await page.getByRole('heading', { name: 'ACTIVE by confirmed effective status' }).waitFor(); await visual(page, `${size}-dates-summary`);
      } finally { await context.close(); }
    });
    await check(`${size}: read-only access, revoked access and session switching never gain mutation authority`, async () => {
      fixture.reset('readonly'); const { context, page } = await open(viewport); try {
        await page.goto(origin + '/staff/billing/membership-dates'); await page.getByLabel('Organization ID', { exact: true }).fill(fixture.scope.organizationId); await page.getByLabel('School ID', { exact: true }).fill(fixture.scope.schoolId); await page.getByLabel('Already-known membership ID').fill(fixture.membershipId); await page.getByRole('button', { name: 'Load membership dates', exact: true }).click(); await page.getByRole('heading', { name: 'Verified current membership' }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Extend', exact: true }).count(), 0);
        await page.evaluate(() => window.dispatchEvent(new Event('blur'))); fixture.setMode('revoked'); await page.getByRole('button', { name: 'Verify access and resume' }).click(); await page.getByText('Information remains hidden.', { exact: false }).waitFor(); assert.equal(fixture.commands.length, 0);
      } finally { await context.close(); }
    });
  }
}
