/** Actual frontend transports -> signed session -> real Nest guards/resolver -> disposable restricted PostgreSQL. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { issueSession, HON_SESSION_COOKIE } from '@hon/auth';
import { requireFlexibleBillingAccountsLocalUrls, flexibleBillingAccountsFixture } from '../../../packages/database/scripts/flexible-billing-accounts-local-guard.mjs';
assert.equal(process.env.HON_CONNECTED_OPERATIONS_API_TEST, '1');
await requireFlexibleBillingAccountsLocalUrls();
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const req=createRequire(resolve(repo,'apps/api/package.json')),dbReq=createRequire(resolve(repo,'packages/database/package.json')),webReq=createRequire(resolve(repo,'apps/web/package.json'));
req('reflect-metadata');const {Test}=req('@nestjs/testing'),{ValidationPipe}=req('@nestjs/common'),pg=dbReq('pg');
const load=p=>import(pathToFileURL(resolve(repo,'apps/api/dist',p)).href);
const {RuntimeDatabaseService}=await load('foundation/runtime-database.service.js'),{HonIdentityGuard}=await load('foundation/hon-identity.guard.js'),{HonIdentityService}=await load('foundation/hon-identity.service.js');
const components=await Promise.all(['class-sessions-read.controller','class-sessions-read.service','class-sessions-read-human-ui.guard','class-booking.controller','class-booking.service','class-booking-human-ui.guard','attendance.controller','attendance.service','attendance-human-ui.guard'].map(x=>load(`schedule/${x}.js`)));
const [sessionController,sessionService,sessionGuard,bookingController,bookingService,bookingGuard,attendanceController,attendanceService,attendanceGuard]=components;
const database=new RuntimeDatabaseService(),owner=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false});
const auth={mode:'OIDC',audience:'hon-disposable-connected-operations',secret:randomBytes(32).toString('hex')};
process.env.HON_AUTH_MODE=auth.mode;process.env.HON_SESSION_AUDIENCE=auth.audience;process.env.HON_SESSION_JWT_SECRET=auth.secret;
const originalFetch=globalThis.fetch;let app,actor,expired=false,lose=false,revoke=null,observeProjection=false,projectionStatus=null;const groups=[];
try{
 await owner.connect();const q=(sql,args=[])=>owner.query(sql,args);
 assert.deepEqual((await q("SELECT current_user owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0],{owner:flexibleBillingAccountsFixture.owner,marker:'HON disposable flexible billing accounts validation'});
 async function fixture(){
  const org=randomUUID(),school=randomUUID(),user=randomUUID(),principal=randomUUID(),role=randomUUID(),program=randomUUID(),subject=`operations-${randomUUID()}`;
  await q("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic operations organization','Synthetic operations organization')",[org]);
  await q("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic school',$3)",[school,org,`operations-${school}`]);
  await q("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')",[org]);
  await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic staff')",[user,subject,`${user}@example.test`]);
  await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Synthetic staff')",[principal,user]);
  await q("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'OPERATIONS_STAFF','Synthetic staff')",[role,org]);
  for(const permission of ['schedule.session.read','schedule.booking.manage','attendance.record'])await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,org,permission]);
  await q('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)',[org,school,principal,role]);
  await q("INSERT INTO hon.programs(id,organization_id,school_id,name,status) VALUES($1,$2,$3,'Synthetic program','SCHEDULED')",[program,org,school]);
  const students=[];for(const birth of ['1980-03-04','2016-03-04','2018-03-04']){const person=randomUUID(),student=randomUUID();await q("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Synthetic','Student')",[person,org,school]);await q('INSERT INTO hon.student_profiles(id,organization_id,school_id,person_id,birth_date) VALUES($1,$2,$3,$4,$5)',[student,org,school,person,birth]);students.push(student);}
  // Distinct millisecond-representable times: clock_timestamp() microsecond differences can collapse in 0147's JSON projection.
  const sessions=[];for(const status of ['SCHEDULED','CANCELLED']){const id=randomUUID();await q("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy,status,cancellation_reason) VALUES($1,$2,$3,$4,'Synthetic class',date_trunc('second',clock_timestamp())-interval '1 hour'+$7::integer*interval '10 minutes',date_trunc('second',clock_timestamp())+interval '1 hour'+$7::integer*interval '10 minutes',20,'OPTIONAL_BOOKING',$5,$6)",[id,org,school,program,status,status==='CANCELLED'?'Synthetic cancellation':null,sessions.length]);sessions.push(id);}
  return{org,school,role,principal,subject,students,sessions};
 }
 const a=await fixture(),b=await fixture();actor=a;
 const module=await Test.createTestingModule({controllers:[sessionController.ClassSessionsReadController,bookingController.ClassBookingController,attendanceController.AttendanceController],providers:[HonIdentityGuard,HonIdentityService,sessionService.ClassSessionsReadService,sessionGuard.ClassSessionsReadHumanUiGuard,bookingService.ClassBookingService,bookingGuard.ClassBookingHumanUiGuard,attendanceService.AttendanceService,attendanceGuard.AttendanceHumanUiGuard,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));await app.listen(0,'127.0.0.1');
 const origin=`http://127.0.0.1:${app.getHttpServer().address().port}`;process.env.HON_PUBLIC_ORIGIN=origin;
 const ts=webReq('typescript'),cache=new Map();
 async function frontend(name){if(cache.has(name))return cache.get(name);let code=ts.transpileModule(await readFile(resolve(repo,'apps/web/src/components',name+'.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const imports=[...code.matchAll(/from\s+['"]([^'"]+)['"]/g)];for(const m of imports){const target=m[1]==='@hon/contracts'?pathToFileURL(webReq.resolve('@hon/contracts')).href:m[1].startsWith('./')?await frontend(m[1].slice(2)):null;if(target)code=code.replaceAll(m[0],`from ${JSON.stringify(target)}`);}
  const url='data:text/javascript;base64,'+Buffer.from(code).toString('base64');cache.set(name,url);return url;}
 const web=await import(await frontend('connected-student-operations-http')),booking=await import(await frontend('class-booking-workbench-http')),sessions=await import(await frontend('class-sessions-read-http'));
 const resolveScope=database.resolveAuthorizedScope.bind(database);
 database.resolveAuthorizedScope=async(...args)=>{const result=await resolveScope(...args);if(revoke&&args[2]===revoke){const permission=revoke;revoke=null;await q('DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code=$2',[a.role,permission]);}return result;};
  globalThis.fetch=async(path,options)=>{assert.match(path,/^\/api\/v1\/organizations\/[a-f0-9-]+\/schools\/[a-f0-9-]+\/schedule\/sessions/);const headers=new Headers(options.headers);headers.set('Origin',origin);headers.set('Sec-Fetch-Site','same-origin');headers.set('Sec-Fetch-Mode','same-origin');headers.set('Sec-Fetch-Dest','empty');if(actor)headers.set('Cookie',`${HON_SESSION_COOKIE}=${issueSession({externalSubject:actor.subject},auth,expired?1:undefined)}`);const response=await originalFetch(origin+path.slice(4),{...options,headers});if(observeProjection)projectionStatus=response.status;if(lose&&options.method==='POST'&&response.ok){lose=false;throw new DOMException('Synthetic lost response after actual commit','TimeoutError');}return response;};
 const scope=student=>({organizationId:a.org,schoolId:a.school,studentProfileId:student}),at=student=>web.attendanceSelection(scope(student),a.sessions[0]);
 const denied=status=>e=>e.status===status;
 const protectedTables=(await q("SELECT relname FROM pg_class WHERE relnamespace='hon'::regnamespace AND relkind='r' AND relname ~ '^(saas_|payment|invoice|refund|membership|organization_entitlement|document_ack|agreement|consent|communication_|action_|ai_|school_payment|stripe|provider)' ORDER BY relname")).rows.map(r=>r.relname);
 const snapshot=async tables=>{const s={};for(const table of tables){assert.match(table,/^[a-z_]+$/);s[table]=(await q(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) h FROM hon.${table} t`)).rows[0].h;}return s;};
 const protectedBefore=await snapshot(protectedTables);
 // Accepted #128 canonical reconciliation must supply the grant; a fixture repair would mask a regression.
 const sessionReadGranted=(await q("SELECT has_function_privilege($1,'hon.read_current_school_class_sessions(text)','EXECUTE') allowed",[flexibleBillingAccountsFixture.runtime])).rows[0].allowed;
 assert.equal(sessionReadGranted,true,'Canonical Class Sessions grant missing; fixture ACL repairs are forbidden.');
 assert.match(flexibleBillingAccountsFixture.runtime,/^hon_[a-z_]+_runtime$/);
 const verifier=(await readFile(resolve(repo,'infra/postgres/011_verify_supabase_hon_runtime.sql'),'utf8')).split('-- Class Sessions current-school read exact verification:')[1]?.split('-- End Class Sessions current-school read exact verification.')[0];
 assert(verifier,'Accepted canonical Class Sessions verifier is missing.');
 const verifyAcl=verifier.replaceAll('hon_runtime',flexibleBillingAccountsFixture.runtime);
 await q(verifyAcl);
 const list=await sessions.loadCurrentSchoolClassSessions(a.org,a.school);assert.equal(list.length,2);assert(list.every(s=>a.sessions.includes(s.sessionId)));groups.push('signed-session bounded session read with real school resolver');
 // A rollback-only ablation proves loss of the canonical grant is detected, never silently repaired.
 await q('BEGIN');try{
  await q(`REVOKE EXECUTE ON FUNCTION hon.read_current_school_class_sessions(text) FROM "${flexibleBillingAccountsFixture.runtime}"`);
  await assert.rejects(q(verifyAcl),/Class Sessions read grant drift/);
 }finally{await q('ROLLBACK');}
 await q(verifyAcl);assert.equal((await sessions.loadCurrentSchoolClassSessions(a.org,a.school)).length,2);
 groups.push('accepted canonical ACL grants and verifier used without fixture repair; revoked grant detected and rollback restores the original posture');
 // Retain the original microsecond collision that failed before accepted migration 0203.
 // Published millisecond ties must now use the same ascending UUID order in SQL and the closed contract.
 const descending=[...b.sessions].sort().reverse();
 await q("UPDATE hon.class_sessions SET starts_at=date_trunc('second',statement_timestamp())-interval '1 hour'+CASE WHEN id=$1 THEN interval '100 microseconds' ELSE interval '200 microseconds' END,ends_at=date_trunc('second',statement_timestamp())+interval '1 hour' WHERE id=ANY($2::uuid[])",[descending[0],descending]);
 const precisionRows=(await q("SELECT id,starts_at::text raw,to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') published FROM hon.class_sessions WHERE id=ANY($1::uuid[]) ORDER BY starts_at,id",[descending])).rows;
 assert.deepEqual(precisionRows.map(r=>r.id),descending);assert.notEqual(precisionRows[0].raw,precisionRows[1].raw);assert.equal(precisionRows[0].published,precisionRows[1].published);
 actor=b;observeProjection=true;const collision=await sessions.loadCurrentSchoolClassSessions(b.org,b.school);observeProjection=false;assert.equal(projectionStatus,200);
 assert.deepEqual(collision.map(s=>s.sessionId),[...b.sessions].sort());assert.equal(collision[0].startsAt,collision[1].startsAt);
 const unchanged=(await q("SELECT id,starts_at::text raw FROM hon.class_sessions WHERE id=ANY($1::uuid[]) ORDER BY starts_at,id",[descending])).rows;
 assert.deepEqual(unchanged,precisionRows.map(({id,raw})=>({id,raw})),'The successful read must not normalize away original database precision.');actor=a;
 groups.push('accepted 0203 returns HTTP 200 and published-millisecond/UUID ordering on original colliding microsecond rows without fixture normalization or relaxed validation');
 const exact=booking.prepareClassBooking({...scope(a.students[0]),sessionId:a.sessions[0]},'REGULAR',randomUUID());lose=true;await assert.rejects(booking.submitClassBooking(exact),e=>e instanceof booking.ClassBookingUncertainError);const recovered=await booking.submitClassBooking(exact);assert.equal(recovered.replayed,true);assert.equal((await q('SELECT count(*)::int n FROM hon.class_bookings WHERE class_session_id=$1 AND student_profile_id=$2',[a.sessions[0],a.students[0]])).rows[0].n,1);groups.push('actual commit + lost response + exact-key replay without duplicate booking');
 const duplicate=await booking.submitClassBooking(booking.prepareClassBooking({...scope(a.students[0]),sessionId:a.sessions[0]},'REGULAR',randomUUID()));assert.equal(duplicate.booking.id,recovered.booking.id);groups.push('canonical semantic duplicate prevention');
 await assert.rejects(booking.submitClassBooking(booking.prepareClassBooking({...scope(a.students[0]),sessionId:a.sessions[0]},'TRIAL',randomUUID())),denied(409));await assert.rejects(booking.submitClassBooking(booking.prepareClassBooking({...scope(a.students[1]),sessionId:a.sessions[1]},'REGULAR',randomUUID())),denied(409));groups.push('conflicting kind and cancelled session refused');
 for(const student of a.students.slice(1)){const request=booking.prepareClassBooking({...scope(student),sessionId:a.sessions[0]},'TRIAL',randomUUID());const races=await Promise.allSettled([booking.submitClassBooking(request),booking.submitClassBooking(request)]);assert(races.some(r=>r.status==='fulfilled'));const row=await booking.submitClassBooking(request);assert.equal(row.booking.studentProfileId,student);assert.equal((await q('SELECT count(*)::int n FROM hon.class_bookings WHERE class_session_id=$1 AND student_profile_id=$2',[a.sessions[0],student])).rows[0].n,1);}groups.push('separate child references and concurrent exact-key booking');
 assert.equal(await web.readStudentAttendance(at(a.students[0]),new AbortController().signal),null);const first=web.prepareStudentAttendance(at(a.students[0]),{studentProfileId:a.students[0],status:'PRESENT',category:'REGULAR_PARTICIPANT',note:'Synthetic staff confirmed'},randomUUID());lose=true;await assert.rejects(web.sendStudentAttendance(first),e=>e.uncertain);const saved=await web.sendStudentAttendance(first);assert.equal(saved.replayed,true);assert.equal((await web.readStudentAttendance(at(a.students[0]),new AbortController().signal)).id,saved.attendance.id);groups.push('exact attendance read, actual write and lost-response recovery');
 const update=web.prepareStudentAttendance(at(a.students[0]),{studentProfileId:a.students[0],status:'LATE',category:'REGULAR_PARTICIPANT',note:'Synthetic correction',expectedVersion:saved.attendance.version},randomUUID());await web.sendStudentAttendance(update);await assert.rejects(web.sendStudentAttendance({...update,key:randomUUID()}),denied(409));groups.push('attendance version conflict refuses stale replacement');
 const allEffects=[...protectedTables,'class_bookings','attendance_records','attendance_record_history','idempotency_records','audit_events','outbox_events'].filter((x,i,a)=>a.indexOf(x)===i);
 const existing=(await q("SELECT relname FROM pg_class WHERE relnamespace='hon'::regnamespace AND relkind='r'")).rows.map(r=>r.relname);const tracked=allEffects.filter(t=>existing.includes(t));
 async function noEffects(fn){const before=await snapshot(tracked);await fn();assert.deepEqual(await snapshot(tracked),before);}
 actor=b;await noEffects(async()=>{await assert.rejects(sessions.loadCurrentSchoolClassSessions(a.org,a.school),denied(403));await assert.rejects(booking.submitClassBooking(exact),denied(403));await assert.rejects(web.readStudentAttendance(at(a.students[0]),new AbortController().signal),denied(403));});assert.equal((await sessions.loadCurrentSchoolClassSessions(b.org,b.school)).length,2);actor=a;groups.push('two independently authorized organizations remain isolated');
 expired=true;await noEffects(()=>assert.rejects(booking.submitClassBooking(exact),denied(401)));expired=false;groups.push('expired signed session denied before domain command');
 revoke='schedule.booking.manage';await assert.rejects(booking.submitClassBooking(exact),denied(403));await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[a.role,a.org,'schedule.booking.manage']);
 revoke='attendance.record';await assert.rejects(web.sendStudentAttendance(first),denied(403));await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[a.role,a.org,'attendance.record']);groups.push('permission revocation after actual resolver refuses booking and attendance replays');
 assert.deepEqual(await snapshot(protectedTables),protectedBefore);groups.push('zero membership, commercial, AI, payment, provider or communication changes');
 console.log(JSON.stringify({sourceSha:process.env.HON_CONNECTED_OPERATIONS_SHA,groups:groups.length,passed:groups,signedSession:true,realResolver:true,realDisposablePostgres:true,protectedTables:protectedTables.length,providers:0}));
}finally{globalThis.fetch=originalFetch;if(app)await app.close();else await database.onModuleDestroy();await owner.end();}
