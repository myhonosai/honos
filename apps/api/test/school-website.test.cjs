const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SchoolWebsiteService } = require('../dist/website/school-website.service.js');
const { publicSiteTransport } = require('../dist/website/public-site-transport.js');
const contracts = require('@hon/contracts');

// Mocked boundary tests for the WB2 (0361) school website API and the shared document rules. The database behaviour
// (authority, revalidation, references, versions, isolation, public copy) is proven against PostgreSQL by
// test-school-websites-integrity.mjs.
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'site-key',
  externalSubject: 'verified-human', ...patch });
const readContext = (patch = {}) => context({ idempotencyKey: '', ...patch });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value); if (code) assert.equal(error.getResponse().code, code); return true; };
const palette = { primary: '#1f3a8a', accent: '#f59e0b', background: '#ffffff', surface: '#f3f4f6', text: '#111827' };
const doc = () => ({ schemaVersion: 1, theme: { template: 'MODERN_CLEAN', font: 'MODERN', logoUrl: '', palette: { ...palette } }, pages: [
  { slug: 'home', kind: 'HOME', title: 'Home', inNav: true, seo: { title: 'Dojo', description: '' }, campaignId: null, sections: [
    { id: 'hero', type: 'HERO', props: { heading: 'Welcome', subheading: '', ctaLabel: 'Book', ctaHref: '/trial', imageUrl: '', layout: 'SPLIT' } }] },
  { slug: 'trial', kind: 'LANDING', title: 'Free trial', inNav: false, seo: { title: '', description: '' }, campaignId: randomUUID(), sections: [
    { id: 'form', type: 'LEAD_FORM', props: { heading: 'Ask us', body: 'Line one\nLine two', publicFormId: 'a'.repeat(48) } }] }] });
const site = (patch = {}) => ({ id: randomUUID(), publicSlug: 'tiger-dojo', name: 'Tiger Dojo', status: 'DRAFT', draftRevision: 1, publishedVersion: null, draft: doc(), versions: [],
  createdAt: '2026-11-15T08:00:00.000Z', updatedAt: '2026-11-15T08:00:00.000Z', ...patch });

function fixture(options = {}) {
  const queries = [];
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        assert.doesNotMatch(sql, /(INSERT|UPDATE|DELETE)\s|hon\.school_website(s|_versions|_requests)\b/);
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/hon\.read_school_website\(\$1\)/.test(sql)) return { rows: [{ data: options.read ?? { website: null, templates: [...contracts.WEBSITE_TEMPLATES] } }] };
        if (/hon\.mutate_school_website\(/.test(sql)) return { rows: [{ data: options.mutate ?? { website: site(), replayed: false } }] };
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
    async readPublishedSchoolWebsite(slug) { queries.push({ sql: 'public', args: [slug] }); if (options.error) throw options.error; return options.published === undefined ? null : options.published; },
  };
  return { db, queries, calls: (name) => queries.filter((q) => q.sql.includes(name)) };
}

test('the shared validator accepts a complete document and refuses unsafe or malformed ones', () => {
  assert.doesNotThrow(() => contracts.validateWebsiteDocument(doc()));
  const bad = [
    d => { d.pages[0].sections[0].props.ctaHref = 'javascript:alert(1)'; },
    d => { d.pages[0].sections[0].props.ctaHref = '/nowhere'; },
    d => { d.pages[0].sections[0].props.imageUrl = 'http://example.invalid/a.png'; },
    d => { d.pages[0].sections[0].props.imageUrl = 'data:image/png;base64,AA'; },
    d => { d.pages[0].sections[0].props.style = 'color:red'; },
    d => { d.pages[0].sections[0].type = 'HTML'; },
    d => { d.pages[0].sections[0].props.heading = 'a\nb'; },
    d => { d.pages[0].sections[0].props.heading = 'a​b'; },
    d => { d.pages[1].sections[0].props.publicFormId = 'xyz'; },
    d => { d.pages[0].campaignId = randomUUID(); },
    d => { d.pages[1].slug = 'home'; },
    d => { d.pages.reverse(); },
    d => { d.theme.palette.text = '#FFF'; },
    d => { d.theme.font = 'COMIC'; },
    d => { d.pages[0].sections.push(d.pages[0].sections[0]); },
    d => { d.schemaVersion = 2; },
  ];
  for (const [i, change] of bad.entries()) { const d = doc(); change(d); assert.throws(() => contracts.validateWebsiteDocument(d), /Invalid website/, 'case ' + i); }
  for (const slug of ['tiger-dojo', 'abc', 'dojo-2026']) assert.equal(contracts.websiteSlugOk(slug), true, slug);
  for (const slug of ['ab', 'admin', 'Tiger', '-a-', 'a--b', 'a'.repeat(49)]) assert.equal(contracts.websiteSlugOk(slug), false, slug);
});

test('read is one protected read-only call with no key; commands need a key', async () => {
  const f = fixture(), svc = new SchoolWebsiteService(f.db);
  const r = await svc.read(readContext());
  assert.equal(r.website, null);
  assert.equal(f.calls('read_school_website')[0].readOnly, true);
  await assert.rejects(svc.read(context()), status(409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED'));
  await assert.rejects(svc.mutate(readContext(), 'save', {}), status(409, 'IDEMPOTENCY_KEY_REQUIRED'));
  await assert.rejects(svc.read(readContext({ actionRequestId: randomUUID() })), status(403, 'HUMAN_COMMAND_REQUIRED'));
  await assert.rejects(svc.read(readContext({ source: 'AI_AGENT' })), status(403, 'HUMAN_COMMAND_REQUIRED'));
});

test('each command is closed-validated before one protected write with the exact input', async () => {
  const f = fixture(), svc = new SchoolWebsiteService(f.db), c = context();
  const input = { publicSlug: 'tiger-dojo', name: 'Tiger Dojo', document: doc() };
  const result = await svc.mutate(c, 'create', input);
  assert.equal(result.replayed, false);
  const [call] = f.calls('mutate_school_website');
  assert.equal(call.readOnly, false);
  assert.deepEqual(call.args, [c.externalSubject, 'create', JSON.stringify(input), c.idempotencyKey, c.requestId, c.correlationId]);
  const invalid = [
    ['create', { ...input, extra: 1 }], ['create', { ...input, publicSlug: 'admin' }], ['create', { ...input, name: ' padded ' }],
    ['save', { expectedRevision: 0, name: 'x', document: doc() }], ['save', { expectedRevision: 1, name: 'x' }],
    ['publish', { expectedRevision: 1 }], ['publish', { expectedRevision: 1, note: 'x'.repeat(201) }],
    ['rollback', { expectedRevision: 1, version: 0, note: '' }], ['unpublish', { expectedRevision: 1, note: '' }], ['delete', {}],
  ];
  for (const [op, body] of invalid) await assert.rejects(svc.mutate(context(), op, body), status(400, 'SCHOOL_WEBSITE_INVALID'), op);
  assert.equal(f.calls('mutate_school_website').length, 1);
});

test('database refusals translate to exact codes; unknown failures never look like success', async () => {
  const cases = [
    ['VERSION_CONFLICT', '40001', 409], ['SCHOOL_WEBSITE_FORBIDDEN', '42501', 403], ['SCHOOL_WEBSITE_NOT_FOUND', 'P0002', 404],
    ['SCHOOL_WEBSITE_ADDRESS_TAKEN', '23505', 409], ['SCHOOL_WEBSITE_REFERENCE_NOT_LIVE', '22023', 409], ['SCHOOL_WEBSITE_REFERENCE_INVALID', '22023', 400],
    ['SCHOOL_WEBSITE_EXISTS', '23505', 409], ['IDEMPOTENCY_KEY_REUSED', '23505', 409],
  ];
  for (const [message, code, http] of cases) {
    const error = Object.assign(new Error(message), { code });
    await assert.rejects(new SchoolWebsiteService(fixture({ error }).db).mutate(context(), 'publish', { expectedRevision: 1, note: '' }), status(http, message));
  }
  await assert.rejects(new SchoolWebsiteService(fixture({ error: new Error('boom') }).db).read(readContext()), status(503, 'SCHOOL_WEBSITE_UNAVAILABLE'));
  await assert.rejects(new SchoolWebsiteService(fixture({ mutate: { website: { id: 'x' }, replayed: false } }).db).mutate(context(), 'unpublish', { expectedRevision: 1 }), status(503));
  await assert.rejects(new SchoolWebsiteService(fixture({ mutate: { website: site(), replayed: false, extra: 1 } }).db).mutate(context(), 'unpublish', { expectedRevision: 1 }), status(503));
});

test('public read: invalid address never reaches the database; a copy with internal ids is refused', async () => {
  const f = fixture(), svc = new SchoolWebsiteService(f.db);
  assert.equal(await svc.published('ADMIN'), null);
  assert.equal(await svc.published('admin'), null);
  assert.equal(f.queries.length, 0);
  assert.equal(await svc.published('tiger-dojo'), null);
  const publicDoc = doc(); publicDoc.pages[1].campaignId = null;
  const ok = await new SchoolWebsiteService(fixture({ published: { publicSlug: 'tiger-dojo', schoolName: 'Tiger Dojo', version: 2, document: publicDoc } }).db).published('tiger-dojo');
  assert.equal(ok.version, 2);
  await assert.rejects(new SchoolWebsiteService(fixture({ published: { publicSlug: 'tiger-dojo', schoolName: 'Tiger Dojo', version: 2, document: doc() } }).db).published('tiger-dojo'), status(503));
  await assert.rejects(new SchoolWebsiteService(fixture({ published: { publicSlug: 'other-dojo', schoolName: 'X', version: 1, document: publicDoc } }).db).published('tiger-dojo'), status(503));
});

test('public site transport admits only GET of one canonical address with no query or body', () => {
  const run = (method, path, originalUrl = path, headers = {}) => {
    let code = 0, nexted = false;
    const res = { setHeader() {}, status(c) { code = c; return { json() {} }; } };
    publicSiteTransport()({ method, path, originalUrl, headers }, res, () => { nexted = true; });
    return nexted ? 'next' : code;
  };
  assert.equal(run('GET', '/v1/public/sites/tiger-dojo'), 'next');
  assert.equal(run('GET', '/v1/other'), 'next');
  assert.equal(run('GET', '/v1/public/sites/tiger-dojo', '/v1/public/sites/tiger-dojo?x=1'), 400);
  assert.equal(run('GET', '/v1/public/sites/Tiger-Dojo'), 400);
  assert.equal(run('GET', '/V1/PUBLIC/SITES/tiger-dojo'), 400);
  assert.equal(run('POST', '/v1/public/sites/tiger-dojo'), 400);
  assert.equal(run('GET', '/v1/public/sites/tiger-dojo/extra'), 400);
  assert.equal(run('GET', '/v1/public/sites/tiger-dojo', undefined, { 'content-length': '3' }), 400);
});
