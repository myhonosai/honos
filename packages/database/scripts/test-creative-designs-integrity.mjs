/** Creative Studio designs (0617, design editor D1): real signed HON sessions -> Nest/guards -> the six runtime entry points, on
 *  the marked disposable communication delivery database. Schools are SYNTHETIC sign-ups made through the 0241 runtime entry
 *  point. Designs are drawings only: nothing is sent, published, printed, charged or called outside the design tables, their
 *  audit and outbox. */
import assert from 'node:assert/strict';
import {randomUUID as K,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import zlib from 'node:zlib';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??''),workerUrl=new URL(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_comm_delivery_owner'],[runtime,'hon_comm_delivery_runtime'],[workerUrl,'hon_comm_delivery_worker']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_comm_delivery_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|SENDGRID.*|ZERNIO.*|OPENAI.*|OPENROUTER.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HIGGSFIELD.*|HEYGEN.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|ZERNIO|EMAIL|CREATIVE).*)$/i.test(key),key);
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {ValidationPipe}=require('@nestjs/common');
const {json}=require('express');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const DC=require('./dist/creative-studio/creative-designs.controller.js');
const {CreativeDesignsService}=require('./dist/creative-studio/creative-designs.service.js');
const C=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),worker=new pg.Client({connectionString:workerUrl.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'creative-designs-disposable',secret:createHash('sha256').update(K()).digest('hex')};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret,HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
const pass=name=>console.log('PASS CREATIVE DESIGNS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
async function send(path,{identity,method='GET',body,command,key,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,{...session,emitVerifiedEmail:true},Math.floor(Date.now()/1000)):undefined;
 const text=body===undefined?undefined:JSON.stringify(body);
 command??=method==='GET'?C.CREATIVE_DESIGNS_READ_COMMAND:path.endsWith('/status')?C.CREATIVE_DESIGN_STATUS_COMMAND:path.endsWith('/photos')?C.CREATIVE_DESIGN_PHOTO_COMMAND:C.CREATIVE_DESIGN_SAVE_COMMAND;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',
  'x-hon-human-command':command,...(text?{'content-type':'application/json','content-length':Buffer.byteLength(text)}:{}),...(key?{'idempotency-key':key}:{}),...headers}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(t||'{}'),headers:res.headers}));});req.on('error',reject);if(text)req.write(text);req.end();});
}
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body).slice(0,400));assert.equal(r.headers['cache-control'],'private, no-store');return r.body;};
const human=label=>({externalSubject:'oidc:design:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
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
const base=x=>`organizations/${x.org}/schools/${x.school}/creative-studio/designs`;
const list=async(x,params={})=>C.verifyCreativeDesignList(ok(await send(base(x)+(Object.keys(params).length?'?'+new URLSearchParams(params):''),{identity:x})).data,params);
const el={x:36,y:40,w:300,h:60,rotation:0,opacity:1,locked:false};
const title=(o={})=>({id:'title',kind:'text',...el,text:'Summer camp\nAges 6-12 · July',font:'DISPLAY',size:48,bold:true,italic:false,color:'#C8102E',align:'center',lineHeight:1.1,...o});
const doc=(elements=[title()],pages=1)=>({v:1,pages:Array.from({length:pages},(_,i)=>({background:'#FFFFFF',elements:i?[]:elements}))});
const draft=(o={})=>({designId:null,expectedVersion:0,name:'Summer camp flyer',sizeCode:'FLYER_LETTER',document:doc(),...o});
const save=(x,body,key=K())=>send(base(x),{identity:x,method:'POST',body,key});
const setStatus=(x,id,body,key=K())=>send(base(x)+'/'+id+'/status',{identity:x,method:'POST',body,key});
const addPhoto=(x,body,key=K())=>send(base(x)+'/photos',{identity:x,method:'POST',body,key});
const chunk=(type,data)=>{const t=Buffer.from(type,'latin1'),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(zlib.crc32(Buffer.concat([t,data]))>>>0);return Buffer.concat([len,t,data,crc]);};
const png=(extra=[],shade=0)=>Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',Buffer.from('00000001000000010806000000','hex')),...extra,
 chunk('IDAT',zlib.deflateSync(Buffer.from([0,shade,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
const counts=async()=>(await q("SELECT (SELECT count(*) FROM hon.school_creative_designs) d,(SELECT count(*) FROM hon.school_creative_design_photos) p,(SELECT count(*) FROM hon.audit_events WHERE entity_type IN ('CREATIVE_DESIGN','CREATIVE_DESIGN_PHOTO')) a,(SELECT count(*) FROM hon.outbox_events WHERE aggregate_type IN ('CREATIVE_DESIGN','CREATIVE_DESIGN_PHOTO')) o,(SELECT count(*) FROM hon.communication_messages) m"))[0];
const ENTRY=['read_school_creative_designs','read_school_creative_design','read_school_creative_design_photo','save_school_creative_design','set_school_creative_design_status','add_school_creative_design_photo'];
const HELPERS=['creative_design_size','creative_design_name_ok','creative_design_num_ok','creative_design_color_ok','creative_design_document_ok','guard_school_creative_design',
 'guard_school_creative_design_photo','require_creative_design_actor','school_creative_design_summary','school_creative_design_json','school_creative_design_photo_json',
 'creative_design_command_begin','creative_design_room_check','creative_design_command_finish'];

try{
 await Promise.all([admin.connect(),restricted.connect(),worker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable communication delivery validation');
 // 1. Custody.
 {const fns=await q("SELECT p.oid,p.proname FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname=ANY($1)",[[...ENTRY,...HELPERS]]);
  assert.equal(fns.length,20,fns.map(f=>f.proname).join());
  for(const f of fns){
   assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,ENTRY.includes(f.proname),'runtime '+f.proname);
   assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[workerUrl.username,f.oid]))[0].ok,false,'worker '+f.proname);
   assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,'public '+f.proname);
  }
  for(const table of ['hon.school_creative_designs','hon.school_creative_design_photos']){
   for(const priv of ['SELECT','INSERT','UPDATE','DELETE'])for(const role of [runtime.username,workerUrl.username])
    assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[role,table,priv]))[0].ok,false,role+' '+priv+' '+table);
   assert.deepEqual((await q('SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass',[table]))[0],{r:true,f:true});
  }
  await assert.rejects(restricted.query("SELECT hon.require_creative_design_actor('x','creative.design.read')"),/permission denied/);
  await assert.rejects(worker.query("SELECT hon.read_school_creative_designs('x','{}'::jsonb)"),/permission denied/);
  assert.equal((await q("SELECT count(*)::int n FROM hon.permissions WHERE code IN ('creative.design.read','creative.design.manage') AND NOT is_sensitive AND is_staff_assignable"))[0].n,2);}
 {const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const start=verify.indexOf('-- Creative designs exact verification');assert(start>=0,'the 011 section exists');
  const section=verify.slice(start,verify.indexOf('-- End creative designs exact verification',start));
  await admin.query(section.replaceAll('hon_runtime',runtime.username));
  for(const leak of [`GRANT EXECUTE ON FUNCTION hon.creative_design_document_ok(jsonb,text) TO ${runtime.username}`,`GRANT SELECT ON hon.school_creative_design_photos TO ${runtime.username}`]){
   await admin.query('BEGIN');
   try{await admin.query(leak);await assert.rejects(admin.query(section.replaceAll('hon_runtime',runtime.username)),/Unsafe creative design/,leak);}finally{await admin.query('ROLLBACK');}}
  for(const [drift,why] of [["CREATE OR REPLACE FUNCTION hon.creative_design_size(p_code text,OUT width numeric,OUT height numeric,OUT sides integer) LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 1::numeric,1::numeric,1 $$",/function body\/posture drift/],
    ['ALTER TABLE hon.school_creative_design_photos DISABLE TRIGGER guard',/guard missing/],["UPDATE hon.permissions SET is_sensitive=true WHERE code='creative.design.read'",/permissions missing or changed/]]){
   await admin.query('BEGIN');
   try{await admin.query(drift);await assert.rejects(admin.query(section.replaceAll('hon_runtime',runtime.username)),why,drift);}finally{await admin.query('ROLLBACK');}}}
 pass('the runtime executes exactly the six entry points and has no table privilege; fourteen helpers are private; both tables have forced RLS; two staff-assignable permissions; the 011 section passes and catches a leaked helper or table grant, a changed function body, a disabled guard trigger and a changed permission');

 const module=await Test.createTestingModule({controllers:[DC.CreativeDesignsController],providers:[CreativeDesignsService,DC.CreativeDesignsReadGuard,DC.CreativeDesignSaveGuard,DC.CreativeDesignStatusGuard,DC.CreativeDesignPhotoGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false,bodyParser:false});app.use(json({limit:'2mb',strict:true}));app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true}));await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
 terms=(await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
 const a=await register('alpha'),b=await register('beta');
 for(const x of [a,b])await setAccess(x,'ACTIVE');
 assert.equal((await q("SELECT count(*)::int n FROM hon.roles r JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id WHERE r.organization_id=$1 AND r.code='OWNER' AND rp.permission_code IN ('creative.design.read','creative.design.manage')",[a.org]))[0].n,2,'a new school owner gets both permissions');

 // 2. Photos: metadata stripped by the API, refused by the table, private to the school.
 const before=await counts();
 const tagged=png([chunk('tEXt',Buffer.from('Comment\0taken at 12 Main St','latin1'))]);
 let r=ok(await addPhoto(a,{mediaType:'image/png',data:tagged.toString('base64')}));
 const photo=C.verifyCreativeDesignPhotoReceipt({photo:r.data,replayed:r.meta.replayed},{mediaType:'image/png'}).photo;
 const stored=(await q('SELECT content FROM hon.school_creative_design_photos WHERE id=$1',[photo.photoId]))[0].content;
 assert(!stored.includes(Buffer.from('tEXt'))&&!stored.includes(Buffer.from('Main St')),'the metadata chunk is gone');
 assert.equal(photo.bytes,stored.length);assert.equal(photo.checksum,createHash('sha256').update(stored).digest('hex'));
 const read=C.verifyCreativeDesignPhoto(ok(await send(base(a)+'/photos/'+photo.photoId,{identity:a})).data,photo.photoId);
 assert.equal(Buffer.from(read.data,'base64').equals(stored),true,'the stored bytes come back');
 assert.equal((await send(base(b)+'/photos/'+photo.photoId,{identity:b})).body.code,'CREATIVE_DESIGN_PHOTO_NOT_FOUND','another school cannot read it');
 const photoKey=K();r=ok(await addPhoto(a,{mediaType:'image/png',data:png([],9).toString('base64')},photoKey));
 const second=r.data;r=ok(await addPhoto(a,{mediaType:'image/png',data:png([],9).toString('base64')},photoKey));
 assert.deepEqual([r.data.photoId,r.meta.replayed],[second.photoId,true],'exact replay');
 assert.equal((await addPhoto(a,{mediaType:'image/png',data:png([],10).toString('base64')},photoKey)).body.code,'IDEMPOTENCY_KEY_REUSED');
 assert.equal((await addPhoto(a,{mediaType:'image/jpeg',data:png().toString('base64')})).body.code,'CREATIVE_DESIGN_PHOTO_REFUSED','bytes must match the declared type');
 assert.equal((await addPhoto(a,{mediaType:'image/gif',data:png().toString('base64')})).status,400);
 await admin.query('BEGIN');
 try{await assert.rejects(admin.query("INSERT INTO hon.school_creative_design_photos(organization_id,school_id,media_type,content,checksum,created_by_principal_id) VALUES($1,$2,'image/png',$3,encode(sha256($3),'hex'),$4)",[a.org,a.school,tagged,a.principal]),/school_creative_design_photos_clean/,'the table refuses metadata even from the owner');}
 finally{await admin.query('ROLLBACK');}
 for(const sql of ['DELETE FROM hon.school_creative_design_photos WHERE id=$1','UPDATE hon.school_creative_design_photos SET created_at=created_at WHERE id=$1']){
  await admin.query('BEGIN');try{await assert.rejects(admin.query(sql,[photo.photoId]),/CREATIVE_DESIGN_PHOTO_IMMUTABLE/,sql);}finally{await admin.query('ROLLBACK');}}
 // Cap: 300 photos per school.
 {const c=await register('gamma');await setAccess(c,'ACTIVE');
  await q("INSERT INTO hon.school_creative_design_photos(organization_id,school_id,media_type,content,checksum,created_by_principal_id) SELECT $1,$2,'image/png',$3,encode(sha256($3),'hex'),$4 FROM generate_series(1,300)",[c.org,c.school,png(),c.principal]);
  r=await addPhoto(c,{mediaType:'image/png',data:png().toString('base64')});assert.deepEqual([r.status,r.body.code],[413,'CREATIVE_DESIGN_PHOTO_LIMIT']);}
 // Cap: 150,000,000 stored bytes per school, counted with the new photo.
 {const c=await register('delta');await setAccess(c,'ACTIVE');const big=png([chunk('IDAT',Buffer.alloc(1_390_000))]);
  await q("INSERT INTO hon.school_creative_design_photos(organization_id,school_id,media_type,content,checksum,created_by_principal_id) SELECT $1,$2,'image/png',$3,encode(sha256($3),'hex'),$4 FROM generate_series(1,107)",[c.org,c.school,big,c.principal]);
  r=await addPhoto(c,{mediaType:'image/png',data:png().toString('base64')});assert.equal(r.status,200,'a small photo still fits');
  r=await addPhoto(c,{mediaType:'image/png',data:big.toString('base64')});assert.deepEqual([r.status,r.body.code],[413,'CREATIVE_DESIGN_PHOTO_LIMIT'],'the byte cap');}
 pass('photos lose their metadata in the API and the table refuses any that remains; the bytes and checksum read back only at the same school; exact replay, key reuse and a type that does not match the bytes are refused; photos are never changed or deleted; 300 photos and 150,000,000 bytes a school');

 // 3. Designs: create, read, change, exact replay and key reuse.
 const placed=doc([title(),{id:'hero',kind:'image',...el,y:200,w:540,h:360,imageId:photo.photoId,fit:'cover'},{id:'band',kind:'rect',...el,y:700,w:612,h:92,fill:'#000000',stroke:null,strokeWidth:0,radius:0},
  {id:'rule',kind:'line',...el,y:120,w:540,h:0,stroke:'#C8102E',strokeWidth:3},{id:'dot',kind:'ellipse',...el,fill:null,stroke:'#FFFFFF',strokeWidth:4},
  {id:'qr',kind:'qr',...el,x:500,y:680,w:90,h:90,data:'https://example.test/trial?c=spring',color:'#000000',background:'#FFFFFF'}]);
 const key=K();r=ok(await save(a,draft({document:placed}),key));
 const flyer=C.verifyCreativeDesignReceipt({design:r.data,replayed:r.meta.replayed},{version:1,sizeCode:'FLYER_LETTER',status:'ACTIVE'}).design;
 assert.deepEqual(flyer.document,placed,'the document is stored exactly');
 r=ok(await save(a,draft({document:placed}),key));assert.deepEqual([r.data.designId,r.meta.replayed],[flyer.designId,true],'exact replay');
 assert.equal((await save(a,draft({name:'Other'}),key)).body.code,'IDEMPOTENCY_KEY_REUSED');
 const card=ok(await save(a,draft({name:'Belt test postcard',sizeCode:'POSTCARD_4X6',document:doc([title({w:200})],2)}))).data;
 assert.equal(card.document.pages.length,2,'a postcard has a front and a back');
 const listed=await list(a);assert.deepEqual(listed.designs.map(d=>d.name),['Belt test postcard','Summer camp flyer'],'newest change first');
 assert(!('document' in listed.designs[0]),'the list carries no documents');
 assert.deepEqual(C.verifyCreativeDesign(ok(await send(base(a)+'/'+flyer.designId,{identity:a})).data).document,placed);
 assert.deepEqual((await list(b)).designs,[],'another school sees none');
 assert.equal((await send(base(b)+'/'+flyer.designId,{identity:b})).body.code,'CREATIVE_DESIGN_NOT_FOUND');
 const changed=doc([title({text:'Summer camp — last spots!'})]);
 r=ok(await save(a,draft({designId:flyer.designId,expectedVersion:1,name:'Summer camp flyer v2',document:changed})));
 assert.deepEqual([r.data.version,r.data.name,r.data.document],[2,'Summer camp flyer v2',changed]);
 assert.equal((await save(a,draft({designId:flyer.designId,expectedVersion:1}))).body.code,'VERSION_CONFLICT');
 assert.equal((await save(a,draft({designId:flyer.designId,expectedVersion:2,sizeCode:'POSTER_11X17'}))).status,400,'the size never changes');
 assert.equal((await save(a,draft({designId:K(),expectedVersion:1}))).body.code,'CREATIVE_DESIGN_NOT_FOUND');
 assert.equal((await save(b,draft({designId:flyer.designId,expectedVersion:2}))).body.code,'CREATIVE_DESIGN_NOT_FOUND','another school cannot reach it');
 {const foreign=ok(await addPhoto(b,{mediaType:'image/png',data:png([],77).toString('base64')})).data;
  r=await save(a,draft({name:'Foreign photo',document:doc([{id:'x',kind:'image',...el,imageId:foreign.photoId,fit:'contain'}])}));
  assert.deepEqual([r.status,r.body.code],[404,'CREATIVE_DESIGN_PHOTO_NOT_FOUND'],'a design may only place this school\'s photos');}
 {const after=await counts();assert.equal(Number(after.d)-Number(before.d),2);assert.equal(after.m,before.m,'no message is created');
  const audit=await q("SELECT action_code,next_state FROM hon.audit_events WHERE entity_type='CREATIVE_DESIGN' AND entity_id=$1 ORDER BY occurred_at,id",[flyer.designId]);
  assert.deepEqual(audit.map(x=>x.action_code),['creative_design.create','creative_design.update']);
  assert.deepEqual(Object.keys(audit[1].next_state).sort(),['designId','sizeCode','status','version'],'the audit keeps no text');
  const out=await q("SELECT payload FROM hon.outbox_events WHERE aggregate_type IN ('CREATIVE_DESIGN','CREATIVE_DESIGN_PHOTO') AND organization_id=$1",[a.org]);
  assert(out.length>=4&&out.every(o=>!/Summer|Main St|data/.test(JSON.stringify(o.payload))),'the outbox keeps ids only');}
 pass('staff create and change designs by exact version and read them back exactly; postcards have two pages; exact replay returns the same design; key reuse, stale versions, size changes, other schools and other schools\' photos are refused; audit and outbox keep ids only; no message is created');

 // 4. Validation in the API and caps.
 const bad=[draft({name:''}),draft({name:' padded'}),draft({name:'x'.repeat(81)}),draft({name:'Hidden‮flip'}),draft({sizeCode:'A4'}),draft({sizeCode:'POSTCARD_4X6'}),
  draft({document:doc([title(),title()])}),draft({document:doc([title({kind:'video'})])}),draft({document:doc([title({color:'red'})])}),draft({document:doc([title({size:1})])}),
  draft({document:doc([title({text:''})])}),draft({document:doc([title({extra:1})])}),draft({document:{v:2,pages:[]}}),draft({expectedVersion:1}),{...draft(),extra:1}];
 for(const body of bad)assert.equal((await save(a,body)).status,400,JSON.stringify(body).slice(0,80));
 assert.equal((await save(a,draft({name:'SUMMER CAMP FLYER V2'}))).body.code,'CREATIVE_DESIGN_NAME_TAKEN','names are unique, case-insensitive');
 {const c=await register('delta');await setAccess(c,'ACTIVE');
  await q("INSERT INTO hon.school_creative_designs(organization_id,school_id,name,size_code,document,status,created_by_principal_id,updated_by_principal_id) SELECT $1,$2,'Bulk '||g,'SOCIAL_SQUARE',$3,'ACTIVE',$4,$4 FROM generate_series(1,200) g",[c.org,c.school,doc([]),c.principal]);
  r=await save(c,draft({name:'One more'}));assert.deepEqual([r.status,r.body.code],[413,'CREATIVE_DESIGN_LIMIT']);
  assert.equal((await list(c)).designs.length,200);}
 pass('names 1-80 trimmed with no control or direction characters and unique among active designs; closed sizes; closed document shapes; 200 active designs a school');

 // 5. Archive and restore.
 r=ok(await setStatus(a,flyer.designId,{expectedVersion:2,status:'ARCHIVED'}));assert.deepEqual([r.data.status,r.data.version],['ARCHIVED',3]);
 assert(!(await list(a)).designs.some(d=>d.designId===flyer.designId));
 assert.deepEqual((await list(a,{status:'ARCHIVED'})).designs.map(d=>d.designId),[flyer.designId]);
 assert.equal((await save(a,draft({designId:flyer.designId,expectedVersion:3}))).body.code,'CREATIVE_DESIGN_ARCHIVED');
 assert.equal((await setStatus(a,flyer.designId,{expectedVersion:3,status:'ARCHIVED'})).body.code,'CREATIVE_DESIGN_STATUS_UNCHANGED');
 const taken=ok(await save(a,draft({name:'Summer camp flyer v2'}))).data;
 assert.equal((await setStatus(a,flyer.designId,{expectedVersion:3,status:'ACTIVE'})).body.code,'CREATIVE_DESIGN_NAME_TAKEN');
 ok(await setStatus(a,taken.designId,{expectedVersion:1,status:'ARCHIVED'}));
 r=ok(await setStatus(a,flyer.designId,{expectedVersion:3,status:'ACTIVE'}));assert.deepEqual([r.data.status,r.data.version],['ACTIVE',4]);
 assert.equal((await setStatus(b,flyer.designId,{expectedVersion:4,status:'ARCHIVED'})).body.code,'CREATIVE_DESIGN_NOT_FOUND');
 pass('archive hides a design and blocks changes until restored; restoring needs the name free; same-state, stale and other-school requests are refused');

 // 6. Authority.
 const reader=await staff(a,'reader',['creative.design.read']),manager=await staff(a,'manager',['creative.design.read','creative.design.manage']),none=await staff(a,'none',['communication.message.read']);
 assert((await list(reader)).designs.length>0);
 ok(await send(base(a)+'/photos/'+photo.photoId,{identity:reader}));
 assert.equal((await save(reader,draft({name:'Reader try'}))).status,403,'read does not open writing');
 assert.equal((await addPhoto(reader,{mediaType:'image/png',data:png().toString('base64')})).status,403);
 ok(await save(manager,draft({name:'Manager design'})));
 assert.equal((await send(base(none),{identity:none})).status,403);
 assert.equal((await send(base(b),{identity:a})).status,403,'another school in the route');
 assert.equal((await send(base(a),{identity:human('stranger')})).status,403);
 assert.equal((await send(base(a))).status,401);
 assert.equal((await send(base(a),{identity:a,method:'POST',body:draft({name:'No key'})})).body.code,'IDEMPOTENCY_KEY_REQUIRED');
 assert.equal((await send(base(a),{identity:a,headers:{'idempotency-key':'k'}})).status,409,'a read with a key');
 assert.equal((await send(base(a),{identity:a,method:'POST',body:draft({name:'Wrong command'}),key:K(),command:C.CREATIVE_DESIGN_PHOTO_COMMAND})).status,403,'the wrong browser command');
 assert.equal((await send(base(a),{identity:a,method:'POST',body:draft({name:'Cross'}),key:K(),headers:{origin:'https://evil.example.invalid'}})).status,403,'another origin');
 assert.equal((await send(base(a)+'?x=1',{identity:a,method:'POST',body:draft({name:'Query'}),key:K()})).status,400,'query values on a command');
 assert.equal((await send(base(a)+'?limit=9',{identity:a})).status,400,'unknown list filter');
 // A role that already held marketing.social.manage when 0617 ran was given both design permissions; one made later was not.
 {const marketer=await staff(a,'marketer',['marketing.social.manage']);assert.equal((await send(base(a),{identity:marketer})).status,403,'a later marketing role needs the design permission given');}
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[manager.grant]);
 assert.equal((await save(manager,draft({name:'After revoke'}))).status,403,'a revoked grant');
 await setAccess(a,'SUSPENDED');
 assert.equal((await send(base(a),{identity:a})).status,403,'suspended access');
 assert.equal((await save(a,draft({name:'Suspended'}))).status,403);
 await setAccess(a,'ACTIVE');
 assert(!(await list(a)).designs.some(d=>['Reader try','After revoke','Suspended','No key','Wrong command','Cross','Query'].includes(d.name)),'nothing refused was written');
 pass('reading needs creative.design.read and writing .manage at the exact school with live access; revoked grants, strangers, signed-out callers, other schools, wrong commands, other origins, missing keys and query values are refused with nothing written');

 // 7. Direct calls and the table itself.
 {const direct=async(settings,sql,args)=>{await restricted.query('BEGIN');
   try{if(settings){await restricted.query("SELECT set_config('app.hon_external_subject',$1,true),set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source',$5,true),set_config('app.hon_principal_id',$2,true),set_config('app.hon_organization_id',$3,true),set_config('app.hon_school_id',$4,true),set_config('app.hon_action_request_id',$6,true),set_config('app.hon_delegated_by_principal_id','',true),set_config('app.hon_request_id',$7,true)",[a.externalSubject,a.principal,a.org,a.school,settings.source??'HUMAN_UI',settings.action??'',settings.request??'']);}
    return (await restricted.query(sql,args)).rows[0];}finally{await restricted.query('ROLLBACK');}};
  const call="SELECT hon.save_school_creative_design($1,$2::jsonb,$3,$4::uuid,$5::uuid) d";
  await assert.rejects(direct(null,"SELECT hon.read_school_creative_designs($1,'{}'::jsonb)",[a.externalSubject]),/CREATIVE_DESIGN_FORBIDDEN/,'no session context');
  await assert.rejects(direct({source:'AI_AGENT'},"SELECT hon.read_school_creative_designs($1,'{}'::jsonb)",[a.externalSubject]),/CREATIVE_DESIGN_FORBIDDEN/,'not a human UI call');
  await assert.rejects(direct({},"SELECT hon.read_school_creative_designs($1,'{}'::jsonb)",[b.externalSubject]),/CREATIVE_DESIGN_FORBIDDEN/,'another subject');
  const rq=K();
  await assert.rejects(direct({request:rq,action:K()},call,[a.externalSubject,draft({name:'Delegated'}),'k1',rq,rq]),/CREATIVE_DESIGN_FORBIDDEN/,'an action request');
  await assert.rejects(direct({request:K()},call,[a.externalSubject,draft({name:'Wrong request'}),'k2',rq,rq]),/VALIDATION_FAILED/,'a request id that is not the session one');
  for(const body of [draft({name:'Dup',document:doc([title(),title()])}),draft({name:'Kind',document:doc([title({kind:'video'})])}),draft({name:'Color',document:doc([title({color:'#c8102e'})])}),
   draft({name:'Sides',sizeCode:'POSTCARD_5X7'}),draft({name:'Range',document:doc([title({x:1e6})])}),draft({name:'Keys',document:doc([title({onclick:'x'})])}),{...draft(),extra:true},
   draft({name:'QR long',document:doc([{id:'q',kind:'qr',...el,data:'x'.repeat(201),color:'#000000',background:null}])}),
   draft({name:'QR text',document:doc([{id:'q',kind:'qr',...el,data:'caf\u00e9',color:'#000000',background:null}])}),
   draft({name:'QR keys',document:doc([{id:'q',kind:'qr',...el,data:'ok',color:'#000000'}])})])
   await assert.rejects(direct({request:rq},call,[a.externalSubject,body,'k4',rq,rq]),/VALIDATION_FAILED/,'the database validates on its own: '+JSON.stringify(body).slice(0,60));
  await assert.rejects(direct({request:rq},"SELECT hon.add_school_creative_design_photo($1,$2::jsonb,$3,$4::uuid,$5::uuid) d",[a.externalSubject,{mediaType:'image/png',data:tagged.toString('base64')},'k5',rq,rq]),/CREATIVE_DESIGN_PHOTO_REFUSED/,'the database refuses metadata on its own');
  assert.equal((await direct({request:rq},call,[a.externalSubject,draft({name:'Direct ok'}),'k3',rq,rq])).d.design.name,'Direct ok','the right context writes');
  const id=flyer.designId;
  for(const sql of ['DELETE FROM hon.school_creative_designs WHERE id=$1',"UPDATE hon.school_creative_designs SET size_code='POSTER_11X17',version=version+1 WHERE id=$1",
    "UPDATE hon.school_creative_designs SET name='x' WHERE id=$1",`UPDATE hon.school_creative_designs SET school_id='${b.school}',version=version+1 WHERE id=$1`]){
   await admin.query('BEGIN');try{await assert.rejects(admin.query(sql,[id]),/CREATIVE_DESIGN_IMMUTABLE|violates/,sql);}finally{await admin.query('ROLLBACK');}}
  await admin.query('BEGIN');try{await assert.rejects(admin.query("UPDATE hon.school_creative_designs SET document=$2,version=version+1 WHERE id=$1",[id,doc([title({font:'COMIC'})])]),/school_creative_designs_document/);}finally{await admin.query('ROLLBACK');}}
 pass('direct runtime calls with input the contract would refuse fail VALIDATION_FAILED in the database too; calls without the human session, from another source, another subject, an action request or a foreign request id are refused; the tables refuse deletes, size or school moves, version skips and malformed documents even for the owner');
 console.log(`PASS CREATIVE DESIGNS: ${groups} groups`);
}finally{await app?.close();await Promise.allSettled([admin.end(),restricted.end(),worker.end(),database.onModuleDestroy?.()]);}
