/** School message templates (0586, Texts and Email pages TE2): real signed HON sessions -> Nest/guards -> the three runtime entry
 *  points, on the marked disposable communication delivery database. Schools are SYNTHETIC sign-ups made through the 0241 runtime
 *  entry point. Templates are text only: nothing is sent, queued or changed outside the template table, its audit and outbox. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??''),workerUrl=new URL(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_comm_delivery_owner'],[runtime,'hon_comm_delivery_runtime'],[workerUrl,'hon_comm_delivery_worker']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_comm_delivery_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|SENDGRID.*|ZERNIO.*|OPENAI.*|OPENROUTER.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|ZERNIO|EMAIL).*)$/i.test(key),key);
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {ValidationPipe}=require('@nestjs/common');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const TC=require('./dist/communication/school-message-templates.controller.js');
const {SchoolMessageTemplatesService}=require('./dist/communication/school-message-templates.service.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),worker=new pg.Client({connectionString:workerUrl.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'school-templates-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS SCHOOL MESSAGE TEMPLATES '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,method='GET',body,command,key,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 const text=body===undefined?undefined:JSON.stringify(body);
 command??=method==='GET'?C.SCHOOL_TEMPLATES_READ_COMMAND:path.endsWith('/status')?C.SCHOOL_TEMPLATE_STATUS_COMMAND:C.SCHOOL_TEMPLATE_SAVE_COMMAND;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',
  'x-hon-human-command':command,...(text?{'content-type':'application/json','content-length':Buffer.byteLength(text)}:{}),...(key?{'idempotency-key':key}:{}),...headers}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(t||'{}'),headers:res.headers}));});req.on('error',reject);if(text)req.write(text);req.end();});
}
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body;};
const human=label=>({externalSubject:'oidc:schooltpl:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
let terms;
async function register(label){const p=human(label);
 const r=(await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data',[p.externalSubject,p.email,{ownerName:'Synthetic '+label,schoolName:'Synthetic '+label+' Dojo',legalName:'Synthetic '+label+' LLC',timezone:'America/Chicago',termsVersionId:terms,confirmation:C.SIGNUP_CONFIRMATION},K()])).rows[0].data;
 const principal=(await q('SELECT p.id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE u.external_subject=$1',[p.externalSubject]))[0].id;
 return {...p,org:r.organizationId,school:r.schoolId,principal};}
async function staff(x,label,permissions){const p=human(label);const user=K(),principal=K(),role=K();
 await q('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)',[user,p.externalSubject,p.email,'Coach '+label]);
 await q("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)",[principal,user,'Coach '+label]);
 await q('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)',[role,x.org,'STAFF_'+role.slice(0,8)]);
 for(const code of permissions)await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,x.org,code]);
 const grant=K();await q("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')",[grant,x.org,x.school,principal,role]);
 return {...p,org:x.org,school:x.school,principal,grant,role};}
const setAccess=(x,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_from=clock_timestamp()-interval '1 day',effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[x.org,status]);
const base=x=>`organizations/${x.org}/schools/${x.school}/communications/templates`;
const list=async(x,params={})=>C.verifySchoolTemplateList(ok(await send(base(x)+(Object.keys(params).length?'?'+new URLSearchParams(params):''),{identity:x})).data,params);
const draft=(o={})=>({templateId:null,expectedVersion:0,channel:'SMS',name:'Class reminder',subject:null,body:'Hi {{first_name}}, see you at class today!',...o});
const save=(x,body,key=K())=>send(base(x),{identity:x,method:'POST',body,key});
const setStatus=(x,id,body,key=K())=>send(base(x)+'/'+id+'/status',{identity:x,method:'POST',body,key});
const counts=async()=>(await q("SELECT (SELECT count(*) FROM hon.school_message_templates) t,(SELECT count(*) FROM hon.audit_events WHERE entity_type='MESSAGE_TEMPLATE') a,(SELECT count(*) FROM hon.outbox_events WHERE aggregate_type='MESSAGE_TEMPLATE') o,(SELECT count(*) FROM hon.communication_messages) m"))[0];

try{
 await Promise.all([admin.connect(),restricted.connect(),worker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable communication delivery validation');
 // 1. Custody.
 {const entry=['read_school_message_templates','save_school_message_template','set_school_message_template_status'];
  const fns=await q("SELECT p.oid,p.proname,p.prosecdef FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND (p.proname LIKE 'school_template%' OR p.proname IN ('read_school_message_templates','save_school_message_template','set_school_message_template_status','guard_school_message_template','require_school_template_actor','school_message_template_json'))");
  assert.equal(fns.length,12,fns.map(f=>f.proname).join());
  for(const f of fns){
   assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),'runtime '+f.proname);
   assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[workerUrl.username,f.oid]))[0].ok,false,'worker '+f.proname);
   assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,'public '+f.proname);
  }
  for(const priv of ['SELECT','INSERT','UPDATE','DELETE'])for(const role of [runtime.username,workerUrl.username])
   assert.equal((await q("SELECT has_table_privilege($1,'hon.school_message_templates',$2) ok",[role,priv]))[0].ok,false,role+' '+priv);
  assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid='hon.school_message_templates'::regclass"))[0],{r:true,f:true});
  await assert.rejects(restricted.query("SELECT hon.require_school_template_actor('x','communication.template.read')"),/permission denied/);
  await assert.rejects(worker.query("SELECT hon.read_school_message_templates('x','{}'::jsonb)"),/permission denied/);
  assert.equal((await q("SELECT count(*)::int n FROM hon.permissions WHERE code IN ('communication.template.read','communication.template.manage') AND NOT is_sensitive AND is_staff_assignable"))[0].n,2);}
 {const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const start=verify.indexOf('-- School message templates exact verification');assert(start>=0,'the 011 section exists');
  const section=verify.slice(start,verify.indexOf('-- End school message templates exact verification',start));
  await admin.query(section.replaceAll('hon_runtime',runtime.username));
  for(const leak of [`GRANT EXECUTE ON FUNCTION hon.school_template_tags_ok(text) TO ${runtime.username}`,`GRANT SELECT ON hon.school_message_templates TO ${runtime.username}`]){
   await admin.query('BEGIN');
   try{await admin.query(leak);await assert.rejects(admin.query(section.replaceAll('hon_runtime',runtime.username)),/Unsafe school message template/,leak);}finally{await admin.query('ROLLBACK');}}}
 pass('the runtime executes exactly the three entry points and has no table privilege; nine helpers are private; forced RLS; two staff-assignable permissions; the 011 section passes and catches a leaked helper or table grant');

 const module=await Test.createTestingModule({controllers:[TC.SchoolMessageTemplatesController],providers:[SchoolMessageTemplatesService,TC.SchoolTemplatesReadGuard,TC.SchoolTemplateSaveGuard,TC.SchoolTemplateStatusGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true}));await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const x of [a,b])await setAccess(x,'ACTIVE');
 assert.equal((await q("SELECT count(*)::int n FROM hon.roles r JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id WHERE r.organization_id=$1 AND r.code='OWNER' AND rp.permission_code IN ('communication.template.read','communication.template.manage')",[a.org]))[0].n,2,'a new school owner gets both permissions');

 // 2. Add, list, change, exact replay and key reuse.
 const before=await counts();
 let r=ok(await save(a,draft()));const sms=C.verifySchoolTemplateReceipt({template:r.data,replayed:r.meta.replayed},{version:1,channel:'SMS',status:'ACTIVE'}).template;
 assert.deepEqual([sms.name,sms.subject,sms.body,sms.status,r.meta.replayed],['Class reminder',null,'Hi {{first_name}}, see you at class today!','ACTIVE',false]);
 const emailBody='Hello {{ first_name }},\n\nWelcome to {{school_name}}! 🥋👨‍👩‍👧\n\n{{staff_name}}';
 const key=K();r=ok(await save(a,draft({channel:'EMAIL',name:'Welcome email',subject:'Welcome to {{school_name}}',body:emailBody}),key));const email=r.data;
 assert.deepEqual([email.channel,email.subject,email.body],['EMAIL','Welcome to {{school_name}}',emailBody],'new lines, emoji with joiners and spaced tags kept');
 r=ok(await save(a,draft({channel:'EMAIL',name:'Welcome email',subject:'Welcome to {{school_name}}',body:emailBody}),key));
 assert.deepEqual([r.data.templateId,r.meta.replayed],[email.templateId,true],'exact replay');
 assert.equal((await save(a,draft({name:'Other'}),key)).body.code,'IDEMPOTENCY_KEY_REUSED');
 assert.deepEqual((await list(a)).templates.map(t=>t.name),['Class reminder','Welcome email']);
 assert.deepEqual((await list(a,{channel:'EMAIL'})).templates.map(t=>t.templateId),[email.templateId]);
 assert.deepEqual((await list(b)).templates,[],'another school sees none');
 r=ok(await save(a,draft({templateId:sms.templateId,expectedVersion:1,name:'Class reminder (evening)',body:'See you at 6pm, {{first_name}}.'})));
 assert.deepEqual([r.data.version,r.data.name,r.data.templateId],[2,'Class reminder (evening)',sms.templateId]);
 assert.equal((await save(a,draft({templateId:sms.templateId,expectedVersion:1}))).body.code,'VERSION_CONFLICT');
 assert.equal((await save(a,draft({templateId:sms.templateId,expectedVersion:2,channel:'EMAIL',subject:'S'}))).status,400,'the channel never changes');
 assert.equal((await save(a,draft({templateId:K(),expectedVersion:1}))).body.code,'MESSAGE_TEMPLATE_NOT_FOUND');
 assert.equal((await save(b,draft({templateId:sms.templateId,expectedVersion:2}))).body.code,'MESSAGE_TEMPLATE_NOT_FOUND','another school cannot reach it');
 {const after=await counts();assert.equal(Number(after.t)-Number(before.t),2);assert.equal(Number(after.a)-Number(before.a),3);assert.equal(Number(after.o)-Number(before.o),3);assert.equal(after.m,before.m,'no message is created');
  const audit=await q("SELECT action_code,next_state FROM hon.audit_events WHERE entity_type='MESSAGE_TEMPLATE' AND entity_id=$1 ORDER BY occurred_at,id",[sms.templateId]);
  assert.deepEqual(audit.map(x=>x.action_code),['message_template.create','message_template.update']);
  assert.deepEqual(Object.keys(audit[1].next_state).sort(),['channel','status','templateId','version'],'the audit keeps no text');
  const out=await q("SELECT payload FROM hon.outbox_events WHERE aggregate_type='MESSAGE_TEMPLATE' AND aggregate_id=$1",[sms.templateId]);
  assert(out.every(o=>!JSON.stringify(o.payload).includes('6pm')),'the outbox keeps no text');}
 pass('staff add and change texts and emails by exact version; exact replay returns the same template; key reuse, stale versions, channel changes and other schools are refused; audit and outbox keep ids only; no message is created');

 // 3. Validation: names, subjects, bodies, closed merge tags, caps.
 const bad=[draft({name:''}),draft({name:' padded'}),draft({name:'x'.repeat(81)}),draft({name:'Tab\there'}),draft({name:'Hidden‮flip'}),
  draft({body:''}),draft({body:' \n '}),draft({body:'x'.repeat(1001)}),draft({body:'Bell\u0007'}),draft({body:'Hi {{first}}'}),draft({body:'Hi {{First_Name}}'}),
  draft({subject:'SMS has no subject'}),draft({channel:'EMAIL',subject:null}),draft({channel:'EMAIL',subject:'x'.repeat(151)}),draft({channel:'EMAIL',subject:'{{phone}}'}),
  draft({channel:'EMAIL',subject:'Hi',body:'x'.repeat(3501)}),draft({expectedVersion:1}),draft({templateId:K()}),draft({channel:'APP'}),{...draft(),extra:1},
  (()=>{const d=draft();delete d.subject;return d;})()];
 for(const body of bad)assert.equal((await save(a,body)).status,400,JSON.stringify(body).slice(0,80));
 ok(await save(a,draft({name:'Long text',body:'🥋'.repeat(1000)})),200);
 ok(await save(a,draft({channel:'EMAIL',name:'Long email',subject:'s'.repeat(150),body:'x'.repeat(3500)})),200);
 assert.equal((await save(a,draft({name:'CLASS REMINDER (EVENING)'}))).body.code,'MESSAGE_TEMPLATE_NAME_TAKEN','names are unique per channel, case-insensitive');
 ok(await save(a,draft({channel:'EMAIL',name:'Class reminder (evening)',subject:'Tonight'})),200);
 // Caps: 100 active per channel, 500 in all (counted under the per-school lock).
 {const c=await register('gamma');await setAccess(c,'ACTIVE');
  await q("INSERT INTO hon.school_message_templates(organization_id,school_id,channel,name,body,status,created_by_principal_id,updated_by_principal_id) SELECT $1,$2,'SMS','Bulk '||g,'Body',  'ACTIVE',$3,$3 FROM generate_series(1,100) g",[c.org,c.school,c.principal]);
  assert.equal((await save(c,draft({name:'One more'}))).body.code,'MESSAGE_TEMPLATE_LIMIT');assert.equal((await save(c,draft({name:'One more'}))).status,413);
  ok(await save(c,draft({channel:'EMAIL',name:'Email still fine',subject:'S'})),200);}
 assert.equal((await list(a)).templates.length,5);
 pass('names 1-80 trimmed with no control or direction characters; email subjects 1-150 and only on emails; bodies up to 1,000 (SMS) or 3,500 (email) characters counted like the database (emoji are one); only the four blasts merge tags; names unique per channel; 100 active per channel');

 // 4. Archive and restore.
 const evening=(await list(a,{channel:'SMS'})).templates.find(t=>t.name==='Class reminder (evening)');
 r=ok(await setStatus(a,evening.templateId,{expectedVersion:evening.version,status:'ARCHIVED'}));
 assert.deepEqual([r.data.status,r.data.version],['ARCHIVED',3]);
 assert(!(await list(a)).templates.some(t=>t.templateId===evening.templateId));
 assert.deepEqual((await list(a,{status:'ARCHIVED'})).templates.map(t=>t.templateId),[evening.templateId]);
 assert.equal((await save(a,draft({templateId:evening.templateId,expectedVersion:3}))).body.code,'MESSAGE_TEMPLATE_ARCHIVED');
 assert.equal((await setStatus(a,evening.templateId,{expectedVersion:3,status:'ARCHIVED'})).body.code,'MESSAGE_TEMPLATE_STATUS_UNCHANGED');
 // A new template takes the freed name; restoring the old one is then refused until renamed.
 const taken=ok(await save(a,draft({name:'Class reminder (evening)'}))).data;
 assert.equal((await setStatus(a,evening.templateId,{expectedVersion:3,status:'ACTIVE'})).body.code,'MESSAGE_TEMPLATE_NAME_TAKEN');
 ok(await setStatus(a,taken.templateId,{expectedVersion:1,status:'ARCHIVED'}));
 r=ok(await setStatus(a,evening.templateId,{expectedVersion:3,status:'ACTIVE'}));assert.deepEqual([r.data.status,r.data.version],['ACTIVE',4]);
 assert.equal((await setStatus(a,evening.templateId,{expectedVersion:4,status:'ARCHIVED',templateId:K()})).status,400,'the body cannot name a template');
 assert.equal((await setStatus(b,evening.templateId,{expectedVersion:4,status:'ARCHIVED'})).body.code,'MESSAGE_TEMPLATE_NOT_FOUND');
 assert.deepEqual((await q("SELECT action_code FROM hon.audit_events WHERE entity_type='MESSAGE_TEMPLATE' AND entity_id=$1 ORDER BY occurred_at,id",[evening.templateId])).map(x=>x.action_code).slice(-2),['message_template.archive','message_template.restore']);
 pass('archive hides a template from the active list and blocks changes until restored; restoring needs the name free; same-state, stale and other-school requests are refused');

 // 5. Authority.
 const reader=await staff(a,'reader',['communication.template.read']),manager=await staff(a,'manager',['communication.template.read','communication.template.manage']),none=await staff(a,'none',['communication.message.read']);
 assert((await list(reader)).templates.length>0);
 assert.equal((await save(reader,draft({name:'Reader try'}))).status,403,'read does not open writing');
 ok(await save(manager,draft({name:'Manager template'})));
 assert.equal((await send(base(none),{identity:none})).status,403);
 assert.equal((await send(base(b),{identity:a})).status,403,'another school in the route');
 assert.equal((await send(base(a),{identity:human('stranger')})).status,403);
 assert.equal((await send(base(a))).status,401);
 assert.equal((await send(base(a),{identity:a,method:'POST',body:draft({name:'No key'})})).body.code,'IDEMPOTENCY_KEY_REQUIRED');
 assert.equal((await send(base(a),{identity:a,headers:{'idempotency-key':'k'}})).status,409,'a read with a key');
 assert.equal((await send(base(a),{identity:a,method:'POST',body:draft({name:'Wrong command'}),key:K(),command:C.SCHOOL_TEMPLATE_STATUS_COMMAND})).status,403,'the wrong browser command');
 assert.equal((await send(base(a),{identity:a,method:'POST',body:draft({name:'Cross'}),key:K(),headers:{origin:'https://evil.example.invalid'}})).status,403,'another origin');
 assert.equal((await send(base(a)+'?x=1',{identity:a,method:'POST',body:draft({name:'Query'}),key:K()})).status,400,'query values on a command');
 assert.equal((await send(base(a)+'?limit=9',{identity:a})).status,400,'unknown list filter');
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[manager.grant]);
 assert.equal((await save(manager,draft({name:'After revoke'}))).status,403,'a revoked grant');
 await setAccess(a,'SUSPENDED');
 assert.equal((await send(base(a),{identity:a})).status,403,'suspended access');
 assert.equal((await save(a,draft({name:'Suspended'}))).status,403);
 await setAccess(a,'ACTIVE');
 assert(!(await list(a)).templates.some(t=>['Reader try','After revoke','Suspended','No key','Wrong command','Cross','Query'].includes(t.name)),'nothing refused was written');
 pass('reading needs communication.template.read and writing .manage at the exact school with live access; revoked grants, strangers, signed-out callers, other schools, wrong commands, other origins, missing keys and query values are refused with nothing written');

 // 6. Direct calls and the table itself.
 {const direct=async(settings,sql,args)=>{await restricted.query('BEGIN');
   try{if(settings){await restricted.query("SELECT set_config('app.hon_external_subject',$1,true),set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source',$5,true),set_config('app.hon_principal_id',$2,true),set_config('app.hon_organization_id',$3,true),set_config('app.hon_school_id',$4,true),set_config('app.hon_action_request_id',$6,true),set_config('app.hon_delegated_by_principal_id','',true),set_config('app.hon_request_id',$7,true)",[a.externalSubject,a.principal,a.org,a.school,settings.source??'HUMAN_UI',settings.action??'',settings.request??'']);}
    return (await restricted.query(sql,args)).rows[0];}finally{await restricted.query('ROLLBACK');}};
  const call="SELECT hon.save_school_message_template($1,$2::jsonb,$3,$4::uuid,$5::uuid) d";
  await assert.rejects(direct(null,"SELECT hon.read_school_message_templates($1,'{}'::jsonb)",[a.externalSubject]),/MESSAGE_TEMPLATE_FORBIDDEN/,'no session context');
  await assert.rejects(direct({source:'AI_AGENT'},"SELECT hon.read_school_message_templates($1,'{}'::jsonb)",[a.externalSubject]),/MESSAGE_TEMPLATE_FORBIDDEN/,'not a human UI call');
  await assert.rejects(direct({},"SELECT hon.read_school_message_templates($1,'{}'::jsonb)",[b.externalSubject]),/MESSAGE_TEMPLATE_FORBIDDEN/,'another subject');
  const rq=K();
  await assert.rejects(direct({request:rq,action:K()},call,[a.externalSubject,draft({name:'Delegated'}),'k1',rq,rq]),/MESSAGE_TEMPLATE_FORBIDDEN/,'an action request');
  await assert.rejects(direct({request:K()},call,[a.externalSubject,draft({name:'Wrong request'}),'k2',rq,rq]),/VALIDATION_FAILED/,'a request id that is not the session one');
  for(const body of [draft({name:'Tag',body:'Hi {{phone}}'}),draft({name:'Long',body:'x'.repeat(1001)}),draft({name:'Subj',subject:'x'}),draft({channel:'EMAIL',name:'No subj'}),{...draft(),extra:true}])
   await assert.rejects(direct({request:rq},call,[a.externalSubject,body,'k4',rq,rq]),/VALIDATION_FAILED/,'the database validates on its own: '+JSON.stringify(body).slice(0,60));
  assert.equal((await direct({request:rq},call,[a.externalSubject,draft({name:'Direct ok'}),'k3',rq,rq])).d.template.name,'Direct ok','the right context writes');
  // The table refuses deletes, scope or channel changes and version skips even for the owner.
  const id=evening.templateId;
  for(const sql of ['DELETE FROM hon.school_message_templates WHERE id=$1',"UPDATE hon.school_message_templates SET channel='EMAIL',email_subject='x',version=version+1 WHERE id=$1",
    'UPDATE hon.school_message_templates SET body=$$x$$ WHERE id=$1',`UPDATE hon.school_message_templates SET school_id='${b.school}',version=version+1 WHERE id=$1`]){
   await admin.query('BEGIN');try{await assert.rejects(admin.query(sql,[id]),/MESSAGE_TEMPLATE_IMMUTABLE|violates/,sql);}finally{await admin.query('ROLLBACK');}}
  await admin.query('BEGIN');try{await assert.rejects(admin.query("UPDATE hon.school_message_templates SET body='Hi {{phone}}',version=version+1 WHERE id=$1",[id]),/check constraint/);}finally{await admin.query('ROLLBACK');}}
 pass('direct runtime calls with input the contract would refuse fail VALIDATION_FAILED in the database too; calls without the human session, from another source, another subject, an action request or a foreign request id are refused; the table refuses deletes, channel or school moves, version skips and unknown tags even for the owner');
 console.log(`PASS SCHOOL MESSAGE TEMPLATES: ${groups} groups`);
}finally{await app?.close();await Promise.allSettled([admin.end(),restricted.end(),worker.end(),database.onModuleDestroy?.()]);}
