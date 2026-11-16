/** 0390 contact photos. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import {readFileSync} from 'node:fs';
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
const {SchoolPersonPhotoService}=require('./dist/people/school-person-photo.service.js');
const {SchoolPersonPhotoController,SchoolPersonPhotoHumanGuard}=require('./dist/people/school-person-photo.controller.js');
const {PERSON_PHOTO_HUMAN_COMMAND}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'person-photo-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS PERSON-PHOTO '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const sha=b=>createHash('sha256').update(b).digest('hex');
const person=label=>({externalSubject:'oidc:photo:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function send(path,{identity,body,key=K(),method='POST',command=PERSON_PHOTO_HUMAN_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,...(key?{'idempotency-key':key}:{})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const tables=['person_photos','person_photo_requests','audit_events','outbox_events'];
const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
async function denied(work,status,code){
 const before=await counts();const r=await work();
 assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));
 assert.deepEqual(await counts(),before);assert(!('data' in r.body));
 assert.equal(r.headers['cache-control'],'private, no-store');assert(!JSON.stringify(r.body).match(/SQLSTATE|SELECT |external_subject|hon\./));return r;
}
async function human(identity,label,active=true){
 const user=K(),principal=K();
 await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[user,identity.externalSubject,identity.email,label]);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,$4)",[principal,user,label,active]);
 return principal;
}
async function customRole(o,code,perms){
 const id=(await q("INSERT INTO hon.roles(organization_id,management_school_id,code,name) VALUES($1,$2,$3,$4) RETURNING id",[o.organizationId,o.schoolId,code,code.replace('CUSTOM_','')]))[0].id;
 for(const p of perms)await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[id,o.organizationId,p]);
 return id;
}
const grant=async(o,principal,role)=>(await q('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval \'1 minute\') RETURNING id',[o.organizationId,o.schoolId,principal,role]))[0].id;
const addPerson=async(o,given,family)=>(await q('INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4) RETURNING id',[o.organizationId,o.schoolId,given,family]))[0].id;
const read=(identity,schoolId,personId)=>send('school/schools/'+schoolId+'/people/'+personId+'/photo',{identity,method:'GET'});
const setPhoto=(identity,b,o={})=>send('school/people/photo',{identity,body:b,...o});
const removePhoto=(identity,b,o={})=>send('school/people/photo/remove',{identity,body:b,...o});

// Synthetic test images only: the API fixture JPEG, the same JPEG with EXIF/GPS added, a PNG sample.
const JPEG=readFileSync(new URL('../../../apps/api/test/fixtures/paper-page.jpg',import.meta.url));
const PNG=readFileSync(new URL('../../../apps/web/public/paper-import-samples/student-card.png',import.meta.url));
const exif=Buffer.concat([Buffer.from([0xff,0xe1,0x00,0x1e]),Buffer.from('Exif\0\0GPS 34.05N 118.24W cam','latin1')]);
const DIRTY=Buffer.concat([JPEG.subarray(0,2),exif,JPEG.subarray(2)]);
const CLEAN_JPEG=JPEG.subarray(0,JPEG.lastIndexOf(Buffer.from([0xff,0xd9]))+2);
const body=(schoolId,personId,expectedVersion,bytes=JPEG,mediaType='image/jpeg')=>({schoolId,personId,expectedVersion,mediaType,data:bytes.toString('base64')});

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL: no table privilege; exactly three definer entry points; helpers private.
 for(const t of ['person_photos','person_photo_requests'])for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])
  assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+' '+p);
 for(const t of ['person_photos','person_photo_requests'])assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid=('hon.'||$1)::regclass",[t]))[0],{r:true,f:true,n:0});
 const fns=await q("SELECT p.oid,p.proname,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%person_photo%')");
 const entries=['read_person_photo','set_person_photo','remove_person_photo'];
 assert.deepEqual(fns.map(f=>f.proname).sort(),['guard_person_photo','person_photo_begin','person_photo_finish','person_photo_summary','read_person_photo','remove_person_photo','set_person_photo']);
 for(const f of fns){const entry=entries.includes(f.proname);
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry,f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.person_photos'),e=>e.code==='42501');
 pass('photos and receipts are forced-RLS private tables; the runtime executes only the read, set and remove');

 // Fixture: two HQ-provisioned schools with paid access; editor, reader, update-only, outsider, parent, other school.
 const hq={subject:'photo-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Photo synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Photo synthetic','Photo synthetic','Photo school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'photo-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const editRole=await customRole(A,'CUSTOM_PHOTO_EDIT',['school.view','people.read','people.update']);
 const editor=person('editor'),editorPrincipal=await human(editor,'Editor');const editorGrant=await grant(A,editorPrincipal,editRole);
 const editor2=person('editor-2');await grant(A,await human(editor2,'Editor 2'),editRole);
 const reader=person('reader');await grant(A,await human(reader,'Reader'),await customRole(A,'CUSTOM_PHOTO_READ',['school.view','people.read']));
 const updateOnly=person('update-only');await grant(A,await human(updateOnly,'Update only'),await customRole(A,'CUSTOM_PHOTO_UPDATE',['school.view','people.update']));
 const editorB=person('editor-b');await grant(B,await human(editorB,'Editor B'),await customRole(B,'CUSTOM_PHOTO_EDIT',['school.view','people.read','people.update']));
 const outsider=person('outsider');await human(outsider,'Outsider');
 const kid=await addPerson(A,'Mina','Park'),other=await addPerson(A,'Leo','Park'),personB=await addPerson(B,'Other','School');
 const module=await Test.createTestingModule({controllers:[SchoolPersonPhotoController],providers:[SchoolPersonPhotoService,SchoolPersonPhotoHumanGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;

 // 2. No photo yet: the exact read shape.
 assert.deepEqual(ok(await read(reader,A.schoolId,kid)),{personId:kid,photo:null});
 pass('a person without a photo reads as photo null for people.read');

 // 3. Authority and scope: nothing written on any refusal.
 for(const who of [outsider,updateOnly])await denied(()=>read(who,A.schoolId,kid),403,'PERSON_PHOTO_FORBIDDEN');
 await denied(()=>read(editorB,A.schoolId,kid),403,'PERSON_PHOTO_FORBIDDEN');
 await denied(()=>read(editorB,B.schoolId,kid),404,'PERSON_PHOTO_NOT_FOUND');
 for(const who of [outsider,updateOnly,reader])await denied(()=>setPhoto(who,body(A.schoolId,kid,null)),403,'PERSON_PHOTO_FORBIDDEN');
 await denied(()=>setPhoto(editorB,body(B.schoolId,kid,null)),404,'PERSON_PHOTO_NOT_FOUND');
 await denied(()=>setPhoto(editor,body(A.schoolId,personB,null)),404,'PERSON_PHOTO_NOT_FOUND');
 await denied(()=>setPhoto(editor,body(A.schoolId,kid,null),{command:'school-person-record'}),403,'HUMAN_UI_REQUIRED');
 await denied(()=>setPhoto(editor,body(A.schoolId,kid,null),{headers:{'x-hon-source':'AI_AGENT'}}),403,'HUMAN_UI_REQUIRED');
 await denied(()=>setPhoto(editor,body(A.schoolId,kid,null),{key:null}),400,'PERSON_PHOTO_INVALID');
 await denied(()=>setPhoto(editor,{...body(A.schoolId,kid,null),extra:1}),400,'PERSON_PHOTO_INVALID');
 await denied(()=>setPhoto(editor,body(A.schoolId,kid,null,JPEG,'image/png')),400,'PERSON_PHOTO_IMAGE_REFUSED');
 await denied(()=>setPhoto(editor,body(A.schoolId,kid,null,Buffer.from('%PDF-1.7 not an image'))),400,'PERSON_PHOTO_IMAGE_REFUSED');
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
 await denied(()=>setPhoto(editor,body(A.schoolId,kid,null)),403,'PERSON_PHOTO_FORBIDDEN');
 await denied(()=>read(editor,A.schoolId,kid),403,'PERSON_PHOTO_FORBIDDEN');
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[A.organizationId]);
 pass('people.read to see, people.read + people.update to change, exact school, paid access, human transport; refusals write nothing');

 // 4. First photo: EXIF stripped by the API, exact replay, key reuse refused.
 const key=K(),c0=await counts();
 const first=ok(await setPhoto(editor,body(A.schoolId,kid,null,DIRTY),{key}));
 assert.equal(first.photo.version,1);assert.equal(first.replaced,false);assert.equal(first.replayed,false);assert.equal(first.photo.checksum,sha(CLEAN_JPEG));
 const stored=(await q('SELECT content,checksum,media_type,organization_id,school_id FROM hon.person_photos WHERE person_id=$1',[kid]))[0];
 assert(stored.content.equals(CLEAN_JPEG));assert(!stored.content.includes(Buffer.from('GPS')));assert.equal(stored.school_id,A.schoolId);
 const c1=await counts();for(const t of tables)assert.equal(Number(c1[t]),Number(c0[t])+1,t);
 const audit=(await q("SELECT action_code,next_state FROM hon.audit_events WHERE entity_id=$1 ORDER BY occurred_at DESC LIMIT 1",[kid]))[0];
 assert.equal(audit.action_code,'people.photo.set');assert(!JSON.stringify(audit.next_state).includes(CLEAN_JPEG.toString('base64').slice(0,40)));
 const outbox=(await q("SELECT event_type,payload FROM hon.outbox_events WHERE aggregate_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1",[kid]))[0];
 assert.deepEqual(outbox,{event_type:'people.photo.set',payload:{personId:kid,checksum:sha(CLEAN_JPEG),version:1}});
 const replay=ok(await setPhoto(editor,body(A.schoolId,kid,null,DIRTY),{key}));
 assert.equal(replay.replayed,true);assert.deepEqual({...replay,replayed:false},first);assert.deepEqual(await counts(),c1);
 await denied(()=>setPhoto(editor,body(A.schoolId,kid,null,PNG,'image/png'),{key}),409,'PERSON_PHOTO_KEY_REUSED');
 await denied(()=>setPhoto(editor2,body(A.schoolId,kid,null,PNG,'image/png')),409,'PERSON_PHOTO_VERSION_CONFLICT');
 pass('the first photo is stored without EXIF, audited and announced by id/checksum only, replays exactly and refuses key reuse and a stale first write');

 // 5. Read returns exactly the stored bytes to the same school only.
 const r=ok(await read(reader,A.schoolId,kid));
 assert(Buffer.from(r.photo.data,'base64').equals(CLEAN_JPEG));assert.equal(r.photo.version,1);assert.equal(r.photo.mediaType,'image/jpeg');
 assert.equal(ok(await read(reader,A.schoolId,other)).photo,null);
 pass('the photo comes back exactly, never cached, and another person has none');

 // 6. Replace: version check, version advances.
 await denied(()=>setPhoto(editor,body(A.schoolId,kid,2,PNG,'image/png')),409,'PERSON_PHOTO_VERSION_CONFLICT');
 const second=ok(await setPhoto(editor2,body(A.schoolId,kid,1,PNG,'image/png')));
 assert.equal(second.photo.version,2);assert.equal(second.replaced,true);assert.equal(second.photo.mediaType,'image/png');
 pass('a replacement needs the current version and advances it');

 // 7. The database refuses metadata and unguarded changes itself.
 await admin.query('BEGIN');
 await assert.rejects(()=>admin.query("UPDATE hon.person_photos SET content=$1,checksum=$2,version=version+1 WHERE person_id=$3",[DIRTY,sha(DIRTY),kid]),e=>e.code==='23514');
 await admin.query('ROLLBACK');
 for(const st of ["UPDATE hon.person_photos SET version=version WHERE person_id='"+kid+"'","UPDATE hon.person_photos SET school_id='"+B.schoolId+"',version=version+1 WHERE person_id='"+kid+"'",
  "UPDATE hon.person_photo_requests SET response='{}'::jsonb","DELETE FROM hon.person_photo_requests","TRUNCATE hon.person_photos","TRUNCATE hon.person_photo_requests"]){
  await admin.query('BEGIN');await assert.rejects(()=>admin.query(st),e=>['42501','23503','23514'].includes(e.code),st);await admin.query('ROLLBACK');}
 pass('the table refuses an image with metadata, a checksum mismatch and identity, version or receipt changes even for the owner');

 // 8. Remove: hard delete, announced, version-checked; re-adding starts again at version 1.
 await denied(()=>removePhoto(editor,{schoolId:A.schoolId,personId:kid,expectedVersion:1}),409,'PERSON_PHOTO_VERSION_CONFLICT');
 await denied(()=>removePhoto(reader,{schoolId:A.schoolId,personId:kid,expectedVersion:2}),403,'PERSON_PHOTO_FORBIDDEN');
 const rk=K(),removed=ok(await removePhoto(editor,{schoolId:A.schoolId,personId:kid,expectedVersion:2},{key:rk}));
 assert.deepEqual(removed,{personId:kid,removed:true,replayed:false});
 assert.equal((await q('SELECT count(*)::int n FROM hon.person_photos WHERE person_id=$1',[kid]))[0].n,0);
 assert.deepEqual((await q("SELECT event_type,payload FROM hon.outbox_events WHERE aggregate_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1",[kid]))[0],{event_type:'people.photo.removed',payload:{personId:kid,checksum:second.photo.checksum,version:2}});
 assert.equal(ok(await removePhoto(editor,{schoolId:A.schoolId,personId:kid,expectedVersion:2},{key:rk})).replayed,true);
 await denied(()=>removePhoto(editor,{schoolId:A.schoolId,personId:kid,expectedVersion:2}),409,'PERSON_PHOTO_VERSION_CONFLICT');
 assert.equal(ok(await read(reader,A.schoolId,kid)).photo,null);
 assert.equal(ok(await setPhoto(editor,body(A.schoolId,kid,null))).photo.version,1);
 pass('remove deletes the bytes (hard delete), is announced, replays exactly, and a new photo starts at version 1');

 // 9. Authority is decided again after the last write: a grant revoked while the command waits commits nothing.
 {const blocker=new pg.Client({connectionString:owner.toString(),ssl:false});await blocker.connect();
  try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['person-photo:'+other]);
   const c=await counts();const pending=setPhoto(editor,body(A.schoolId,other,null));
   for(let i=0;i<300;i++){if((await q("SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND NOT granted"))[0].n!=='0')break;await new Promise(r=>setTimeout(r,10));}
   await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[editorGrant]);
   await blocker.query('ROLLBACK');const res=await pending;assert.equal(res.status,403,JSON.stringify(res.body));
   const after=await counts();assert.equal(after.person_photos,c.person_photos);assert.equal(after.audit_events,c.audit_events);}
  finally{await blocker.end();}}
 pass('a grant revoked while the command waited commits nothing');
 console.log('Contact photo proof (0390): '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end()]);
}
