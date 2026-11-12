const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { BookableStudentsController, BookableStudentsService } = require('../dist/schedule/bookable-students.js');

const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const status = n => e => { assert.equal(e.getStatus(), n); return true; };
const row = n => ({ studentProfileId: randomUUID(), givenName: `Kid${n}`, familyName: 'Park' });

function db({ authorized = true, rows = [row(1)] } = {}) {
 const calls = [];
 return { calls, database: { withTenantTransaction: async (c, work) => work({ query: async (sql, args) => {
  calls.push({ sql, args });
  if (sql.includes('resolve_authorized_scope')) return { rows: authorized ? [{ principal_id: scope.principalId, organization_id: scope.organizationId, school_id: scope.schoolId }] : [] };
  return { rows };
 } }) } };
}
const context = () => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'read:x' });

test('lists active student profiles of the exact school by name, after re-checking booking authority', async () => {
 const { calls, database } = db({ rows: [row(1), row(2)] });
 const result = await new BookableStudentsService(database).list(context(), 'signed', '  Kid ');
 assert.equal(result.length, 2); assert.deepEqual(Object.keys(result[0]).sort(), ['familyName', 'givenName', 'studentProfileId']);
 assert(calls[0].sql.includes('resolve_authorized_scope')); assert.deepEqual(calls[0].args, ['signed', scope.schoolId, 'schedule.booking.manage']);
 const read = calls[1];
 assert.match(read.sql, /FROM hon\.student_profiles/); assert.match(read.sql, /JOIN hon\.people/); assert.match(read.sql, /status = 'ACTIVE'/); assert.match(read.sql, /LIMIT 50/);
 assert.deepEqual(read.args, [scope.organizationId, scope.schoolId, 'Kid']);
 await assert.rejects(() => new BookableStudentsService(db({ authorized: false }).database).list(context(), 's', ''), status(403));
});

test('the search text is bounded and an empty search reads the first page by name', async () => {
 const { calls, database } = db();
 await new BookableStudentsService(database).list(context(), 's', '');
 assert.equal(calls[1].args[2], null);
 await assert.rejects(() => new BookableStudentsService(database).list(context(), 's', 'x'.repeat(121)), status(400));
});

test('controller derives the scope from the signed identity and refuses a mismatched organization', async () => {
 const asked = [];
 const controller = new BookableStudentsController({ resolveAuthorizedScope: async (...a) => { asked.push(a); return scope; } }, { list: async (c, s, q) => [{ q, org: c.organizationId }] });
 const res = { setHeader(k, v) { this[k] = v; } };
 const out = await controller.list(scope.organizationId, scope.schoolId, 'Ki', { honIdentity: { externalSubject: 'signed' } }, res);
 assert.deepEqual(asked[0], ['signed', scope.schoolId, 'schedule.booking.manage']);
 assert.equal(out.data[0].q, 'Ki'); assert.equal(res['Cache-Control'], 'private, no-store');
 await assert.rejects(() => controller.list(randomUUID(), scope.schoolId, '', { honIdentity: { externalSubject: 'signed' } }, res), status(403));
 await assert.rejects(() => controller.list(scope.organizationId, scope.schoolId, '', {}, res), status(403));
});
