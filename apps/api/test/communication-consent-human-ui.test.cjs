const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { CommunicationConsentController } = require('../dist/communication/communication-consent.controller.js');
const { CommunicationConsentService } = require('../dist/communication/communication-consent.service.js');
const { CommunicationConsentHumanUiGuard } = require('../dist/communication/communication-consent-human-ui.guard.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const personId = randomUUID();
const consent = { channel: 'SMS', status: 'OPTED_OUT', source: 'STAFF', capturedAt: '2026-11-09T02:00:00.000Z', version: 2, updatedAt: '2026-11-09T02:00:01.000Z' };

test('consent recording accepts only a same-origin human-UI PUT with the fixed marker; the read refuses delegation selectors', async () => {
  const old = process.env.HON_PUBLIC_ORIGIN; process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
  let records = 0, lists = 0;
  const module = await Test.createTestingModule({
    controllers: [CommunicationConsentController],
    providers: [CommunicationConsentHumanUiGuard, { provide: RuntimeDatabaseService, useValue: { resolveAuthorizedScope: async () => scope } },
      { provide: CommunicationConsentService, useValue: {
        record: async (context) => { records++; assert.equal(context.source, 'HUMAN_UI'); return { consent, replayed: false, created: false }; },
        list: async () => { lists++; return [consent]; } } }],
  }).overrideGuard(HonIdentityGuard).useValue({ canActivate(c) { c.switchToHttp().getRequest().honIdentity = { externalSubject: 'trusted' }; return true; } }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const root = `http://127.0.0.1:${app.getHttpServer().address().port}/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/people/${personId}/communication-consents`;
  const headers = () => ({ Origin: 'https://hon.test', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'communication.consent.record', 'Idempotency-Key': randomUUID(), 'Sec-Fetch-Site': 'same-origin' });
  const body = { status: 'OPTED_OUT', source: 'STAFF', capturedAt: '2026-11-09T02:00:00.000Z', expectedVersion: 1 };
  const put = (patch = {}) => fetch(`${root}/SMS`, { method: 'PUT', headers: { ...headers(), ...patch }, body: JSON.stringify(body) });
  const rejected = [{ Origin: 'https://bad.test' }, { Origin: '' }, { 'X-HON-Human-Command': '' }, { 'X-HON-Human-Command': 'crm-trial-appointment' },
    { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Content-Type': 'text/plain' },
    { 'X-HON-Source': 'HUMAN_UI' }, { 'X-HON-Action-Request-Id': randomUUID() }, { 'X-HON-Delegated-By-Principal-Id': randomUUID() }];
  try {
    const ok = await put(); assert.equal(ok.status, 200); assert.deepEqual((await ok.json()).data, consent); assert.equal(records, 1);
    for (const patch of rejected) {
      const r = await put(patch);
      assert.equal(r.status, 403, JSON.stringify(patch)); assert.equal((await r.json()).code, 'HUMAN_UI_REQUIRED');
    }
    // A request without Sec-Fetch-Site (non-browser client) still needs the origin and marker.
    const { 'Sec-Fetch-Site': _site, ...plain } = headers();
    const noFetchMeta = await fetch(`${root}/SMS`, { method: 'PUT', headers: plain, body: JSON.stringify(body) });
    assert.equal(noFetchMeta.status, 200);
    assert.equal(records, 2);
    const read = await fetch(root, { headers: { Accept: 'application/json', 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(read.status, 200); assert.deepEqual((await read.json()).data, [consent]);
    for (const patch of [{ 'X-HON-Source': 'AI_AGENT' }, { 'X-HON-Action-Request-Id': randomUUID() }, { 'X-HON-Delegated-By-Principal-Id': randomUUID() }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const r = await fetch(root, { headers: { Accept: 'application/json', ...patch } });
      assert.equal(r.status, 403, JSON.stringify(patch));
    }
    assert.equal(lists, 1);
    delete process.env.HON_PUBLIC_ORIGIN;
    const unconfigured = await put(); assert.equal(unconfigured.status, 503); assert.equal((await unconfigured.json()).code, 'HUMAN_UI_ORIGIN_NOT_CONFIGURED');
    assert.equal(records, 2);
  } finally {
    await app.close();
    if (old === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = old;
  }
});
