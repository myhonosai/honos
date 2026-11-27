/** Conversation AI training (0420, CA2a): real signed HON sessions -> Nest/guards -> fixed runtime SQL for Train AI (settings,
 *  training library, original files, knowledge preview) and the HQ program switch, on the marked disposable communication
 *  delivery database. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry point. No AI provider is called and
 *  nothing is sent anywhere. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
import {readFile as readText} from 'node:fs/promises';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??''),workerUrl=new URL(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_comm_delivery_owner'],[runtime,'hon_comm_delivery_runtime'],[workerUrl,'hon_comm_delivery_worker']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_comm_delivery_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|SENDGRID.*|ZERNIO.*|OPENAI.*|OPENROUTER.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|ZERNIO).*)$/i.test(key),key);
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {json}=require('express');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const AC=require('./dist/conversations/conversation-ai.controller.js');
const {ConversationAiService}=require('./dist/conversations/conversation-ai.service.js');
const {ConversationAiTestService}=require('./dist/conversations/conversation-ai-test.service.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),worker=new pg.Client({connectionString:workerUrl.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'conversation-ai-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS CONVERSATION AI '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,body,key=K(),method='GET',command=C.CONVERSATION_AI_READ_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':command,...(method==='POST'?{'content-type':'application/json',...(key===null?{}:{'idempotency-key':key})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const refused=(r,status,code)=>{assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code??r.body.message?.code,code,JSON.stringify(r.body));};
const human=label=>({externalSubject:'oidc:convai:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
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
 return {...p,org:x.org,school:x.school,principal,grant};}
async function hqPerson(label,role){const p=human(label);const user=K(),principal=K();
 await q('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)',[user,p.externalSubject,p.email,'HQ '+label]);
 await q("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3)",[principal,user,'HQ '+label]);
 if(role)await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 day')",[principal,role,role==='HON_HQ_OWNER'?['hq.dashboard.view']:['hq.billing.manage']]);
 return {...p,principal};}
const setAccess=(x,status)=>q("UPDATE hon.organization_entitlements SET status=$2,effective_from=clock_timestamp()-interval '1 day',effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1",[x.org,status]);
const base=x=>`organizations/${x.org}/schools/${x.school}/conversation-ai`;
const overview=async x=>C.verifyConversationAiOverview(ok(await send(base(x),{identity:x})));
const post=(x,path,command,body,extra={})=>send(base(x)+'/'+path,{identity:x,method:'POST',command,body,...extra});
const setSettings=(x,body,extra)=>post(x,'settings',C.CONVERSATION_AI_SETTINGS_COMMAND,body,extra);
const saveItem=(x,body,extra)=>post(x,'items',C.CONVERSATION_AI_ITEM_SAVE_COMMAND,body,extra);
const itemStatus=(x,body,extra)=>post(x,'items/status',C.CONVERSATION_AI_ITEM_STATUS_COMMAND,body,extra);
const upload=(x,body,extra)=>post(x,'files',C.CONVERSATION_AI_UPLOAD_COMMAND,body,extra);
const knowledge=x=>send(base(x)+'/knowledge',{identity:x,command:C.CONVERSATION_AI_KNOWLEDGE_COMMAND});
const readFile=(x,id)=>send(base(x)+'/files/'+id,{identity:x,command:C.CONVERSATION_AI_FILE_COMMAND});
const settingsBody=(v,extra={})=>({expectedVersion:v,enabled:true,modes:{SMS:'ASSIST',WEB_CHAT:'AUTOMATIC',EMAIL:'OFF'},handoffWords:['human','manager','complaint','refund'],
 afterHoursText:'Thanks for your message. We are closed now and will reply in the morning.',smsMaxChars:500,chatMaxChars:900,languages:['en','ko'],...extra});
const hq=(subject,sql,args)=>restricted.query(sql,[subject,...args]);
const program=subject=>hq(subject,'SELECT hon.read_conversation_ai_program_from_hq($1) data',[]).then(r=>C.validateConversationAiProgram(r.rows[0].data));
const switchProgram=(subject,body,key=K())=>hq(subject,'SELECT hon.command_conversation_ai_program($1,$2::jsonb,$3::uuid) data',[JSON.stringify(body),key]).then(r=>C.validateConversationAiProgramReceipt(r.rows[0].data));
const b64=s=>Buffer.from(s).toString('base64');
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('synthetic schedule photo bytes')]);

try{
 await Promise.all([admin.connect(),restricted.connect(),worker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable communication delivery validation');
 // 1. Custody: forced deny-all RLS, no table privilege; the runtime executes exactly the nine entry points, the worker none.
 const tables=['conversation_ai_program','conversation_ai_program_changes','school_conversation_ai_settings','school_ai_training_files','school_ai_training_items'];
 for(const t of tables){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced,t);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const role of [runtime.username,workerUrl.username])for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
   assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[role,'hon.'+t,p]))[0].ok,false,role+':'+t+':'+p);
 }
 const entry=['read_school_conversation_ai','read_school_ai_knowledge','set_school_conversation_ai_settings','upload_school_ai_training_file','read_school_ai_training_file',
  'save_school_ai_training_item','set_school_ai_training_item_status','read_conversation_ai_program_from_hq','command_conversation_ai_program'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%conversation_ai%' OR p.proname LIKE '%school_ai_%') AND p.proname NOT LIKE '%conversation_ai_test%'");
 assert.equal(fns.length,19,fns.map(f=>f.proname).join());
 for(const f of fns){
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry.includes(f.proname),'runtime '+f.proname);
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[workerUrl.username,f.oid]))[0].ok,false,'worker '+f.proname);
 }
 await assert.rejects(restricted.query("SELECT hon.school_ai_knowledge($1,$2)",[K(),K()]),/permission denied/);
 await assert.rejects(restricted.query("SELECT * FROM hon.school_ai_training_items"),/permission denied/);
 assert.deepEqual((await q('SELECT status,version FROM hon.conversation_ai_program'))[0],{status:'OFF',version:1});
 pass('forced deny-all RLS on all five tables, no table privilege; the runtime executes exactly nine entry points and the worker none; the program starts OFF');

 const module=await Test.createTestingModule({controllers:[AC.ConversationAiController],providers:[ConversationAiService,AC.ConversationAiReadGuard,AC.ConversationAiKnowledgeGuard,AC.ConversationAiFileGuard,AC.ConversationAiSettingsGuard,AC.ConversationAiUploadGuard,AC.ConversationAiItemSaveGuard,AC.ConversationAiItemStatusGuard,AC.ConversationAiTestReadGuard,AC.ConversationAiTestAskGuard,{provide:ConversationAiTestService,useValue:{}},HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false,bodyParser:false});app.use(json({limit:'2mb',strict:true}));app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const x of [a,b]){await setAccess(x,'ACTIVE');
  assert.equal((await q("SELECT count(*) n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.code='OWNER' AND r.is_system_role AND rp.permission_code='conversation.ai.configure'",[x.org]))[0].n,'1');}
 const reader=await staff(a,'reader',['conversation.read']),nobody=await staff(a,'nobody',['crm.lead.read']),configNoRead=await staff(a,'confonly',['conversation.ai.configure']);

 // 2. Defaults and who may do what.
 let o=await overview(a);
 assert.deepEqual([o.program,o.canConfigure,o.items.length,o.settings.enabled,o.settings.version,o.settings.modes,o.settings.handoffWords,o.settings.smsMaxChars,o.settings.chatMaxChars,o.settings.languages],
  ['OFF',true,0,false,0,{SMS:'OFF',WEB_CHAT:'OFF',EMAIL:'OFF'},['human','manager','cancel','refund','billing'],500,900,['en']]);
 o=await overview(reader);assert.equal(o.canConfigure,false);
 refused(await setSettings(reader,settingsBody(0)),403,'CONVERSATION_AI_FORBIDDEN');
 refused(await knowledge(reader),403,'CONVERSATION_AI_FORBIDDEN');
 refused(await saveItem(reader,{kind:'FAQ',title:'Price',question:'How much?',body:'Ask us.'}),403);
 refused(await send(base(nobody),{identity:nobody}),403,'CONVERSATION_AI_FORBIDDEN');
 refused(await send(base(configNoRead),{identity:configNoRead}),403,'CONVERSATION_AI_FORBIDDEN');
 refused(await send(base(b),{identity:a}),403,'CONVERSATION_AI_FORBIDDEN');
 refused(await post(a,'settings',C.CONVERSATION_AI_ITEM_SAVE_COMMAND,settingsBody(0)),403);
 refused(await send(base(a),{identity:a,headers:{'sec-fetch-site':'cross-site'}}),403);
 refused(await send(base(a)+'?x=1',{identity:a}),400);
 pass('defaults read as off with five hand-off words; readers see but cannot change or preview; no conversation.read, another school, a wrong command or a cross-site call is refused');

 // 3. Settings: create by version 0, replay, key reuse, version conflict, validation, enabling records who and when, audit + ids-only outbox.
 const k1=K();let r=await setSettings(a,settingsBody(0),{key:k1});let s=C.verifyConversationAiSettingsReceipt(ok(r)).settings;
 assert.deepEqual([s.version,s.enabled,s.modes.WEB_CHAT,s.enabledBy,s.languages],[1,true,'AUTOMATIC','Synthetic alpha',['en','ko']]);assert(s.enabledAt);
 r=await setSettings(a,settingsBody(0),{key:k1});assert.equal(r.status,200);assert.equal(r.body.meta.replayed,true);assert.deepEqual(r.body.data.settings,s);
 refused(await setSettings(a,settingsBody(0,{smsMaxChars:600}),{key:k1}),409,'IDEMPOTENCY_KEY_REUSED');
 refused(await setSettings(a,settingsBody(0)),409,'CONVERSATION_VERSION_CONFLICT');
 for(const bad of [{handoffWords:['Human']},{handoffWords:['a','a']},{handoffWords:Array.from({length:21},(_,i)=>'w'+i)},{languages:['fr']},{languages:[]},{smsMaxChars:100},
  {chatMaxChars:2000},{afterHoursText:' '},{afterHoursText:'x'.repeat(321)},{modes:{SMS:'ON',WEB_CHAT:'OFF',EMAIL:'OFF'}},{modes:{SMS:'OFF',WEB_CHAT:'OFF'}},{extra:1}])
  refused(await setSettings(a,settingsBody(1,bad)),400,'VALIDATION_FAILED');
 // The database refuses what the contract would, even past the API.
 await assert.rejects(admin.query("UPDATE hon.school_conversation_ai_settings SET handoff_words=ARRAY['Bad Word'],version=version+1 WHERE school_id=$1",[a.school]),/check/);
 const enabledAt=s.enabledAt;
 s=C.verifyConversationAiSettingsReceipt(ok(await setSettings(a,settingsBody(1,{smsMaxChars:320})))).settings;
 assert.deepEqual([s.version,s.smsMaxChars,s.enabledAt],[2,320,enabledAt],'staying on keeps who turned it on and when');
 s=C.verifyConversationAiSettingsReceipt(ok(await setSettings(a,settingsBody(2,{enabled:false,afterHoursText:null})))).settings;
 assert.deepEqual([s.enabled,s.enabledAt,s.enabledBy,s.afterHoursText],[false,null,null,null]);
 const audits=await q("SELECT action_code,source,actor_principal_id FROM hon.audit_events WHERE school_id=$1 AND action_code='conversation.ai.settings.update' ORDER BY occurred_at",[a.school]);
 assert.equal(audits.length,3);assert(audits.every(x=>x.source==='HUMAN_UI'&&x.actor_principal_id===a.principal));
 const ev=await q("SELECT payload FROM hon.outbox_events WHERE school_id=$1 AND event_type='conversation.ai.settings.updated'",[a.school]);
 assert.equal(ev.length,3);assert(ev.every(e=>Object.keys(e.payload).sort().join()==='id,version'));
 assert.equal((await overview(b)).settings.version,0,'another school is untouched');
 pass('settings: version 0 creates, an exact replay returns the stored receipt, a reused key or stale version is refused, bad words/languages/caps/text refused (also by the table), enabling records who and when, audited with ids-only events');

 // 4. Training library: FAQ, coaching with a staff note, instruction; edits by version keep the kind; on/off switch; soft delete is final.
 const faq=C.verifyConversationAiItemReceipt(ok(await saveItem(a,{kind:'FAQ',title:'Trial class',question:'Do you offer a free trial?',body:'Yes. Your first class is free; book it online.'}))).item;
 const coach=C.verifyConversationAiItemReceipt(ok(await saveItem(a,{kind:'COACHING',title:'Price question',question:'How much is it?',body:'Prices depend on the program. I can book a free trial so a coach can go over options.',staffNote:'Never quote prices by text.'}))).item;
 const instr=C.verifyConversationAiItemReceipt(ok(await saveItem(a,{kind:'INSTRUCTION',title:'Tone',body:'Be warm and brief. Offer a trial class.',summary:'Warm, brief, offer a trial.'}))).item;
 assert.deepEqual([faq.status,faq.version,coach.staffNote,instr.summary],['ACTIVE',1,'Never quote prices by text.','Warm, brief, offer a trial.']);
 for(const bad of [{kind:'FAQ',title:'No question',body:'x'},{kind:'INSTRUCTION',title:'Has question',question:'q',body:'x'},{kind:'FAQ',title:'Note',question:'q',body:'x',staffNote:'n'},
  {kind:'INSTRUCTION',title:'File',body:'x',fileId:K()},{kind:'QUIZ',title:'t',body:'x'},{kind:'FAQ',title:' padded',question:'q',body:'x'},{kind:'FAQ',title:'Long',question:'q',body:'x'.repeat(8001)},
  {kind:'FAQ',title:'Version only',question:'q',body:'x',expectedVersion:1}])
  refused(await saveItem(a,bad),400,'VALIDATION_FAILED');
 const faq2=C.verifyConversationAiItemReceipt(ok(await saveItem(a,{itemId:faq.itemId,expectedVersion:1,kind:'FAQ',title:'Trial class',question:'Do you offer a free trial?',body:'Yes. The first class is free for new students.'}))).item;
 assert.deepEqual([faq2.version,faq2.body],[2,'Yes. The first class is free for new students.']);
 refused(await saveItem(a,{itemId:faq.itemId,expectedVersion:1,kind:'FAQ',title:'t',question:'q',body:'x'}),409,'CONVERSATION_VERSION_CONFLICT');
 refused(await saveItem(a,{itemId:faq.itemId,expectedVersion:2,kind:'COACHING',title:'t',question:'q',body:'x'}),400,'VALIDATION_FAILED');
 refused(await saveItem(b,{itemId:faq.itemId,expectedVersion:2,kind:'FAQ',title:'t',question:'q',body:'x'}),404,'CONVERSATION_AI_ITEM_NOT_FOUND');
 let st=C.verifyConversationAiItemReceipt(ok(await itemStatus(a,{itemId:coach.itemId,expectedVersion:1,status:'PAUSED'})),{itemId:coach.itemId,status:'PAUSED'}).item;
 assert.equal(st.version,2);
 st=C.verifyConversationAiItemReceipt(ok(await itemStatus(a,{itemId:coach.itemId,expectedVersion:2,status:'ACTIVE'}))).item;assert.equal(st.status,'ACTIVE');
 st=C.verifyConversationAiItemReceipt(ok(await itemStatus(a,{itemId:instr.itemId,expectedVersion:1,status:'DELETED'}))).item;assert.deepEqual(st,{itemId:instr.itemId,status:'DELETED',version:2});
 refused(await itemStatus(a,{itemId:instr.itemId,expectedVersion:2,status:'ACTIVE'}),404,'CONVERSATION_AI_ITEM_NOT_FOUND');
 refused(await saveItem(a,{itemId:instr.itemId,expectedVersion:2,kind:'INSTRUCTION',title:'Tone',body:'x'}),404);
 await assert.rejects(admin.query("UPDATE hon.school_ai_training_items SET status='ACTIVE',version=version+1 WHERE id=$1",[instr.itemId]),/deleted item stays deleted/);
 await assert.rejects(admin.query("DELETE FROM hon.school_ai_training_items WHERE id=$1",[faq.itemId]),/never deleted/);
 o=await overview(a);assert.deepEqual(o.items.map(i=>i.itemId).sort(),[faq.itemId,coach.itemId].sort(),'deleted items leave the library');
 assert.equal((await q("SELECT count(*) n FROM hon.audit_events WHERE school_id=$1 AND action_code LIKE 'conversation.ai.item.%'",[a.school]))[0].n,'7');
 pass('library: FAQ, coaching with a staff note and instructions; shape rules enforced; edits by version keep the kind; another school cannot touch them; pause/resume; delete is final and immutable underneath');

 // 5. Files: text extraction, image magic bytes, mismatch, de-duplication, original download, 1 MB cap, another school.
 const csv='Day,Time,Class\nMon,17:00,Little Tigers\nMon,18:00,Teens\n';
 let up=C.verifyConversationAiUploadReceipt(ok(await upload(a,{fileName:'schedule.csv',mediaType:'text/csv',contentBase64:b64(csv)}),201));
 assert.equal(up.extractedText,csv.trim());assert.equal(up.file.byteSize,Buffer.byteLength(csv));
 const again=C.verifyConversationAiUploadReceipt(ok(await upload(a,{fileName:'copy.csv',mediaType:'text/csv',contentBase64:b64(csv)}),201));
 assert.equal(again.file.fileId,up.file.fileId,'the same content is kept once per school');
 const img=C.verifyConversationAiUploadReceipt(ok(await upload(a,{fileName:'schedule.png',mediaType:'image/png',contentBase64:PNG.toString('base64')}),201));
 assert.equal(img.extractedText,null);
 refused(await upload(a,{fileName:'fake.png',mediaType:'image/png',contentBase64:b64('not a png at all')}),422,'CONVERSATION_AI_FILE_TYPE_MISMATCH');
 refused(await upload(a,{fileName:'fake.pdf',mediaType:'application/pdf',contentBase64:b64('hello')}),422,'CONVERSATION_AI_FILE_TYPE_MISMATCH');
 refused(await upload(a,{fileName:'bad.txt',mediaType:'text/plain',contentBase64:Buffer.from([0xff,0xfe,0xfd,0x41]).toString('base64')}),422,'CONVERSATION_AI_FILE_TYPE_MISMATCH');
 refused(await upload(a,{fileName:'x.exe',mediaType:'application/x-msdownload',contentBase64:b64('MZ..')}),400);
 refused(await upload(a,{fileName:'../etc.txt',mediaType:'text/plain',contentBase64:b64('hi there')}),400);
 const big=Buffer.alloc(1_048_577,0x41).toString('base64');
 refused(await upload(a,{fileName:'big.txt',mediaType:'text/plain',contentBase64:big}),400);
 refused(await upload(reader,{fileName:'s.csv',mediaType:'text/csv',contentBase64:b64(csv)}),403);
 const doc=C.verifyConversationAiItemReceipt(ok(await saveItem(a,{kind:'IMAGE',title:'Class schedule photo',body:'Mon 5pm Little Tigers; Mon 6pm Teens.',fileId:img.file.fileId}))).item;
 assert.deepEqual(doc.file,img.file);
 refused(await saveItem(b,{kind:'IMAGE',title:'Stolen',body:'x',fileId:img.file.fileId}),404,'CONVERSATION_AI_ITEM_NOT_FOUND');
 const original=C.verifyConversationAiFileContent(ok(await readFile(a,img.file.fileId)),img.file.fileId);
 assert(Buffer.from(original.contentBase64,'base64').equals(PNG));
 refused(await readFile(b,img.file.fileId),404);refused(await readFile(reader,img.file.fileId),403);refused(await readFile(a,'not-a-uuid'),400);
 await assert.rejects(admin.query("UPDATE hon.school_ai_training_files SET file_name='renamed.png' WHERE id=$1",[img.file.fileId]));
 pass('files: text and CSV extracted for checking, images kept without text, content must match its type, one copy per school, originals download exactly, 1 MB cap, other schools and readers refused, files immutable');

 // 6. Knowledge pack: only ACTIVE training, approved parent-safe articles, this school only; library cap.
 await q("INSERT INTO hon.knowledge_articles(organization_id,school_id,title,body,audience,lifecycle,effective_from,version,created_by_principal_id,approved_by_principal_id,approved_at) VALUES($1,$2,'Belt testing','Testing is every 8 weeks.','PARENT_SAFE','APPROVED',now()-interval '1 day',1,$3,$4,now()),($1,$2,'Staff pay','Internal only.','STAFF','APPROVED',now()-interval '1 day',1,$3,$4,now())",[a.org,a.school,a.principal,reader.principal]);
 C.verifyConversationAiItemReceipt(ok(await itemStatus(a,{itemId:coach.itemId,expectedVersion:3,status:'PAUSED'})));
 await saveItem(b,{kind:'FAQ',title:'Other school',question:'Where?',body:'Elsewhere.'});
 const kn=C.verifyConversationAiKnowledge(ok(await knowledge(a)));
 assert.equal(kn.school.name,'Synthetic alpha Dojo');assert.deepEqual(kn.languages,['en','ko']);
 assert.deepEqual(kn.faqs.map(f=>f.source),['TRAINING:'+faq.itemId],'paused coaching and other schools are left out');
 assert.deepEqual(kn.instructions,[],'deleted instructions are left out');
 assert.deepEqual(kn.documents.map(d=>d.source),['TRAINING:'+doc.itemId]);
 assert.deepEqual(kn.articles.map(x=>x.title),['Belt testing'],'only approved parent-safe articles');
 assert(JSON.stringify(kn).indexOf('Never quote prices')<0,'staff notes never reach the knowledge pack');
 await q("INSERT INTO hon.school_ai_training_items(organization_id,school_id,kind,title,body,created_by_principal_id,updated_by_principal_id) SELECT $1,$2,'INSTRUCTION','Filler '||g,'Filler text',$3,$3 FROM generate_series(1,197) g",[a.org,a.school,a.principal]);
 refused(await saveItem(a,{kind:'INSTRUCTION',title:'One too many',body:'x'}),422,'CONVERSATION_AI_LIBRARY_FULL');
 assert.equal((await overview(a)).items.length,200);
 pass('knowledge preview holds only active training, approved parent-safe articles and this school\'s facts, never staff notes; the library stops at 200 items');

 // 7. HQ program switch: HQ readers read; only a human HQ owner changes it, with a reason, by version, idempotently; the change log is immutable.
 const hqOwner=await hqPerson('owner','HON_HQ_OWNER'),hqOperator=await hqPerson('operator','HON_HQ_OPERATOR'),outsider=await hqPerson('outsider',null);
 let pr=await program(hqOwner.externalSubject);assert.deepEqual([pr.status,pr.version,pr.recentChanges.length],['OFF',1,0]);assert.equal(pr.schoolsEnabled,0);
 assert.equal((await program(hqOperator.externalSubject)).status,'OFF');
 await assert.rejects(program(outsider.externalSubject),/SAAS_FORBIDDEN/);
 await assert.rejects(program(a.externalSubject),/SAAS_FORBIDDEN/,'a school owner is not HQ');
 await assert.rejects(switchProgram(hqOperator.externalSubject,{status:'TEST_MODE',expectedVersion:1,reason:'Internal testing begins'}),/SAAS_FORBIDDEN/);
 await assert.rejects(switchProgram(hqOwner.externalSubject,{status:'TEST_MODE',expectedVersion:1,reason:'short'}),/INVALID_CONVERSATION_AI_PROGRAM/);
 await assert.rejects(switchProgram(hqOwner.externalSubject,{status:'ON',expectedVersion:1,reason:'Internal testing begins'}),/INVALID_CONVERSATION_AI_PROGRAM/);
 await assert.rejects(switchProgram(hqOwner.externalSubject,{status:'OFF',expectedVersion:1,reason:'Internal testing begins'}),/CONVERSATION_AI_PROGRAM_UNCHANGED/);
 const pk=K();
 let rc=await switchProgram(hqOwner.externalSubject,{status:'TEST_MODE',expectedVersion:1,reason:'Internal testing begins'},pk);assert.deepEqual([rc.status,rc.version,rc.replayed],['TEST_MODE',2,false]);
 rc=await switchProgram(hqOwner.externalSubject,{status:'TEST_MODE',expectedVersion:1,reason:'Internal testing begins'},pk);assert.deepEqual([rc.status,rc.version,rc.replayed],['TEST_MODE',2,true]);
 await assert.rejects(switchProgram(hqOwner.externalSubject,{status:'LIVE',expectedVersion:1,reason:'Internal testing begins'},pk),/KEY_REUSED/);
 await assert.rejects(switchProgram(hqOwner.externalSubject,{status:'LIVE',expectedVersion:1,reason:'Going live for everyone'}),/SAAS_VERSION_CONFLICT/);
 // A school session can never reach the HQ switch (no school context may be present).
 await assert.rejects((async()=>{await restricted.query('BEGIN');try{await restricted.query("SELECT set_config('app.hon_school_id',$1,true)",[a.school]);
  await restricted.query('SELECT hon.command_conversation_ai_program($1,$2::jsonb,$3::uuid)',[hqOwner.externalSubject,JSON.stringify({status:'OFF',expectedVersion:2,reason:'Turn it back off'}),K()]);}finally{await restricted.query('ROLLBACK');}})(),/SAAS_FORBIDDEN/);
 await q("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1",[hqOwner.principal]);
 await assert.rejects(switchProgram(hqOwner.externalSubject,{status:'OFF',expectedVersion:2,reason:'Turn it back off'}),/SAAS_FORBIDDEN/,'an ended HQ grant is refused');
 pr=await program(hqOperator.externalSubject);
 assert.deepEqual([pr.status,pr.version,pr.updatedBy,pr.recentChanges.length],['TEST_MODE',2,'HQ owner',1]);
 assert.deepEqual([pr.recentChanges[0].from,pr.recentChanges[0].to,pr.recentChanges[0].reason,pr.recentChanges[0].changedBy],['OFF','TEST_MODE','Internal testing begins','HQ owner']);
 await assert.rejects(admin.query('UPDATE hon.conversation_ai_program_changes SET reason=$1',['rewritten history']),/IMMUTABLE/);
 await assert.rejects(admin.query('DELETE FROM hon.conversation_ai_program_changes'),/IMMUTABLE/);
 assert.equal((await overview(a)).program,'TEST_MODE','schools see the program state');
 pass('HQ switch: HQ readers read, only a live human HQ owner changes it with a reason and the current version, replays are exact, school context and ended grants are refused, the change log is the immutable audit');

 // 8. Authority re-proved after the writes: a role ended mid-transaction rolls back the command.
 const before=(await q('SELECT count(*) n FROM hon.school_ai_training_items WHERE school_id=$1',[b.school]))[0].n;
 const lapsedB=await staff(b,'lapsingb',['conversation.read','conversation.ai.configure']);
 await q(`CREATE OR REPLACE FUNCTION hon.zz_convai_revoke() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  BEGIN UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE principal_id='${lapsedB.principal}'::uuid; RETURN NEW; END $$`);
 await q(`CREATE TRIGGER zz_convai_revoke AFTER INSERT ON hon.school_ai_training_items FOR EACH ROW WHEN (NEW.title='Revoke me') EXECUTE FUNCTION hon.zz_convai_revoke()`);
 refused(await saveItem(lapsedB,{kind:'INSTRUCTION',title:'Revoke me',body:'x'}),403,'CONVERSATION_AI_FORBIDDEN');
 assert.equal((await q('SELECT count(*) n FROM hon.school_ai_training_items WHERE school_id=$1',[b.school]))[0].n,before,'nothing was kept');
 await q('DROP TRIGGER zz_convai_revoke ON hon.school_ai_training_items');await q('DROP FUNCTION hon.zz_convai_revoke()');
 pass('authority is decided again after the writes: a role that ends during the command leaves nothing behind');
 // 9. The canonical 011 exact verification section passes with the fixture's roles and catches drift.
 {const verify=await readText(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Conversation AI training exact verification (0420)')[1]?.split('-- End conversation AI training exact verification.')[0];
  assert(section,'011 section');
  const body=section.replace(/^[^\n]*\n[^\n]*\n/,'').replaceAll('hon_runtime',runtime.username);
  await q(body);
  await q(`GRANT EXECUTE ON FUNCTION hon.school_ai_knowledge(uuid,uuid) TO ${runtime.username}`);
  await assert.rejects(q(body),/Unsafe conversation AI function: hon.school_ai_knowledge/);
  await q(`REVOKE EXECUTE ON FUNCTION hon.school_ai_knowledge(uuid,uuid) FROM ${runtime.username}`);
  await q(`GRANT EXECUTE ON FUNCTION hon.command_conversation_ai_program(text,jsonb,uuid) TO ${workerUrl.username}`);
  await assert.rejects(q(body),/Unsafe conversation AI function: hon.command_conversation_ai_program/);
  await q(`REVOKE EXECUTE ON FUNCTION hon.command_conversation_ai_program(text,jsonb,uuid) FROM ${workerUrl.username}`);
  await q(`GRANT SELECT ON hon.school_ai_training_files TO ${runtime.username}`);
  await assert.rejects(q(body),/Unsafe conversation AI table: school_ai_training_files/);
  await q(`REVOKE SELECT ON hon.school_ai_training_files FROM ${runtime.username}`);
  await q(body);}
 pass('the canonical 011 verification of the 0420 functions, ACLs and tables passes and refuses an extra runtime or worker grant or a table privilege');
 console.log('PASS conversation AI training proof: '+groups+' groups');
}finally{
 if(app)await app.close();else await database.onModuleDestroy?.();
 await Promise.allSettled([admin.end(),restricted.end(),worker.end()]);
}
