/** Mounted production Next components with the existing synthetic localhost API fixture; not API/database/provider proof. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

async function copyModule(name) {
  const requireWeb = createRequire(new URL('../package.json', import.meta.url));
  const ts = requireWeb('typescript');
  const source = await readFile(new URL(`../src/components/${name}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
}

/** Hooks are supplied by crm-adult-flow-browser.mjs; this helper creates no server and replaces no API response. */
export async function runSchoolMembershipJourneyBrowserChecks({ activationFixture, familyFixture, reset, open, check, visual, origin, scope, id, report, setLanguage, restoreSession }) {
  assert.equal(report.syntheticFixturesOnly, true);
  assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Only the isolated localhost application may be exercised.');
  assert.equal(typeof setLanguage, 'function'); assert.equal(typeof restoreSession, 'function');
  const { activationText: text, activationWarning: warning } = await copyModule('membership-activation-catalog');
  const { membershipJourneyText: journeyText } = await copyModule('crm-membership-journey-copy');
  const prefix = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}`;
  const modes = [
    { value: 'modern', viewport: { width: 1440, height: 1000 } },
    { value: 'classic', viewport: { width: 834, height: 1000 } },
    { value: 'big', viewport: { width: 390, height: 844 } },
  ];
  const evidence = report.schoolMembershipJourney ??= [];
  const requests = (start = 0) => report.requests.slice(start);
  const activationCounts = () => {
    const root = `${prefix}/billing/memberships/${activationFixture.membershipId}`;
    return {
      preview: requests().filter(r => r.method === 'POST' && r.path === root + '/activation-preview').length,
      context: requests().filter(r => r.method === 'GET' && r.path === root + '/activation-context').length,
      activate: requests().filter(r => r.method === 'POST' && r.path === root + '/activate').length,
    };
  };
  const root = page => page.locator('[data-membership-activation]');
  const button = (page, language, key) => root(page).getByRole('button', { name: text(language, key), exact: true });
  async function keyboardActivate(page, control) {
    await control.focus(); await page.keyboard.press('Shift');
    assert(await control.evaluate(el => el === document.activeElement && el.matches(':focus-visible') && parseFloat(getComputedStyle(el).outlineWidth) >= 2), 'Visible keyboard focus is required.');
    await page.keyboard.press('Enter');
  }
  async function capture(page, name) {
    await visual(page, name);
    const scan = report.accessibility.findLast(item => item.name === name);
    assert(scan && scan.violations.length === 0, 'The membership journey must have a zero-violation axe scan.');
  }
  async function review(page, language) {
    await keyboardActivate(page, button(page, language, 'Review activation'));
    await root(page).getByRole('heading', { name: text(language, 'Step 1 · Review activation'), exact: true }).waitFor();
    await root(page).getByText('Synthetic Jordan Lee', { exact: true }).waitFor();
  }
  async function loadCrm(page) {
    await page.getByLabel('Status filter', { exact: true }).selectOption('WON');
    await keyboardActivate(page, page.getByRole('button', { name: 'Load CRM leads', exact: true }));
  }
  async function adult(page, language) {
    await loadCrm(page);
    await keyboardActivate(page, page.getByRole('button', { name: 'Resume setup', exact: true }));
    await page.getByRole('heading', { name: 'Set up Ari Stone', exact: true }).waitFor();
    await page.getByText(journeyText(language, 'current'), { exact: true }).waitFor();
  }
  async function child(page, language) {
    await loadCrm(page);
    await keyboardActivate(page, page.getByRole('button', { name: 'Set up / resume family', exact: true }));
    await page.getByRole('heading', { name: 'Family setup for Ari Stone', exact: true }).waitFor();
    await page.getByRole('button', { name: /Kai Stone/ }).click();
    await page.getByRole('button', { name: 'Load available membership plans', exact: true }).click();
    await page.getByLabel('Available membership plan', { exact: true }).selectOption(id(34));
    await page.getByRole('button', { name: 'Review membership DRAFT', exact: true }).click();
    await page.getByRole('checkbox', { name: /DRAFT for Kai Stone/ }).check();
    await page.getByRole('button', { name: 'Create DRAFT from selected plan', exact: true }).click();
    await page.getByRole('heading', { name: 'Historical DRAFT creation receipt for Kai Stone', exact: true }).waitFor();
    assert.equal(familyFixture.commands.filter(command => command.step === 'draft').length, 1);
    assert.equal(await page.getByRole('button', { name: journeyText(language, 'review'), exact: true }).count(), 0, 'A historical creation receipt alone cannot offer activation review.');
    await page.getByRole('button', { name: 'Check current membership status', exact: true }).click();
    await page.getByRole('heading', { name: 'Verified current DRAFT', exact: true }).waitFor();
  }
  async function handoff(page, language, mode, membershipId) {
    const before = activationCounts();
    await keyboardActivate(page, page.getByRole('button', { name: journeyText(language, 'review'), exact: true }));
    await root(page).getByRole('heading', { name: text(language, 'Review and confirm membership activation'), exact: true }).waitFor();
    assert.deepEqual(activationCounts(), before, 'The local handoff must not read activation facts or dispatch a command.');
    for (const [key, value] of [['Organization ID', scope.organizationId], ['School ID', scope.schoolId], ['Already-known membership ID', membershipId]]) {
      const field = root(page).getByLabel(text(language, key), { exact: true });
      assert.equal(await field.inputValue(), value); assert.equal(await field.isEditable(), false, 'CRM selectors are readonly navigation values.');
    }
    assert(!(await root(page).innerText()).includes('Synthetic Jordan Lee'), 'Activation facts require an explicit protected preview.');
    const presentation = root(page).getByRole('combobox', { name: text(language, 'Presentation'), exact: true });
    await presentation.selectOption(mode); assert.equal(await presentation.inputValue(), mode);
    assert.deepEqual(activationCounts(), before, 'Presentation cannot change reads or authority.');
    assert(!page.url().includes(membershipId), 'No membership receipt is passed in the URL.');
  }
  async function concealAndRestore(page, language) {
    const before = activationCounts();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await root(page).getByRole('heading', { name: text(language, 'Membership information hidden'), exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'activation-shield');
    assert(!(await root(page).innerText()).includes('Synthetic Jordan Lee'));
    assert.equal(await root(page).locator('[data-activation-private]').count(), 0);
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(100);
    assert.deepEqual(activationCounts(), before, 'Focus return cannot automatically restore facts or resend a command.');
    await keyboardActivate(page, button(page, language, 'Verify access and resume'));
    await root(page).getByRole('heading', { name: text(language, 'Current membership observation'), exact: true }).waitFor();
    assert.deepEqual(activationCounts(), { ...before, context: before.context + 1 });
    assert.equal(await root(page).getByRole('heading', { name: text(language, 'Step 1 · Review activation'), exact: true }).count(), 0, 'Restoration requires fresh review before a new command.');
    await review(page, language);
  }
  async function confirm(page, language, future) {
    if (future) {
      await root(page).getByLabel(text(language, 'Start date'), { exact: true }).fill('2026-11-01');
      await root(page).getByRole('heading', { name: text(language, 'Step 1 · Review activation'), exact: true }).waitFor();
      await root(page).getByLabel(text(language, 'Last valid day (inclusive)'), { exact: true }).fill('2027-10-31');
      await root(page).getByRole('heading', { name: text(language, 'Step 1 · Review activation'), exact: true }).waitFor();
      assert(await button(page, language, 'Review final confirmation').isDisabled());
      await root(page).getByRole('checkbox', { name: warning(language, 'START_DATE_IN_FUTURE'), exact: false }).check();
      await root(page).getByLabel(text(language, 'Date adjustment reason'), { exact: true }).fill('Staff reviewed these exact school-local membership dates.');
    }
    const before = activationCounts();
    await keyboardActivate(page, button(page, language, 'Review final confirmation'));
    await root(page).getByRole('heading', { name: text(language, 'Step 2 · Confirm activation'), exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'activation-final');
    assert.deepEqual(activationCounts(), before, 'The final summary is not a command.');
    assert(await button(page, language, 'Confirm membership activation').isDisabled());
    await root(page).getByRole('checkbox', { name: text(language, 'I confirm this membership and the exact dates above, without recording agreement, consent or payment.'), exact: true }).check();
  }
  try {
    for (const language of ['en','ko','es']) for (const { value: mode, viewport } of modes) {
      await check(`school membership: ${language}/${mode} adult current-DRAFT handoff, two-step review and private restoration`, async () => {
        setLanguage(language); reset('recovery-CURRENT_DRAFT'); activationFixture.reset('routine', { ...scope, membershipId: id(7) });
        const start = report.requests.length, { context, page } = await open(viewport);
        try {
          await page.waitForFunction(lang => document.documentElement.lang === lang, language);
          await adult(page, language); await handoff(page, language, mode, id(7)); await review(page, language);
          assert.equal(activationFixture.commands.length, 0); await concealAndRestore(page, language);
          await confirm(page, language, true); await capture(page, `school-membership-${language}-${mode}-final`);
          await keyboardActivate(page, button(page, language, 'Confirm membership activation'));
          await root(page).getByRole('heading', { name: text(language, 'Membership confirmation receipt'), exact: true }).waitFor();
          assert.equal(activationFixture.commands.length, 1);
          const sent = JSON.parse(activationFixture.commands[0].raw);
          assert.equal(sent.startDate, '2026-11-01'); assert.equal(sent.endDate, '2027-10-31');
          assert((await root(page).innerText()).includes(text(language, 'This is historical confirmation evidence; it is not a new current-state read.')));
          await capture(page, `school-membership-${language}-${mode}-scheduled-receipt`);
          const before = activationCounts(); await keyboardActivate(page, button(page, language, 'Check current membership status'));
          await root(page).getByRole('heading', { name: text(language, 'Current membership observation'), exact: true }).waitFor();
          assert.deepEqual(activationCounts(), { ...before, context: before.context + 1 });
          assert.equal(await root(page).getByRole('link', { name: text(language, 'Class bookings'), exact: true }).getAttribute('href'), '/staff/schedule/bookings');
          assert.equal(await root(page).getByRole('link', { name: text(language, 'Attendance'), exact: true }).getAttribute('href'), '/staff/attendance');
          assert(!requests(start).some(r => r.method === 'POST' && [prefix + '/crm/leads/' + id(3) + '/register', prefix + '/billing/accounts', prefix + '/billing/crm-adult-membership-drafts'].includes(r.path)), 'Creator-current recovery must not register, create an account or create another DRAFT.');
          evidence.push({ kind: 'adult-current', language, mode, activationCommands: 1, explicitRestoration: true, syntheticFixturesOnly: true });
        } finally { await context.close(); setLanguage('en'); }
      });
    }
    for (const [index, language] of ['en','ko','es'].entries()) await check(`school membership: ${language} child DRAFT creation, explicit current read and connected activation`, async () => {
      const { value: mode, viewport } = modes[index]; setLanguage(language); reset('family-ready'); familyFixture.seedChildren(2);
      activationFixture.reset('routine', { ...scope, membershipId: id(70) });
      const { context, page } = await open(viewport);
      try {
        await page.waitForFunction(lang => document.documentElement.lang === lang, language);
        await child(page, language); await handoff(page, language, mode, id(70)); await review(page, language); await confirm(page, language, false);
        await keyboardActivate(page, button(page, language, 'Confirm membership activation'));
        await root(page).getByRole('heading', { name: text(language, 'Membership confirmation receipt'), exact: true }).waitFor();
        assert.equal(activationFixture.commands.length, 1); assert.equal(familyFixture.commands.filter(command => command.step === 'draft').length, 1);
        assert.equal(familyFixture.children[1].workflowState, 'READY_FOR_DRAFT', 'One child must not advance a sibling.');
        await capture(page, `school-membership-${language}-${mode}-child-receipt`);
        evidence.push({ kind: 'child-current', language, mode, childDraftCommands: 1, activationCommands: 1, syntheticFixturesOnly: true });
      } finally { await context.close(); setLanguage('en'); }
    });
    await check('school membership: lost session stays concealed and same-user restoration is explicit', async () => {
      setLanguage('en'); reset('recovery-CURRENT_DRAFT'); activationFixture.reset('routine', { ...scope, membershipId: id(7) });
      const { context, page } = await open(modes[2].viewport);
      try {
        await adult(page, 'en'); await handoff(page, 'en', 'big', id(7)); await review(page, 'en');
        await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await root(page).getByRole('heading', { name: text('en', 'Membership information hidden'), exact: true }).waitFor();
        await context.clearCookies(); const before = activationCounts(); await button(page, 'en', 'Verify access and resume').click();
        await root(page).getByRole('alert').waitFor(); assert(!(await root(page).innerText()).includes('Synthetic Jordan Lee')); assert.deepEqual(activationCounts(), before);
        await restoreSession(context); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(100);
        assert.equal(await root(page).getByRole('heading', { name: text('en', 'Membership information hidden'), exact: true }).count(), 1);
        assert.deepEqual(activationCounts(), before); await button(page, 'en', 'Verify access and resume').click();
        await root(page).getByRole('heading', { name: text('en', 'Current membership observation'), exact: true }).waitFor();
        assert.equal(activationFixture.commands.length, 0); await capture(page, 'school-membership-session-explicit-restoration');
      } finally { await context.close(); setLanguage('en'); }
    });
  } finally { setLanguage('en'); }
}
