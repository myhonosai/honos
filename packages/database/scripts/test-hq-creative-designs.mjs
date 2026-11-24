import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// 0678 HQ Creative designs integrity proof, TEST MODE, disposable database only. It proves: the runtime can execute only
// the six entry points and has no table privilege (forced RLS, no policies); HQ owner and hq.marketing.manage create,
// change, archive, restore and add photos, hq.marketing.read only reads, and support, billing, lapsed owners, school
// owners and strangers are refused; documents, names and sizes follow the 0617 rules; versions are exact; an archived
// design must be restored first; active names are unique; replays return the same receipt and key reuse is refused; photos
// must be clean and HQ's own; designs are never deleted and photos and receipts never change; no school design or photo
// row is written; a person revoked meanwhile gets nothing.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env);
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|ZERNIO|META|GOOGLE|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {HqCreativeDesignsService}=await import('../../../apps/api/dist/hq-creative/hq-creative-designs.service.js');
const contracts=await import('@hon/contracts');
const database=new RuntimeDatabaseService(),designs=new HqCreativeDesignsService(database);
const admin=new pg.Client(targets.owner),restricted=new pg.Client(targets.runtime);
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID();
const ORG=randomUUID(),S=randomUUID(),ROLE=randomUUID();
const humans=Object.fromEntries(['owner','exowner','marketer','reader','supportOp','billingOp','schoolOwner','stranger','leaver']
 .map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hqcd-${k}-${randomUUID()}`,name:`Fixture ${k}`}]));
const H=k=>humans[k].subject,P=k=>humans[k].id;
const tables=['hq_creative_design_requests','hq_creative_designs','hq_creative_design_photos'];
// 1x1 PNG, critical chunks only.
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  const ps=Object.values(humans).map(h=>h.id),us=Object.values(humans).map(h=>h.user);
  await admin.query('DELETE FROM hon.hq_creative_design_requests WHERE actor_principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.hq_creative_designs WHERE created_by_principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.hq_creative_design_photos WHERE created_by_principal_id=ANY($1::uuid[])',[ps]);
  for(const t of tables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`,[ORG]);
  await admin.query('DELETE FROM hon.organizations WHERE id=$1',[ORG]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[us]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const counts=async()=>row(`SELECT (SELECT count(*) FROM hon.hq_creative_designs)::int d,(SELECT count(*) FROM hon.hq_creative_design_photos)::int p,
 (SELECT count(*) FROM hon.hq_creative_design_requests)::int r`);
const schoolSide=async()=>row('SELECT (SELECT count(*) FROM hon.school_creative_designs)::int d,(SELECT count(*) FROM hon.school_creative_design_photos)::int p');
const blank=code=>contracts.blankCreativeDesignDocument(code);
const create=(patch={})=>({designId:null,expectedVersion:0,name:'HON OS launch post',sizeCode:'SOCIAL_SQUARE',document:blank('SOCIAL_SQUARE'),...patch});
const withPhoto=(photoId)=>({v:1,pages:[{background:'#FFFFFF',elements:[{id:'p1',kind:'image',x:10,y:10,w:200,h:200,rotation:0,opacity:1,locked:false,imageId:photoId,fit:'cover'}]}]});

await Promise.all([admin.connect(),restricted.connect()]);
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(restricted,CHAMPIONS_RUNTIME_ROLE);
await verifyChampionsProofConnection({query:(...a)=>database['getPool']().query(...a)},CHAMPIONS_RUNTIME_ROLE);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. posture ----------
 for(const[sig,allowed]of [['read_hq_creative_designs(text,jsonb)',true],['read_hq_creative_design(text,jsonb)',true],['read_hq_creative_design_photo(text,jsonb)',true],
  ['save_hq_creative_design(text,jsonb,uuid)',true],['set_hq_creative_design_status(text,jsonb,uuid)',true],['add_hq_creative_design_photo(text,jsonb,uuid)',true],
  ['hq_creative_design_claim(uuid,uuid,text,text)',false],['hq_creative_design_room_check(text,uuid,boolean)',false],['hq_creative_design_id(jsonb,text)',false],
  ['hq_creative_design_json(hon.hq_creative_designs)',false],['guard_hq_creative_design()',false],['guard_hq_creative_design_append()',false]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 for(const t of tables)for(const priv of ['SELECT','INSERT','UPDATE','DELETE'])
  assert.equal((await restricted.query('SELECT has_table_privilege(current_user,$1,$2) a',['hon.'+t,priv])).rows[0].a,false,`${t} ${priv}`);
 for(const t of tables){
  assert.deepEqual(await row("SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass",['hon.'+t]),{r:true,f:true},t);
  assert.equal((await row('SELECT count(*)::int n FROM pg_policies WHERE schemaname=$1 AND tablename=$2',['hon',t])).n,0,`${t} has no policies`);
 }
 await cleanup();
 assert.deepEqual(await counts(),{d:0,p:0,r:0},'the disposable database holds no other HQ design rows');

 // ---------- fixture ----------
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[h.user,h.subject,`${h.user}@example.test`,h.name]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[h.id,h.user,h.name]);}
 for(const[who,role,perms,until]of [['owner','HON_HQ_OWNER',[],null],['exowner','HON_HQ_OWNER',[],'1 minute'],['marketer','HON_HQ_OPERATOR',['hq.marketing.manage'],null],
  ['reader','HON_HQ_OPERATOR',['hq.marketing.read'],null],['supportOp','HON_HQ_SUPPORT',['hq.marketing.manage','hq.support.manage'],null],
  ['billingOp','HON_HQ_OPERATOR',['hq.billing.manage','hq.dashboard.view'],null],['leaver','HON_HQ_OPERATOR',['hq.marketing.manage'],null]])
  await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until?`clock_timestamp()-interval '${until}'`:'NULL'})`,[P(who),role,perms]);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQCD Fixture Dojo','HQCD Fixture Dojo','ACTIVE',clock_timestamp())",[ORG]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQCD Main',$1::text,'UTC')",[S,ORG]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[ROLE,ORG]);
 await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[ROLE,ORG]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[ORG,S,P('schoolOwner'),ROLE]);
 await admin.query('COMMIT');
 const start=await counts(),school=await schoolSide();

 // ---------- 1. authority ----------
 for(const who of ['exowner','supportOp','billingOp','schoolOwner','stranger']){
  await deny(designs.list(H(who),{}),403,'SAAS_FORBIDDEN').catch(e=>{throw new Error(who+' list: '+e.message);});
  await deny(designs.save(H(who),create(),K()),403,'SAAS_FORBIDDEN');
  await deny(designs.addPhoto(H(who),{mediaType:'image/png',data:PNG},K()),403,'SAAS_FORBIDDEN');
 }
 assert.deepEqual(await designs.list(H('reader'),{}),{designs:[]});
 await deny(designs.save(H('reader'),create(),K()),403,'SAAS_FORBIDDEN');
 await deny(designs.get(H('reader'),randomUUID()),404,'CREATIVE_DESIGN_NOT_FOUND');
 assert.deepEqual(await counts(),start,'refusals wrote nothing');

 // ---------- 2. create, change, versions, names ----------
 for(const bad of [create({name:' padded'}),create({sizeCode:'BILLBOARD'}),create({expectedVersion:1}),create({document:blank('POSTCARD_4X6')}),{...create(),extra:1}])
  await deny(designs.save(H('owner'),bad,K()),400,'VALIDATION_FAILED');
 await sqlDeny(restricted.query('SELECT hon.save_hq_creative_design($1,$2::jsonb,$3)',[H('owner'),JSON.stringify(create({document:blank('POSTCARD_4X6')})),K()]),'22023');
 const ck=K();
 const made=await designs.save(H('marketer'),create(),ck);
 assert.deepEqual([made.replayed,made.design.version,made.design.status,made.design.name],[false,1,'ACTIVE','HON OS launch post']);
 const again=await designs.save(H('marketer'),create(),ck);
 assert.deepEqual([again.replayed,again.design.designId],[true,made.design.designId],'the same key returns the same design');
 await deny(designs.save(H('marketer'),create({name:'Another name'}),ck),409,'IDEMPOTENCY_KEY_REUSED');
 assert.equal((await counts()).d,start.d+1,'one design, never two');
 await deny(designs.save(H('owner'),create({name:'hon os LAUNCH post'}),K()),409,'CREATIVE_DESIGN_NAME_TAKEN');
 const id=made.design.designId;
 const changed=await designs.save(H('owner'),{designId:id,expectedVersion:1,name:'HON OS launch post v2',sizeCode:'SOCIAL_SQUARE',document:blank('SOCIAL_SQUARE')},K());
 assert.equal(changed.design.version,2);
 await deny(designs.save(H('owner'),{designId:id,expectedVersion:1,name:'Stale',sizeCode:'SOCIAL_SQUARE',document:blank('SOCIAL_SQUARE')},K()),409,'VERSION_CONFLICT');
 await deny(designs.save(H('owner'),{designId:id,expectedVersion:2,name:'Resize',sizeCode:'FLYER_LETTER',document:blank('FLYER_LETTER')},K()),400,'VALIDATION_FAILED');
 assert.equal((await designs.get(H('reader'),id)).name,'HON OS launch post v2');
 assert.deepEqual((await designs.list(H('reader'),{})).designs.map(d=>d.designId),[id]);

 // ---------- 3. archive and restore ----------
 await deny(designs.setStatus(H('reader'),{designId:id,expectedVersion:2,status:'ARCHIVED'},K()),403,'SAAS_FORBIDDEN');
 const archived=await designs.setStatus(H('marketer'),{designId:id,expectedVersion:2,status:'ARCHIVED'},K());
 assert.deepEqual([archived.design.status,archived.design.version],['ARCHIVED',3]);
 await deny(designs.setStatus(H('marketer'),{designId:id,expectedVersion:3,status:'ARCHIVED'},K()),409,'CREATIVE_DESIGN_STATUS_UNCHANGED');
 await deny(designs.save(H('owner'),{designId:id,expectedVersion:3,name:'While archived',sizeCode:'SOCIAL_SQUARE',document:blank('SOCIAL_SQUARE')},K()),409,'CREATIVE_DESIGN_ARCHIVED');
 assert.deepEqual((await designs.list(H('reader'),{status:'ARCHIVED'})).designs.map(d=>d.designId),[id]);
 const twin=await designs.save(H('owner'),create({name:'HON OS launch post v2'}),K());
 await deny(designs.setStatus(H('owner'),{designId:id,expectedVersion:3,status:'ACTIVE'},K()),409,'CREATIVE_DESIGN_NAME_TAKEN');
 await designs.setStatus(H('owner'),{designId:twin.design.designId,expectedVersion:1,status:'ARCHIVED'},K());
 assert.equal((await designs.setStatus(H('owner'),{designId:id,expectedVersion:3,status:'ACTIVE'},K())).design.version,4);

 // ---------- 4. photos ----------
 await deny(designs.addPhoto(H('owner'),{mediaType:'image/jpeg',data:PNG},K()),400,'CREATIVE_DESIGN_PHOTO_REFUSED');
 await deny(designs.save(H('owner'),{designId:id,expectedVersion:4,name:'With photo',sizeCode:'SOCIAL_SQUARE',document:withPhoto(randomUUID())},K()),404,'CREATIVE_DESIGN_PHOTO_NOT_FOUND');
 const pk=K();
 const photo=await designs.addPhoto(H('marketer'),{mediaType:'image/png',data:PNG},pk);
 assert.equal((await designs.addPhoto(H('marketer'),{mediaType:'image/png',data:PNG},pk)).photo.photoId,photo.photo.photoId,'the same key adds one photo');
 const read=await designs.photo(H('reader'),photo.photo.photoId);
 assert.deepEqual([read.mediaType,read.bytes,Buffer.from(read.data,'base64').length],['image/png',photo.photo.bytes,photo.photo.bytes]);
 assert.equal((await designs.save(H('owner'),{designId:id,expectedVersion:4,name:'With photo',sizeCode:'SOCIAL_SQUARE',document:withPhoto(photo.photo.photoId)},K())).design.version,5);
 // A school design photo is never an HQ photo.
 const schoolPhoto=(await row(`INSERT INTO hon.school_creative_design_photos(organization_id,school_id,media_type,content,checksum,created_by_principal_id)
  VALUES($1,$2,'image/png',decode($3,'base64'),encode(sha256(decode($3,'base64')),'hex'),$4) RETURNING id`,[ORG,S,PNG,P('schoolOwner')])).id;
 await deny(designs.save(H('owner'),{designId:id,expectedVersion:5,name:'School photo',sizeCode:'SOCIAL_SQUARE',document:withPhoto(schoolPhoto)},K()),404,'CREATIVE_DESIGN_PHOTO_NOT_FOUND');
 await deny(designs.photo(H('owner'),schoolPhoto),404,'CREATIVE_DESIGN_PHOTO_NOT_FOUND');
 await admin.query('ALTER TABLE hon.school_creative_design_photos DISABLE TRIGGER USER');
 await admin.query('DELETE FROM hon.school_creative_design_photos WHERE id=$1',[schoolPhoto]);
 await admin.query('ALTER TABLE hon.school_creative_design_photos ENABLE TRIGGER USER');

 // ---------- 5. immutability ----------
 await sqlDeny(admin.query('DELETE FROM hon.hq_creative_designs WHERE id=$1',[id]),'42501');
 await sqlDeny(admin.query('TRUNCATE hon.hq_creative_designs'),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_creative_designs SET size_code='FLYER_LETTER', version=version+1 WHERE id=$1",[id]),'42501');
 await sqlDeny(admin.query('UPDATE hon.hq_creative_design_photos SET created_at=now() WHERE id=$1',[photo.photo.photoId]),'42501');
 await sqlDeny(admin.query('DELETE FROM hon.hq_creative_design_requests WHERE idempotency_key=$1',[ck]),'42501');
 assert.deepEqual(await schoolSide(),school,'no school design or photo row was written');

 // ---------- 6. revocation ----------
 await admin.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1",[P('leaver')]);
 await deny(designs.list(H('leaver'),{}),403,'SAAS_FORBIDDEN');
 await deny(designs.save(H('leaver'),create({name:'Leaver design'}),K()),403,'SAAS_FORBIDDEN');
 assert.equal((await row('SELECT count(*)::int n FROM hon.hq_creative_designs WHERE created_by_principal_id=$1',[P('leaver')])).n,0);
 console.log('HQ Creative designs proof passed (posture, authority incl. read-only, 0617 document rules, versions, unique active names, archive/restore, idempotent replay and key reuse, clean HQ-only photos, immutability, no school rows, revocation).');
}finally{
 await cleanup().catch(e=>console.error('cleanup failed',e));
 await Promise.all([admin.end(),restricted.end(),database.onModuleDestroy?.()]);
}
