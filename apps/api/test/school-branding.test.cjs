const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contracts = require('@hon/contracts');

// 0268: shared school page branding; the database validates the same rules again.
const branding = (patch = {}) => ({ logoUrl: 'https://cdn.example.com/logo.png', coverUrl: null, accentColor: '#c81e1e', contactLine: 'Call us at 555-0100', ...patch });

test('0268 save input is closed and keeps every allowed value exactly', () => {
  const input = contracts.validateSaveSchoolBrandingInput({ branding: branding(), expectedVersion: 0 });
  assert.deepEqual(input, { branding: branding(), expectedVersion: 0 });
  assert.deepEqual(contracts.validateSaveSchoolBrandingInput({ branding: contracts.EMPTY_SCHOOL_BRANDING, expectedVersion: 4 }).branding, contracts.EMPTY_SCHOOL_BRANDING);
  for (const bad of [
    { branding: branding({ logoUrl: 'http://cdn.example.com/logo.png' }) },
    { branding: branding({ logoUrl: 'https://CDN.example.com/logo.png' }) },
    { branding: branding({ logoUrl: 'https://cdn.example.com/a b.png' }) },
    { branding: branding({ logoUrl: 'https://cdn.example.com/"x' }) },
    { branding: branding({ logoUrl: 'javascript:alert(1)' }) },
    { branding: branding({ coverUrl: 'https://localhost' }) },
    { branding: branding({ coverUrl: `https://cdn.example.com/${'a'.repeat(500)}` }) },
    { branding: branding({ accentColor: '#C81E1E' }) },
    { branding: branding({ accentColor: 'red' }) },
    { branding: branding({ contactLine: ' padded' }) },
    { branding: branding({ contactLine: '<b>x</b>' }) },
    { branding: branding({ contactLine: 'a\nb' }) },
    { branding: branding({ contactLine: '' }) },
    { branding: branding({ contactLine: 'x'.repeat(161) }) },
    { branding: { ...branding(), font: 'serif' } },
    { branding: { logoUrl: null, coverUrl: null, accentColor: null } },
  ]) assert.throws(() => contracts.validateSaveSchoolBrandingInput({ expectedVersion: 0, ...bad }), undefined, JSON.stringify(bad).slice(0, 120));
  for (const expectedVersion of [-1, 1.5, '0', null]) assert.throws(() => contracts.validateSaveSchoolBrandingInput({ branding: branding(), expectedVersion }));
  assert.throws(() => contracts.validateSaveSchoolBrandingInput({ branding: branding(), expectedVersion: 0, extra: 1 }));
});

test('0268 read, receipt and public verifiers', () => {
  const saved = { ...branding(), version: 2, updatedAt: '2026-11-12T02:00:00.000Z' };
  assert.equal(contracts.verifySchoolBrandingRead({ branding: saved }).branding.version, 2);
  const empty = { ...contracts.EMPTY_SCHOOL_BRANDING, version: 0, updatedAt: null };
  assert.equal(contracts.verifySchoolBrandingRead({ branding: empty }).branding.version, 0);
  assert.throws(() => contracts.verifySchoolBrandingRead({ branding: { ...empty, accentColor: '#000000' } }), undefined, 'version 0 has no fields');
  assert.throws(() => contracts.verifySchoolBrandingRead({ branding: { ...saved, updatedAt: null } }));
  assert.throws(() => contracts.verifySchoolBrandingRead({ branding: saved, extra: 1 }));
  assert.equal(contracts.verifySchoolBrandingReceipt({ branding: saved }, { version: 2 }).branding.accentColor, '#c81e1e');
  assert.throws(() => contracts.verifySchoolBrandingReceipt({ branding: saved }, { version: 1 }));
  assert.equal(contracts.verifyPublicSchoolBranding(null), null);
  assert.equal(contracts.verifyPublicSchoolBranding({ ...saved, schoolName: 'Tiger Kim TKD' }).schoolName, 'Tiger Kim TKD');
  assert.throws(() => contracts.verifyPublicSchoolBranding({ ...saved, schoolName: 'x', schoolId: '11111111-1111-4111-8111-111111111111' }));
});

test('0268 API: two routes under their own human-UI guards; nothing public, no upload or fetch', () => {
  const dir = path.join(__dirname, '../src/school-branding');
  const controller = fs.readFileSync(path.join(dir, 'school-branding.controller.ts'), 'utf8');
  assert.match(controller, /@Controller\('organizations\/:organizationId\/schools\/:schoolId\/settings\/branding'\)/);
  assert.equal((controller.match(/@UseGuards\(SchoolBranding[A-Za-z]+HumanUiGuard\)/g) ?? []).length, 2);
  assert.match(controller, /'school_branding\.manage'/);
  const service = fs.readFileSync(path.join(dir, 'school-branding.service.ts'), 'utf8');
  for (const fn of ['read_school_page_branding', 'save_school_page_branding']) assert.match(service, new RegExp(`hon\\.${fn}\\(`));
  const sources = ['school-branding.service.ts', 'school-branding.controller.ts'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /@Public|fetch\(|FileInterceptor|multipart|read_public_school_branding/);
  const module = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
  for (const name of ['SchoolBrandingController', 'SchoolBrandingService', 'SchoolBrandingReadHumanUiGuard', 'SchoolBrandingSaveHumanUiGuard']) assert.match(module, new RegExp(name));
});
