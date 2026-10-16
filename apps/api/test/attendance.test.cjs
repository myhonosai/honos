const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
require('reflect-metadata');
const { ValidationPipe } = require('@nestjs/common');
const { ATTENDANCE_CATEGORIES } = require('@hon/contracts');
const { AttendanceService } = require('../dist/schedule/attendance.service.js');
const { AttendancePolicyService } = require('../dist/schedule/attendance-policy.service.js');
const { AttendanceController } = require('../dist/schedule/attendance.controller.js');
const { AttendancePolicyController } = require('../dist/schedule/attendance-policy.controller.js');
const { AttendanceHumanUiGuard } = require('../dist/schedule/attendance-human-ui.guard.js');
const { RecordAttendanceDto } = require('../dist/schedule/record-attendance.dto.js');
const { ConfigureAttendancePolicyDto } = require('../dist/schedule/attendance-policy.dto.js');
const apiRoot = join(__dirname, '..');
const projectRoot = join(__dirname, '../../..');
const attendanceSource = file => readFileSync(join(apiRoot, 'src/schedule', file), 'utf8');
const migrationSource = file => readFileSync(join(projectRoot, 'packages/database/migrations', file), 'utf8');
const [organizationId, schoolId, principalId, programId, sessionId, studentProfileId] = Array.from({ length: 6 }, randomUUID);
const ctx = patch => ({ organizationId, schoolId, principalId, externalSubject: 'verified', principalType: 'HUMAN_USER', source: 'HUMAN_UI', idempotencyKey: randomUUID(), requestId: randomUUID(), correlationId: randomUUID(), ...patch });
const categories = ATTENDANCE_CATEGORIES.map(category => ({ category, operationalAllowed: true, progressionEnabled: false, weightMilli: 0 }));
const status = expected => e => e.getStatus() === expected && !JSON.stringify(e.getResponse()).includes('SQL_SECRET');

test('attendance DTO accepts exact category and legacy omission; rejects fabricated authority/credit and invalid inputs', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  for (const category of ATTENDANCE_CATEGORIES) await pipe.transform({ studentProfileId, status: 'PRESENT', category }, { type: 'body', metatype: RecordAttendanceDto });
  await pipe.transform({ studentProfileId, status: 'MAKEUP' }, { type: 'body', metatype: RecordAttendanceDto });
  for (const patch of [{ category: 'DROP_IN' }, { progressionCreditMilli: 1000 }, { source: 'AI' }, { principalId }, { expectedVersion: 0 }, { category: null }]) {
    await assert.rejects(() => pipe.transform({ studentProfileId, status: 'PRESENT', ...patch }, { type: 'body', metatype: RecordAttendanceDto }), status(400));
  }
  await pipe.transform({ expectedVersion: 0, categories }, { type: 'body', metatype: ConfigureAttendancePolicyDto });
  for (const input of [{ expectedVersion: -1, categories }, { expectedVersion: 0, categories: categories.slice(1) }, { expectedVersion: 0, categories: categories.map(r => ({ ...r, weightMilli: 1.1 })) }, { expectedVersion: 0, categories: categories.map(r => ({ ...r, payment: true })) }]) await assert.rejects(() => pipe.transform(input, { type: 'body', metatype: ConfigureAttendancePolicyDto }), status(400));
});

test('record and policy services deny AI, actions, delegated actors and missing verified identity before DB', async () => {
  let calls = 0;
  const db = { withTenantTransaction: () => { calls++; throw new Error('unexpected DB'); } };
  const records = new AttendanceService(db), policies = new AttendancePolicyService(db);
  for (const patch of [{ principalType: 'AI_EMPLOYEE' }, { source: 'AI' }, { source: 'PUBLIC_API' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }, { externalSubject: '' }]) {
    await assert.rejects(() => records.record(ctx(patch), sessionId, { studentProfileId, status: 'PRESENT' }), status(403));
    await assert.rejects(() => policies.configure(ctx(patch), programId, { expectedVersion: 0, categories }), status(403));
  }
  await assert.rejects(() => policies.configure(ctx(), programId, { expectedVersion: 0, categories: categories.map(() => categories[0]) }), status(400));
  await assert.rejects(() => records.record(ctx(), sessionId, { studentProfileId, status: 'PRESENT', category: 'BAD' }), status(400));
  assert.equal(calls, 0);
});

test('attendance SQL errors map to safe domain problems for policy and recording', async () => {
  for (const [code, expected] of [['42501', 403], ['P0002', 404], ['40001', 409], ['55P03', 409], ['40P01', 409], ['23505', 409], ['23503', 400], ['23514', 400], ['22023', 400], ['57014', 503]]) {
    const db = { withTenantTransaction: async () => { throw Object.assign(new Error('SQL_SECRET'), { code }); } };
    await assert.rejects(() => new AttendanceService(db).record(ctx(), sessionId, { studentProfileId, status: 'PRESENT' }), status(expected));
    await assert.rejects(() => new AttendancePolicyService(db).configure(ctx(), programId, { expectedVersion: 0, categories }), status(expected));
  }
});

test('controllers derive exact live permission/actor and expose category and private metadata through actual endpoint methods', async () => {
  const calls = [], seen = [];
  const db = { resolveAuthorizedScope: async (...args) => { calls.push(args); return { organizationId, schoolId, principalId }; } };
  const res = { setHeader: (...x) => seen.push(x), status: x => seen.push(x) };
  const req = { honIdentity: { externalSubject: 'verified' } };
  const policy = new AttendancePolicyController(db, { configure: async (c, p, input) => { assert.equal(c.externalSubject, 'verified'); assert.equal(c.principalId, principalId); assert.equal(p, programId); return { policy: input, replayed: false }; } });
  const result = await policy.configure(organizationId, schoolId, programId, 'key', { expectedVersion: 0, categories }, req, res);
  assert.equal(result.data.categories.length, 7);
  assert.deepEqual(calls[0], ['verified', schoolId, 'attendance.policy.manage']);
  const attendance = new AttendanceController(db, { record: async (c, s, input) => { assert.equal(c.externalSubject, 'verified'); assert.equal(s, sessionId); return { attendance: input, created: true, replayed: false }; } });
  assert.equal((await attendance.record(organizationId, schoolId, sessionId, 'key', { studentProfileId, status: 'PRESENT', category: 'OBSERVER' }, req, res)).data.category, 'OBSERVER');
  assert.deepEqual(calls[1], ['verified', schoolId, 'attendance.record']);
  await assert.rejects(() => policy.configure(randomUUID(), schoolId, programId, 'key', {}, req, res), status(403));
  assert(seen.some(x => Array.isArray(x) && x[0] === 'Cache-Control' && x[1] === 'private, no-store'));
});

test('sensitive policy guard requires configured trusted origin and direct JSON command marker', () => {
  const prior = process.env.HON_PUBLIC_ORIGIN;
  const guard = new AttendanceHumanUiGuard(), run = r => guard.canActivate({ switchToHttp: () => ({ getRequest: () => r }) });
  try {
    process.env.HON_PUBLIC_ORIGIN = 'https://hon.test';
    const headers = { origin: 'https://hon.test', 'content-type': 'application/json', 'x-hon-human-command': 'attendance' };
    assert.equal(run({ method: 'POST', headers }), true);
    for (const patch of [{ origin: 'https://evil.test' }, { 'x-hon-human-command': 'AI' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }]) assert.throws(() => run({ method: 'POST', headers: { ...headers, ...patch } }), status(403));
    delete process.env.HON_PUBLIC_ORIGIN;
    assert.throws(() => run({ method: 'POST', headers }), status(503));
  } finally { if (prior === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = prior; }
});

test('attendance record controller applies the same direct-human transport guard as policy commands', () => {
  const controller = attendanceSource('attendance.controller.ts');
  assert.match(controller, /@UseGuards\(HonIdentityGuard, AttendanceHumanUiGuard\)/);
  assert.match(controller, /@Post\(':sessionId\/attendance'\)/);
});

test('record/policy source has no downstream executor, worker, provider or auto-progress path', () => {
  for (const f of ['attendance.service.ts', 'attendance-policy.service.ts', 'attendance.controller.ts', 'attendance-policy.controller.ts']) {
    assert.doesNotMatch(attendanceSource(f), /fetch\(|invokeProvider|ActionEngineService|Payment.*Service|Membership.*Service|Ai.*Service|Messaging.*Service|Worker/);
  }
  const migration = migrationSource('0114_advanced_attendance_management.sql');
  assert.doesNotMatch(migration, /(?:INSERT INTO|UPDATE) hon\.(?:student_curriculum|promotion|testing|membership|payment|ai_usage|action_requests|communication|class_bookings)/);
});


test('attendance service normalizes at the boundary and calls only the fixed database command', async () => {
  const context=ctx(), seen=[];
  const receipt={attendance:{id:randomUUID(),classSessionId:sessionId,studentProfileId,status:'MAKEUP',category:'MAKEUP_CLASS',version:1},created:true,replayed:false};
  const db={withTenantTransaction:async (c,work)=>{assert.equal(c,context); return work({query:async (sql,values)=>{
    seen.push(sql);
    if (sql.includes('hon.record_attendance(')) {
      assert.deepEqual(values,[context.externalSubject,sessionId,JSON.stringify({category:'MAKEUP_CLASS',studentProfileId,status:'MAKEUP',note:'Private note'}),context.idempotencyKey,context.requestId,context.correlationId]);
      return {rows:[{data:receipt}]};
    }
    assert.match(sql,/^(?:SELECT set_config|SET LOCAL)/); return {rows:[]};
  }});}};
  assert.deepEqual(await new AttendanceService(db).record(context,sessionId.toUpperCase(),{studentProfileId:studentProfileId.toUpperCase(),status:'MAKEUP',note:'  Private note  '}),receipt);
  assert.equal(seen.filter(sql=>sql.includes('hon.record_attendance(')).length,1);
  assert(!seen.some(sql=>/INSERT|UPDATE|DELETE/.test(sql)));
});

test('record service rejects non-normalizable payload and whitespace/control idempotency before DB',async()=>{
  let calls=0; const records=new AttendanceService({withTenantTransaction:()=>{calls++; throw new Error('unexpected DB');}});
  for (const input of [null,[],{}, {studentProfileId:'not-a-uuid',status:'PRESENT'}, {studentProfileId,status:'PRESENT',note:1}, {studentProfileId,status:'PRESENT',note:'private\ncontrol'}, {studentProfileId,status:'PRESENT',note:'x'.repeat(2001)}, {studentProfileId,status:'PRESENT',note:'😀'.repeat(1001)}, {studentProfileId,status:'PRESENT',expectedVersion:1.1}, {studentProfileId,status:'PRESENT',progressionCreditMilli:1}]) await assert.rejects(()=>records.record(ctx(),sessionId,input),status(400));
  for (const key of ['', ' ', ' padded ', 'control\nkey']) await assert.rejects(()=>records.record(ctx({idempotencyKey:key}),sessionId,{studentProfileId,status:'PRESENT'}),status(409));
  assert.equal(calls,0);
});

test('attendance source uses function-only mutation and retains an exact RLS read',()=>{
  const service=attendanceSource('attendance.service.ts');
  assert.match(service,/SELECT hon\.record_attendance\(/);
  assert.match(service,/FROM hon\.attendance_records WHERE class_session_id=\$1::uuid AND student_profile_id=\$2::uuid/);
  assert.doesNotMatch(service,/(?:INSERT INTO|UPDATE|DELETE FROM) hon\.(?:attendance_records|idempotency_records|audit_events|outbox_events)|createHash|randomUUID/);
  const command=migrationSource('0115_attendance_command_boundary.sql');
  assert.match(command,/SECURITY DEFINER SET search_path=pg_catalog,hon/);
  assert.match(command,/app\.hon_correlation_id/);
  assert.doesNotMatch(command,/(?:INSERT INTO|UPDATE) hon\.(?:student_curriculum|promotion|testing|membership|payment|ai_usage|action_requests|communication|class_bookings)/);
});
