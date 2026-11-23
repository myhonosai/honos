/**
 * Parent pro shop proof (0581) over signed HTTP (HON session cookie -> HonIdentityGuard + human UI guard ->
 * ParentProShopController -> a protected definer read on the restricted runtime role), on the guarded disposable CRM-close
 * fixture only. Synthetic store and product names only; nothing calls Shopify.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';

await import('./test-crm-close-proof-target.mjs');
const targets = crmCloseProofTargets(process.env);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(repo, 'apps/api/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing');
const { ValidationPipe } = apiRequire('@nestjs/common');
const { HttpAdapterHost } = apiRequire('@nestjs/core');
const { json } = apiRequire('express');
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const M = await load('pro-shop/parent-pro-shop.controller.js');
const { ParentProShopService } = await load('pro-shop/parent-pro-shop.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-parent-pro-shop', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const LA = 'America/Los_Angeles';
const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family', 'otherFamily', 'busyFamily'].map((key) => [key, randomUUID()]));
const PREFIX = `pshop-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
let app, origin;
const database = new RuntimeDatabaseService();

async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [M.ParentProShopController],
    providers: [HonIdentityGuard, HonIdentityService, ParentProShopService, M.ParentProShopReadGuard, { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use(json({ limit: '2mb', strict: true }));
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function send(target, method, headers, payload) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
function call(actor, method, path, { body, key = randomUUID(), command, headers = {} } = {}) {
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(command ? { 'X-Hon-Human-Command': command } : {}), ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  for (const [name, value] of Object.entries(sent)) if (value === undefined) delete sent[name];
  return send(new URL(`${origin}/v1${path}`), method, sent, body === undefined ? undefined : JSON.stringify(body));
}
const shop = (actor, options = {}) => call(actor, 'GET', '/parent/pro-shop', options);

async function success(read, label, expectedStatus = 200) {
  const { status, body, headers } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  ok(/no-store/.test(headers['cache-control'] ?? ''), `${label}: never cached`);
  return body;
}
async function refused(read, expectedStatus, expectedCode, label) {
  const { status, body } = await read();
  assert.equal(status, expectedStatus, `${label}: expected ${expectedStatus}, got ${status} ${JSON.stringify(body).slice(0, 400)}`);
  if (expectedCode) assert.equal(body.code, expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  ok(!('data' in body), `${label}: a refusal returns no data`);
}

// Disposable-fixture cleanup only (as in the 0286 and 0329 proofs).
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    await sql('DELETE FROM hon.shopify_variants WHERE connection_id IN (SELECT id FROM hon.shopify_connections WHERE organization_id = ANY($1::uuid[]))', [[ids.organization, ids.otherOrganization]]);
    for (let pass = 0; pass < 8; pass += 1) {
      let failed = 0;
      for (const table of tables) {
        await sql('SAVEPOINT cleanup_table');
        try {
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [[ids.organization, ids.otherOrganization]]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [[ids.organization, ids.otherOrganization]]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function person(label, name = 'Person') {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [user, subject, `${user}@example.test`, name]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)", [principal, user, name]);
  return { subject, principal, org: ids.organization, school: ids.school };
}
async function grant(actor, family, level) {
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4)",
    [ids.organization, ids.school, family, actor.principal, level]);
}
async function role(org, permissions, code) {
  const id = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [id, org, code ?? `STAFF_${id.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [id, org, permission]);
  return id;
}
async function staff(label, roleId, { org = ids.organization, school = ids.school } = {}) {
  const actor = await person(label, 'Coach Secret-Staff-Name');
  const id = randomUUID();
  await sql("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')",
    [id, org, school, actor.principal, roleId]);
  return { ...actor, org, school, grant: id };
}

let GUARDIAN, VIEWER, OUTSIDER, TWO, OTHER_PARENT;
const CONN = randomUUID(), CONN_B = randomUUID();
const SHOP = `pshop-${ids.organization.slice(0, 8)}.myshopify.com`, SHOP_B = `pshop-b-${ids.organization.slice(0, 8)}.myshopify.com`;
async function connection(id, school, domain, status = 'CONNECTED') {
  await sql('ALTER TABLE hon.shopify_connections DISABLE TRIGGER USER');
  await sql(`INSERT INTO hon.shopify_connections(id,organization_id,school_id,shop_domain,shop_name,currency,scopes,status,connected_by_principal_id)
    VALUES($1,$2,$3,$4,'Synthetic Store','USD','read_products',$5,$6)`, [id, ids.organization, school, domain, status, GUARDIAN.principal]);
  await sql('ALTER TABLE hon.shopify_connections ENABLE TRIGGER USER');
}
async function product(conn, school, sid, title, { status = 'ACTIVE', handle = `item-${sid}`, removed = false, variants = [['25.0000', false]] } = {}) {
  await sql(`INSERT INTO hon.shopify_products(connection_id,shopify_id,organization_id,school_id,title,status,vendor,product_type,handle,image_url,removed,last_sync_id)
    VALUES($1,$2,$3,$4,$5,$6,'Secret Vendor','Gear',$7,$8,$9,$10)`, [conn, sid, ids.organization, school, title, status, handle, `https://cdn.shopify.com/s/files/${sid}.jpg`, removed, randomUUID()]);
  let pos = 0;
  for (const [price, gone] of variants) {
    pos += 1;
    await sql(`INSERT INTO hon.shopify_variants(connection_id,shopify_id,product_shopify_id,title,sku,barcode,price,compare_at_price,unit_cost,tracked,inventory_quantity,position,removed,last_sync_id)
      VALUES($1,$2,$3,'Default','SECRET-SKU','999',$4,NULL,'3.1400',true,7,$5,$6,$7)`, [conn, sid * 100 + pos, sid, price, pos, gone, randomUUID()]);
  }
}
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Shop Org','Shop Org'),($2,'Shop Other Org','Shop Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  await sql('INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$5)',
    [ids.school, ids.organization, 'Shop Dojo', `pshop-a-${ids.school.slice(0, 8)}`, LA, ids.otherSchool, 'Shop Dojo B', `pshop-b-${ids.otherSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$3,$4,'Kim Family'),($2,$3,$4,'Other Family')", [ids.family, ids.otherFamily, ids.organization, ids.school]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'B Family')", [ids.busyFamily, ids.organization, ids.otherSchool]);
  GUARDIAN = await person('guardian'); VIEWER = await person('viewer'); OUTSIDER = await person('outsider'); TWO = await person('two'); OTHER_PARENT = await person('other-parent');
  await grant(GUARDIAN, ids.family, 'PRIMARY_GUARDIAN'); await grant(VIEWER, ids.family, 'VIEWER');
  await grant(TWO, ids.family, 'PRIMARY_GUARDIAN'); await grant(TWO, ids.otherFamily, 'PRIMARY_GUARDIAN');
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',clock_timestamp()-interval '1 day',$4)",
    [ids.organization, ids.otherSchool, ids.busyFamily, OTHER_PARENT.principal]);
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. No store yet: an honest "not available", scoped by the one live family grant.
  const none = (await success(() => shop(GUARDIAN), 'no store')).data;
  ok(none.schoolName === 'Shop Dojo' && none.available === false && none.currency === null && none.products.length === 0, 'no connected store: not available');
  await refused(() => shop(OUTSIDER), 403, 'PARENT_PRO_SHOP_FORBIDDEN', 'no family grant');
  await refused(() => shop(TWO), 403, 'PARENT_PRO_SHOP_FORBIDDEN', 'two families are ambiguous');
  await refused(() => call(GUARDIAN, 'GET', '/parent/pro-shop?schoolId=x'), 400, 'PARENT_PRO_SHOP_SELECTORS_NOT_ACCEPTED', 'no selector');
  await refused(() => shop(GUARDIAN, { headers: { 'X-Hon-Source': 'AI_AGENT' } }), 403, 'HUMAN_UI_REQUIRED', 'a delegated source header');
  await refused(() => shop(GUARDIAN, { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'HUMAN_UI_REQUIRED', 'cross-site read');

  // 2. A connected store: only ACTIVE, live, linkable products with a live variant; the lowest live price; ordered by title.
  await connection(CONN, ids.school, SHOP);
  await product(CONN, ids.school, 11, 'Sparring gloves', { variants: [['25.0000', false], ['19.5000', false], ['5.0000', true]] });
  await product(CONN, ids.school, 12, 'Belt', { variants: [['0.0000', false]] });
  await product(CONN, ids.school, 13, 'Draft hoodie', { status: 'DRAFT' });
  await product(CONN, ids.school, 14, 'Archived bag', { status: 'ARCHIVED' });
  await product(CONN, ids.school, 15, 'Removed shirt', { removed: true });
  await product(CONN, ids.school, 16, 'No handle', { handle: null });
  await product(CONN, ids.school, 17, 'No live variant', { variants: [['10.0000', true]] });
  await product(CONN, ids.school, 18, 'No variants', { variants: [] });
  await product(CONN, ids.school, 19, 'Odd handle', { handle: 'Bad Handle' });
  const live = (await success(() => shop(GUARDIAN), 'store')).data;
  ok(live.available === true && live.currency === 'USD', 'available in the store currency');
  ok(JSON.stringify(live.products.map((p) => p.title)) === JSON.stringify(['Belt', 'Sparring gloves']), 'only ACTIVE, live, linkable products with a live variant, by title');
  const gloves = live.products[1];
  ok(gloves.productId === '11' && gloves.fromPrice === '19.50' && live.products[0].fromPrice === '0.00', 'lowest live variant price, two decimals');
  ok(gloves.url === `https://${SHOP}/products/item-11` && gloves.imageUrl === 'https://cdn.shopify.com/s/files/11.jpg', 'link to the school store page');
  ok(Object.keys(gloves).sort().join() === 'fromPrice,imageUrl,productId,title,url', 'products carry title, image, price and link only');
  const text = JSON.stringify(live);
  ok(!/SECRET|Secret Vendor|3\.14|inventory|unitCost|sku/i.test(text), 'no vendor, SKU, cost or inventory reaches a family');
  ok((await success(() => shop(VIEWER), 'viewer')).data.products.length === 2, 'a viewer can browse');

  // 3. Another school's store never mixes in; that school's family sees only its own.
  await connection(CONN_B, ids.otherSchool, SHOP_B);
  await product(CONN_B, ids.otherSchool, 21, 'B school gi');
  ok(!JSON.stringify((await success(() => shop(GUARDIAN), 'store after B')).data).includes('B school gi'), 'no other-school products');
  const b = (await success(() => shop(OTHER_PARENT), 'other school family')).data;
  ok(b.schoolName === 'Shop Dojo B' && b.products.length === 1 && b.products[0].url === `https://${SHOP_B}/products/item-21`, 'the other school family sees its own store');

  // 4. A store that needs reconnecting or is disconnected is not shown, even though its rows remain.
  await sql('ALTER TABLE hon.shopify_connections DISABLE TRIGGER USER');
  await sql("UPDATE hon.shopify_connections SET status='NEEDS_RECONNECT', ended_at=clock_timestamp() WHERE id=$1", [CONN]);
  ok((await success(() => shop(GUARDIAN), 'needs reconnect')).data.available === false, 'a store needing reconnect is not shown');
  await sql("UPDATE hon.shopify_connections SET status='DISCONNECTED' WHERE id=$1", [CONN]);
  const gone = (await success(() => shop(GUARDIAN), 'disconnected')).data;
  ok(gone.available === false && gone.products.length === 0, 'a disconnected store is not shown');
  await sql("UPDATE hon.shopify_connections SET status='CONNECTED', ended_at=NULL WHERE id=$1", [CONN]);
  await sql('ALTER TABLE hon.shopify_connections ENABLE TRIGGER USER');

  // 5. Live authority: ended grant, inactive family, suspended school and lapsed entitlement are refused.
  await sql("UPDATE hon.family_access_grants SET effective_until=clock_timestamp()+interval '1 second' WHERE principal_id=$1", [VIEWER.principal]);
  await new Promise((r) => setTimeout(r, 1200));
  await refused(() => shop(VIEWER), 403, 'PARENT_PRO_SHOP_FORBIDDEN', 'an ended family grant');
  await sql("UPDATE hon.families SET status='SUSPENDED' WHERE id=$1", [ids.family]);
  await refused(() => shop(GUARDIAN), 403, 'PARENT_PRO_SHOP_FORBIDDEN', 'an inactive family');
  await sql("UPDATE hon.families SET status='ACTIVE' WHERE id=$1", [ids.family]);
  await sql("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1", [ids.school]);
  await refused(() => shop(GUARDIAN), 403, 'PARENT_PRO_SHOP_FORBIDDEN', 'suspended school');
  await sql("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.school]);
  await sql("UPDATE hon.organization_entitlements SET effective_until=clock_timestamp()-interval '1 minute', effective_from=clock_timestamp()-interval '2 days' WHERE organization_id=$1", [ids.organization]);
  await refused(() => shop(GUARDIAN), 403, 'PARENT_PRO_SHOP_FORBIDDEN', 'lapsed entitlement');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);
  ok((await success(() => shop(GUARDIAN), 'access returns')).data.products.length === 2, 'works again once access is live');

  // 6. Database boundary: one definer entry point; the scope helper private; no runtime access to the mirror tables.
  { const r = (await sql(`SELECT has_function_privilege($1,'hon.read_parent_pro_shop(text)','EXECUTE') runtime, p.prosecdef, EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid='hon.read_parent_pro_shop(text)'::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
    ok(r.runtime && r.prosecdef && !r.public, 'runtime may execute the definer read; PUBLIC may not'); }
  { const r = (await sql(`SELECT has_function_privilege($1,'hon.parent_pro_shop_scope(text)','EXECUTE') runtime, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) public
      FROM pg_proc p WHERE p.oid='hon.parent_pro_shop_scope(text)'::regprocedure`, [CRM_CLOSE_RUNTIME_ROLE])).rows[0];
    ok(!r.runtime && !r.public, 'the scope helper is private'); }
  for (const table of ['shopify_connections', 'shopify_products', 'shopify_variants']) {
    ok(!(await sql(`SELECT has_table_privilege($1,$2,'SELECT') s`, [CRM_CLOSE_RUNTIME_ROLE, `hon.${table}`])).rows[0].s, `${table}: no runtime table privilege`);
  }
  await assert.rejects(runtime.query('SELECT * FROM hon.shopify_products')); checks += 1;
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const startMark = '-- Parent pro shop exact verification (0581)', endMark = '-- End parent pro shop exact verification.';
    const section = verify.split(startMark)[1]?.split(endMark)[0];
    ok(section, startMark);
    await sql(section.replace(/^[^\n]*\n/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: parent pro shop (0581): ${checks} checks.`);
} finally {
  if (app) await app.close();
  await cleanup().catch(() => {});
  await admin.end();
  await runtime.end();
}
