/** Synthetic localhost API fixtures for the actual authenticated Next application. Never imported by application code. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MEMBERSHIP_ACTIVATION_CONFIRMATION, MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED, MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION,
  validateMembershipActivationPreviewInput, validateConfirmMembershipActivationInput, verifyMembershipActivationPreview, verifyMembershipActivationReceipt,
} from '@hon/contracts';

export function createActivationFixture({ id, scope, origin, send, rejected }) {
  const membershipId = id(80), root = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/memberships/${membershipId}`;
  let mode, state, version, keys, commands, reads, finish;
  function reset(next = 'routine') { mode = next; state = 'DRAFT'; version = 1; keys = new Map(); commands = []; reads = []; finish = null; }
  reset();
  function preview(input) {
    const dates = Object.keys(input).length ? input : { startDate: '2026-10-22', endDate: null };
    const future = dates.startDate > '2026-10-22', override = ['override', 'no-override'].includes(mode), missing = mode === 'missing-birth';
    const data = {
      membershipId, state, version, billingAccountId: id(81), participantPersonId: id(82), participantDisplayName: 'Synthetic Jordan Lee', planCode: 'JUNIOR-PUBLISHED', source: 'CRM_GUARDIAN_CHILD_PLAN',
      plan: { membershipPlanId: id(83), membershipPlanVersion: 2, terms: { displayName: 'Junior martial arts' } }, existingTerm: { termStartedAt: null, termEndsAt: null },
      schoolTimezone: 'America/Los_Angeles', localToday: '2026-10-22', birthDateRecorded: !missing, knownMinor: false,
      suggestedDates: { startDate: '2026-10-22', endDate: null, startBasis: 'TODAY_IN_SCHOOL_TIMEZONE', endBasis: 'PLAN_OPEN_ENDED' },
      proposedDates: { ...dates, dateSource: dates.startDate === '2026-10-22' && dates.endDate === null ? 'SUGGESTED' : 'STAFF_ADJUSTED' },
      projection: { termStartedAt: `${dates.startDate}T07:00:00.000Z`, termEndsAt: dates.endDate === null ? null : '2027-11-01T07:00:00.000Z' }, effectiveStatusIfConfirmedNow: future ? 'SCHEDULED' : 'IN_EFFECT',
      warnings: [...(missing ? [{ code: 'BIRTH_DATE_MISSING' }] : []), ...(override ? [{ code: 'CRM_IDENTITY_REVIEW_PENDING' }] : []), ...(future ? [{ code: 'START_DATE_IN_FUTURE', days: 10 }] : [])],
      overridableWarnings: override ? ['CRM_IDENTITY_REVIEW_PENDING'] : [], availableOverrides: mode === 'override' ? ['CRM_IDENTITY_REVIEW_PENDING'] : [],
      blocks: mode === 'minor' ? [{ code: 'MINOR_GUARDIAN_OF_RECORD_REQUIRED' }] : [], canConfirm: state === 'DRAFT' && !['no-override', 'minor'].includes(mode),
      requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED], previewDigest: 'a'.repeat(64), confirmation: MEMBERSHIP_ACTIVATION_CONFIRMATION,
    };
    data.previewDigest = createHash('sha256').update(JSON.stringify(data)).digest('hex'); return verifyMembershipActivationPreview(data);
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith(root + '/')) return false;
    if (mode === 'revoked') { rejected(res, 403, 'MEMBERSHIP_ACTIVATION_FORBIDDEN'); return true; }
    if (url.search || req.headers.origin && req.headers.origin !== origin) { rejected(res, 403, 'MEMBERSHIP_ACTIVATION_FORBIDDEN'); return true; }
    if (url.pathname === root + '/activation-context' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify({ data: { ...scope, membershipId, state, version }, meta: { requestId: id(8), correlationId: id(8) } })); return true;
    }
    const step = url.pathname === root + '/activation-preview' ? 'preview' : url.pathname === root + '/activate' ? 'activate' : null;
    if (!step || req.method !== 'POST' || req.headers.origin !== origin || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['x-hon-human-command'] !== (step === 'preview' ? 'billing.membership.activation.preview' : 'billing.membership.activate')) { rejected(res, 403, 'MEMBERSHIP_ACTIVATION_FORBIDDEN'); return true; }
    let raw = ''; for await (const chunk of req) { raw += chunk; assert(raw.length < 8000); } const body = JSON.parse(raw), key = req.headers['idempotency-key'];
    if (step === 'preview') { assert.equal(key, undefined); validateMembershipActivationPreviewInput(body); reads.push(body); send(res, 200, preview(body)); return true; }
    validateConfirmMembershipActivationInput(body); assert.match(key, /^[a-f0-9-]{36}$/); commands.push({ raw, key });
    if (keys.has(key)) { const prior = keys.get(key); assert.equal(prior.raw, raw); send(res, 200, prior.data, true); return true; }
    if (mode === 'stale') { rejected(res, 409, 'ACTIVATION_PREVIEW_STALE'); return true; }
    const reviewed = preview({ startDate: body.startDate, endDate: body.endDate }); assert.equal(body.previewDigest, reviewed.previewDigest); assert.equal(body.expectedVersion, version);
    assert.deepEqual(body.acknowledgedWarnings, reviewed.warnings.map(w => w.code));
    if (reviewed.overridableWarnings.length) { assert.equal(mode, 'override'); assert.equal(body.overrides[0].confirmation, MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION); }
    const data = verifyMembershipActivationReceipt({ membershipId, state: 'ACTIVE', version: version + 1, previousVersion: version, decisionId: id(84), decisionBasis: 'STAFF_ACTIVATION_PRE_POLICY', membershipSource: reviewed.source,
      authorizingPermission: 'billing.membership.activate', overridePermission: body.overrides.length ? 'billing.membership.activation.override' : null,
      effectivePeriod: { periodVersion: 1, startDate: body.startDate, endDate: body.endDate, endDateInclusive: true, schoolTimezone: reviewed.schoolTimezone, dateSource: body.dateSource, ...reviewed.projection },
      effectiveStatusAtActivation: reviewed.effectiveStatusIfConfirmedNow, acknowledgedWarnings: body.acknowledgedWarnings, overridesUsed: body.overrides.map(o => ({ code: o.code, resolved: false })),
      followUps: [...(reviewed.birthDateRecorded ? [] : [{ kind: 'BIRTH_DATE_MISSING', workItemId: id(85) }]), ...(body.overrides.length ? [{ kind: 'IDENTITY_REVIEW_UNRESOLVED', workItemId: id(86) }] : [])],
      adultVerification: body.adultVerification ? { kind: 'STAFF_ATTESTATION', method: body.adultVerification.method } : null, reasonCode: body.reasonCode, requirementsNotEvaluated: [...MEMBERSHIP_REQUIREMENTS_NOT_EVALUATED], recordedAt: '2026-10-22T12:00:00.000Z' }, membershipId);
    keys.set(key, { raw, data }); state = 'ACTIVE'; version++;
    const held = mode.startsWith('hold-'); if (held) await new Promise(done => { finish = done; });
    if (mode.includes('unknown')) { mode = 'routine'; send(res, 503, {}); } else send(res, 200, data);
    return true;
  }
  return { reset, handle, membershipId, scope, get commands() { return commands; }, get reads() { return reads; }, release() { assert(finish); finish(); }, setMode(value) { mode = value; } };
}

export async function runActivationBrowserChecks({ fixture, open, visual, check, origin }) {
  async function begin(page) {
    await page.goto(origin + '/staff/billing/memberships'); assert.equal(fixture.reads.length, 0); assert.equal(fixture.commands.length, 0);
    await page.getByLabel('Organization ID', { exact: true }).fill(fixture.scope.organizationId);
    await page.getByLabel('School ID', { exact: true }).fill(fixture.scope.schoolId);
    await page.getByLabel('Already-known membership ID').fill(fixture.membershipId);
    await page.getByRole('button', { name: 'Review activation', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Step 1 · Review activation', exact: true }).waitFor();
  }
  async function final(page) { await page.getByRole('button', { name: 'Review final confirmation', exact: true }).click(); await page.getByRole('heading', { name: 'Step 2 · Confirm activation' }).waitFor(); await page.getByRole('checkbox', { name: /^I confirm this membership/ }).check(); }
  async function activate(page) { await final(page); await page.getByRole('button', { name: 'Confirm membership activation', exact: true }).click(); }
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await check(`${size}: delegated staff preview/final confirmation/receipt, keyboard and accessible layout`, async () => {
      fixture.reset(); const { context, page } = await open(viewport); try {
        await begin(page); assert.equal(fixture.commands.length, 0); await visual(page, `${size}-activation-review`); await final(page); await visual(page, `${size}-activation-confirm`);
        await page.getByRole('button', { name: 'Confirm membership activation', exact: true }).focus(); await page.keyboard.press('Enter'); await page.getByRole('heading', { name: 'Membership confirmation receipt' }).waitFor(); assert.equal(fixture.commands.length, 1); await visual(page, `${size}-activation-receipt`);
      } finally { await context.close(); }
    });
    await check(`${size}: future dates are re-previewed, inclusive end and school timezone remain exact`, async () => {
      fixture.reset(); const { context, page } = await open(viewport); try {
        await begin(page); await page.getByLabel('Start date', { exact: true }).fill('2026-11-01'); await page.getByText('Projected effective status if confirmed now').waitFor();
        await page.getByRole('heading', { name: 'Step 1 · Review activation', exact: true }).waitFor();
        await page.getByLabel('Last valid day (inclusive)', { exact: true }).fill('2027-10-31'); await page.getByRole('heading', { name: 'Step 1 · Review activation', exact: true }).waitFor();
        await page.getByRole('checkbox', { name: /scheduled to start in the future/ }).check(); await page.getByLabel('Date adjustment reason', { exact: true }).fill('Staff confirmed the exact annual term with the school.');
        await activate(page); await page.getByText('Membership confirmed — scheduled to begin', { exact: false }).waitFor();
        assert((await page.getByRole('main').innerText()).includes('Oct 31, 2027')); assert((await page.getByRole('main').innerText()).includes('America/Los_Angeles')); await visual(page, `${size}-activation-scheduled`);
      } finally { await context.close(); }
    });
    for (const outcome of ['success', 'unknown']) await check(`${size}: ${outcome} settles behind shield without reload; exact retry is explicit`, async () => {
      fixture.reset('hold-' + outcome); const { context, page } = await open(viewport); try {
        await begin(page); await activate(page); await page.waitForFunction(() => !!document.querySelector('button:disabled'));
        await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.getByRole('heading', { name: 'Membership information hidden' }).waitFor();
        assert(!(await page.getByRole('main').innerText()).includes('Synthetic Jordan Lee')); assert(await page.getByRole('button', { name: 'Verify access and resume' }).isDisabled());
        // The actual request settles behind the shield. No full-document navigation is involved.
        await page.waitForTimeout(100); fixture.release(); await page.getByRole('button', { name: 'Verify access and resume' }).waitFor();
        await page.getByRole('button', { name: 'Verify access and resume' }).click(); await page.getByText('Session and exact-school activation access verified.', { exact: false }).waitFor();
        assert.equal(fixture.commands.length, 1);
        if (outcome === 'unknown') { await page.getByRole('button', { name: 'Retry exact retained activation' }).click(); await page.getByText('idempotent replay', { exact: false }).waitFor(); assert.deepEqual(fixture.commands[0], fixture.commands[1]); }
        else await page.getByRole('heading', { name: 'Membership confirmation receipt' }).waitFor();
      } finally { await context.close(); }
    });
  }
  for (const mode of ['missing-birth', 'override', 'no-override', 'minor', 'stale']) await check(`${mode}: honest warnings, backend capabilities and stale rejection`, async () => {
    fixture.reset(mode); const { context, page } = await open({ width: 1000, height: 900 }); try {
      await begin(page);
      if (mode === 'no-override') { assert.equal(await page.getByLabel('Identity override reason', { exact: false }).count(), 0); assert(await page.getByRole('button', { name: 'Review final confirmation' }).isDisabled()); return; }
      if (mode === 'minor') { await page.getByText('A known minor requires a verified guardian', { exact: false }).waitFor(); assert(await page.getByRole('button', { name: 'Review final confirmation' }).isDisabled()); return; }
      if (mode === 'missing-birth') { await page.getByRole('checkbox', { name: /^Birth date is missing/ }).check(); await page.getByRole('checkbox', { name: /^Optional: I attest/ }).check(); await page.getByLabel('Adult verification method').selectOption('DOCUMENT_REVIEWED'); }
      if (mode === 'override') { await page.getByRole('checkbox', { name: /^An identity review is unresolved/ }).check(); await page.getByLabel('Identity override reason', { exact: false }).fill('Staff reviewed the distinct records and documented this unresolved issue.'); await page.getByRole('checkbox', { name: /^I separately confirm/ }).check(); }
      await activate(page);
      if (mode === 'stale') { await page.getByRole('alert').filter({ hasText: 'reviewed facts changed' }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Confirm membership activation', exact: true }).count(), 0); assert.equal(fixture.commands.length, 1); }
      else { await page.getByRole('heading', { name: 'Membership confirmation receipt' }).waitFor(); await visual(page, `activation-${mode}`); }
    } finally { await context.close(); }
  });
  for (const denied of ['revoked', 'expired']) await check(`${denied}: concealed information stays hidden after denied access verification`, async () => {
    fixture.reset(); const { context, page } = await open({ width: 390, height: 844 }); try {
      await begin(page); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.getByRole('heading', { name: 'Membership information hidden' }).waitFor();
      if (denied === 'revoked') fixture.setMode('revoked'); else await context.clearCookies();
      await page.getByRole('button', { name: 'Verify access and resume' }).click(); await page.getByRole('alert').filter({ hasText: 'Access could not be verified' }).waitFor(); assert(!(await page.getByRole('main').innerText()).includes('Synthetic Jordan Lee')); assert.equal(fixture.commands.length, 0);
    } finally { await context.close(); }
  });
}
