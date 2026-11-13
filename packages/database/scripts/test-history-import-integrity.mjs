/** Class list and attendance-history import (0333): real signed HON sessions -> Nest/guards -> fixed runtime SQL -> marked disposable
 *  PostgreSQL. No provider, payment, message or AI. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point; the sign-up
 *  program is opened to TEST_MODE by this proof's owner connection only, and paid access is stood in by the owner connection. Synthetic names only. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {HistoryImportController}=require('./dist/migration/history-import.controller.js');
const {HistoryImportService}=require('./dist/migration/history-import.service.js');
const guards=require('./dist/migration/history-import-human-ui.guard.js');
const {SIGNUP_CONFIRMATION,verifyHistoryImportDetail}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'history-import-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS HISTORY '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body).slice(0,600));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const refused=(r,status,code)=>{assert.equal(r.status,status,JSON.stringify(r.body).slice(0,600));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));assert(!('data' in r.body));};
const person=label=>({externalSubject:'oidc:history:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=person(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:SIGNUP_CONFIRMATION},K()])).rows[0].data;
 return {...p,org:r.organizationId,school:r.schoolId};}
const base=w=>`organizations/${w.org}/schools/${w.school}/history-imports`;
const csvOf=rows=>rows.map(r=>r.map(c=>/[",\n]/.test(c)?'"'+c.replaceAll('"','""')+'"':c).join(',')).join('\n')+'\n';
const stage=(w,kind,rows,mapping,extra={})=>send(base(w),{identity:w,method:'POST',command:'history.import.stage',body:{kind,csv:csvOf(rows),mapping},...extra});
const detail=async(w,id)=>verifyHistoryImportDetail(ok(await send(base(w)+'/'+id,{identity:w})),id);
const decide=(w,id,v,decisions,extra={})=>send(base(w)+'/'+id+'/decisions',{identity:w,method:'POST',command:'history.import.decide',body:{expectedVersion:v,decisions},...extra});
const finalize=(w,id,v,selectedIndices,extra={})=>send(base(w)+'/'+id+'/finalize',{identity:w,method:'POST',command:'history.import.finalize',body:{expectedVersion:v,selectedIndices},...extra});
const setAccess=(w,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[w.org,status]);
const live=async w=>(await q(`SELECT (SELECT count(*) FROM hon.class_sessions WHERE organization_id=$1) s,(SELECT count(*) FROM hon.class_bookings WHERE organization_id=$1) b,
 (SELECT count(*) FROM hon.attendance_records WHERE organization_id=$1) a`,[w.org]))[0];
async function student(w,given,family,birth){
 const fam=(await q("INSERT INTO hon.families(organization_id,school_id,display_name) VALUES($1,$2,$3) RETURNING id",[w.org,w.school,family+' family']))[0].id;
 const p=(await q("INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4) RETURNING id",[w.org,w.school,given,family]))[0].id;
 await q("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,'STUDENT',false)",[w.org,w.school,fam,p]);
 return (await q("INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES($1,$2,$3,$4,$5) RETURNING id",[w.org,w.school,p,fam,birth]))[0].id;
}

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL.
 for(const t of ['history_import_batches','history_import_rows','history_import_requests','imported_attendance_history']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced,t);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const entry=['stage_history_import','decide_history_import','finalize_history_import','read_history_imports','read_history_import','read_imported_attendance'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%history_import%' OR p.proname='read_imported_attendance')");
 assert.equal(fns.length,21);
 for(const f of fns)assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),f.proname);
 pass('forced deny-all RLS on four new tables; runtime executes exactly six entry points');

 const module=await Test.createTestingModule({controllers:[HistoryImportController],providers:[HistoryImportService,...Object.values(guards),HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 await setAccess(a,'ACTIVE');await setAccess(b,'ACTIVE');
 const today=(await q("SELECT to_char(hon.membership_local_date(clock_timestamp(),'America/Chicago'),'YYYY-MM-DD') d"))[0].d;
 const before=await live(a);

 // 2. Classes: every format revalidated in the database, stated defaults, programs matched or created once, series with no sessions.
 await q("INSERT INTO hon.programs(organization_id,school_id,name,status) VALUES($1,$2,'Little Tigers','SCHEDULED')",[a.org,a.school]);
 const classHead=['Class','Program','Days','Time','Minutes','Spots','Note'];
 const classMap={Class:'className',Program:'programName',Days:'weekdays',Time:'startTime',Minutes:'durationMinutes',Spots:'capacity',Note:'ignore'};
 const classRows=[classHead,
  ['Tigers A','little tigers','Mon, Wed','4:30 PM','45','15','private note'],
  ['Adults','','tuesday/thursday','19:00','60','','x'],
  ['Adults','Adults','Sat','10am','60','',''],
  ['Adults','Adults','Tue Thu','7:00 pm','60','',''],
  ['Broken','','Funday','25:00','2','0',''],
  ['=HYPERLINK("x")','','Mon','18:00','60','10','']];
 const key=K();let r=await stage(a,'CLASSES',classRows,classMap,{key});let batch=ok(r);
 assert.equal(batch.kind,'CLASSES');assert.equal(batch.rowCount,6);assert.equal(batch.validCount,3);assert.equal(r.body.meta.replayed,false);
 r=await stage(a,'CLASSES',classRows,classMap,{key});assert.deepEqual(ok(r),batch);assert.equal(r.body.meta.replayed,true);
 refused(await stage(a,'CLASSES',classRows.slice(0,3),classMap,{key}),409,'IDEMPOTENCY_KEY_REUSED');
 let d=await detail(a,batch.id);
 assert.deepEqual(d.rows[0].normalized,{className:'Tigers A',programName:'little tigers',weekdays:'1,3',startTime:'16:30',durationMinutes:'45',capacity:'15',bookingPolicy:'WALK_IN',startsOn:today,roomName:''});
 assert.deepEqual(d.rows[0].raw.at(-1),'');assert.equal(d.rows[1].normalized.programName,'Adults');assert.equal(d.rows[1].normalized.capacity,'20');
 assert.equal(d.rows[2].normalized.startTime,'10:00');assert.deepEqual(d.rows[3].errors,['row:REPEATED_IN_FILE']);
 assert.deepEqual(d.rows[4].errors.sort(),['capacity:OUT_OF_RANGE','durationMinutes:OUT_OF_RANGE','startTime:USE_HH_MM','weekdays:UNKNOWN_DAY']);
 assert(d.rows[5].errors.includes('className:FORMULA_INJECTION'));
 refused(await stage(a,'CLASSES',[['Class','Days'],['A','Mon']],{Class:'className',Days:'weekdays'}),400,'HISTORY_IMPORT_INVALID');
 refused(await stage(a,'CLASSES',[['Name','Days','Time','Minutes'],['A','Mon','10:00','30']],{Name:'studentGivenName',Days:'weekdays',Time:'startTime',Minutes:'durationMinutes'}),400,'HISTORY_IMPORT_INVALID');
 refused(await decide(a,batch.id,1,[{index:5,choice:'IMPORT'}]),400,'HISTORY_IMPORT_ROW_NOT_IMPORTABLE');
 batch=ok(await decide(a,batch.id,1,[{index:1,choice:'IMPORT'},{index:2,choice:'IMPORT'},{index:3,choice:'IMPORT'}]));assert.equal(batch.version,2);
 refused(await finalize(a,batch.id,2,[1,2,3]),409,'HISTORY_IMPORT_SELECTION_REQUIRED');
 batch=ok(await decide(a,batch.id,2,[{index:4,choice:'SKIP'},{index:5,choice:'SKIP'},{index:6,choice:'SKIP'}]));
 refused(await finalize(a,batch.id,3,[1,2]),409,'HISTORY_IMPORT_SELECTION_REQUIRED');refused(await finalize(a,batch.id,2,[1,2,3]),409,'VERSION_CONFLICT');
 const fk=K();batch=ok(await finalize(a,batch.id,3,[1,2,3],{key:fk}));assert.equal(batch.status,'FINALIZED');assert.equal(batch.importedCount,3);
 r=await finalize(a,batch.id,3,[1,2,3],{key:fk});assert.equal(r.body.meta.replayed,true);assert.deepEqual(ok(r),batch);
 d=await detail(a,batch.id);
 const series=await q("SELECT x.name,x.weekdays,to_char(x.local_start_time,'HH24:MI') t,x.capacity,x.status,x.ongoing,x.generated_through,g.name program,g.status::text pstatus FROM hon.class_series x JOIN hon.programs g ON g.id=x.program_id WHERE x.organization_id=$1 ORDER BY x.created_at,x.id",[a.org]);
 assert.equal(series.length,3);assert.deepEqual(series.map(s=>[s.name,s.weekdays,s.t,s.capacity,s.program]),[['Tigers A',[1,3],'16:30',15,'Little Tigers'],['Adults',[2,4],'19:00',20,'Adults'],['Adults',[6],'10:00',20,'Adults']]);
 assert(series.every(s=>s.status==='ACTIVE'&&s.ongoing===false&&s.generated_through===null));assert.equal(series[1].pstatus,'DRAFT');
 assert.equal((await q("SELECT count(*) n FROM hon.programs WHERE organization_id=$1",[a.org]))[0].n,'2');
 assert.equal(d.rows[1].created.programId,d.rows[2].created.programId);
 assert.deepEqual(await live(a),before);
 const evidence=await q("SELECT action_code,next_state::text s FROM hon.audit_events WHERE organization_id=$1 AND action_code LIKE 'history.import.%'",[a.org]);
 assert.equal(evidence.filter(e=>e.action_code==='history.import.row_applied').length,3);
 assert(evidence.every(e=>!/Tigers|Adults|16:30|little/i.test(e.s)),'identifier-only audit');
 assert.equal((await q("SELECT count(*) n FROM hon.outbox_events WHERE organization_id=$1 AND event_type LIKE 'history.import.%'",[a.org]))[0].n,String(evidence.length));
 const again=ok(await stage(a,'CLASSES',classRows.slice(0,3),classMap));d=await detail(a,again.id);
 assert(d.rows.every(x=>x.errors.includes('className:ALREADY_SCHEDULED')));
 pass('classes stage with exact replay and refused key reuse, every cell normalized or refused in the database, stated defaults, one program per name, ACTIVE series with ongoing off and no session, booking or attendance, identifier-only evidence, and a re-import refused as already scheduled');

 // 3. Attendance: exact name matches only, narrowed by birth date; imported history only.
 const solo=await student(a,'Mina','Park','2015-04-02');
 const twinA=await student(a,'Jun','Lee','2012-01-10'),twinB=await student(a,'Jun','Lee','2014-06-20');
 const attHead=['First','Last','Born','Date','Classes','Class'];
 const attMap={First:'studentGivenName',Last:'studentFamilyName',Born:'birthDate',Date:'attendedOn',Classes:'visits',Class:'className'};
 const attRows=[attHead,
  ['mina','PARK','','2026-01-05','','Tigers A'],
  ['Mina','Park','','2025-12-31','42',''],
  ['Jun','Lee','','2026-01-06','',''],
  ['Jun','Lee','2014-06-20','2026-01-06','',''],
  ['Nobody','Here','','2026-01-06','',''],
  ['Mina','Park','','2026-01-05','3','tigers a'],
  ['Mina','Park','','2999-01-01','0','']];
 batch=ok(await stage(a,'ATTENDANCE',attRows,attMap));assert.equal(batch.validCount,3);
 d=await detail(a,batch.id);
 assert.deepEqual(d.rows.map(x=>x.matchedStudentProfileId),[solo,solo,null,twinB,null,solo,solo]);
 assert.deepEqual(d.rows.map(x=>x.errors),[[],[],['student:AMBIGUOUS'],[],['student:NOT_FOUND'],['row:REPEATED_IN_FILE'],['attendedOn:OUT_OF_RANGE','visits:OUT_OF_RANGE']]);
 batch=ok(await decide(a,batch.id,1,[1,2,4].map(index=>({index,choice:'IMPORT'})).concat([3,5,6,7].map(index=>({index,choice:'SKIP'})))));
 batch=ok(await finalize(a,batch.id,batch.version,[1,2,4]));assert.equal(batch.importedCount,3);
 const hist=ok(await send(base(a)+'/students/'+solo+'/attendance',{identity:a}));
 assert.deepEqual([hist.totalVisits,hist.firstOn,hist.lastOn,hist.entries.length],[43,'2025-12-31','2026-01-05',2]);
 assert.equal(ok(await send(base(a)+'/students/'+twinA+'/attendance',{identity:a})).totalVisits,0);
 assert.deepEqual(await live(a),before);
 d=await detail(a,ok(await stage(a,'ATTENDANCE',attRows.slice(0,2),attMap)).id);assert.deepEqual(d.rows[0].errors,['row:ALREADY_IMPORTED']);
 pass('attendance rows match only exact names at this school, birth date narrows twins, unknown and ambiguous rows cannot import, finalize writes imported history only (no session, booking or attendance record), totals read back, and a re-import is flagged');

 // 4. Authority: class import also needs schedule permission; other schools, delegation, a wrong command and lost access are refused.
 await q("DELETE FROM hon.role_permissions WHERE organization_id=$1 AND permission_code='schedule.session.manage'",[b.org]);
 refused(await stage(b,'CLASSES',classRows.slice(0,2),classMap),403,'HISTORY_IMPORT_FORBIDDEN');
 const bStudent=await student(b,'Mina','Park',null);
 const bBatch=ok(await stage(b,'ATTENDANCE',attRows.slice(0,2),attMap));
 assert.equal((await detail(b,bBatch.id)).rows[0].matchedStudentProfileId,bStudent);
 refused(await send(base(a)+'/'+bBatch.id,{identity:a}),404,'HISTORY_IMPORT_NOT_FOUND');
 refused(await send(base(a)+'/students/'+bStudent+'/attendance',{identity:a}),404,'HISTORY_IMPORT_NOT_FOUND');
 refused(await decide(a,bBatch.id,1,[{index:1,choice:'SKIP'}]),404,'HISTORY_IMPORT_NOT_FOUND');
 refused(await send(base(a),{identity:b}),403);
 refused(await send(base(a),{identity:a,headers:{'x-hon-delegated-by-principal-id':K()}}),403);
 refused(await stage(a,'ATTENDANCE',attRows.slice(0,2),attMap,{command:'students.import.stage'}),403);
 refused(await send(base(a),{identity:person('stranger')}),403);
 await setAccess(b,'SUSPENDED');
 refused(await send(base(b),{identity:b}),403,'HISTORY_IMPORT_FORBIDDEN');refused(await decide(b,bBatch.id,1,[{index:1,choice:'IMPORT'}]),403,'HISTORY_IMPORT_FORBIDDEN');
 assert.equal((await q("SELECT count(*) n FROM hon.history_import_batches WHERE organization_id=$1",[b.org]))[0].n,'1');
 pass('class import needs schedule permission, attendance import does not; batches and students of another school are not found; another school, delegation, a wrong browser command, a stranger and suspended access are refused with nothing written');

 // 5. Evidence rows cannot be changed or removed outside the entry points.
 await assert.rejects(()=>q('DELETE FROM hon.history_import_batches WHERE organization_id=$1',[a.org]),/HISTORY_IMPORT_IMMUTABLE/);
 await assert.rejects(()=>q('UPDATE hon.imported_attendance_history SET visit_count=visit_count+1 WHERE organization_id=$1',[a.org]),/HISTORY_IMPORT_IMMUTABLE/);
 await assert.rejects(()=>q("UPDATE hon.history_import_rows SET choice='SKIP' WHERE organization_id=$1 AND series_id IS NOT NULL",[a.org]),/HISTORY_IMPORT_IMMUTABLE/);
 await assert.rejects(()=>q('UPDATE hon.history_import_requests SET response=$2 WHERE organization_id=$1',[a.org,'{}']),/HISTORY_IMPORT_IMMUTABLE/);
 await assert.rejects(()=>q('TRUNCATE hon.imported_attendance_history, hon.history_import_rows'),/HISTORY_IMPORT_IMMUTABLE/);
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.imported_attendance_history'),e=>e.code==='42501');
 pass('batches, rows, requests and imported history refuse delete, truncate and rewrites; the runtime role cannot read the tables');
 console.log('PASS: class and attendance-history import (0333), '+groups+' groups');
}finally{await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(()=>{});await app?.close();await Promise.allSettled([admin.end(),restricted.end()]);}
