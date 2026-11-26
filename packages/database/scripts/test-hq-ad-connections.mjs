import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// 0677 HQ ad account connections integrity proof, TEST MODE, disposable database only, deterministic fake Zernio (no network).
// It proves: only a current HQ owner connects or disconnects HON's ad accounts (marketing operators, read-only operators,
// support, lapsed owners, school owners and unknown subjects are refused) and HQ marketing readers only read; the runtime can
// execute only the six entry points and has no table privilege; a connect intent is single use, bound to its starter, and
// expires after 10 minutes; at most 10 attempts an hour; HQ's Zernio profile is linked once (a school's profile id is
// refused); accounts come from HON's own profile, an account a school holds is skipped and counted; reconnecting keeps one
// row; disconnect is idempotent, version-checked and returns the provider id only to the API; evidence is append-only and
// guarded rows cannot be rewritten; nothing touches school social rows; a person revoked meanwhile gets nothing.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env);
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|ZERNIO|META|GOOGLE|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER|ZERNIO|HQ_ZERNIO))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {HqAdConnectionsService}=await import('../../../apps/api/dist/hq-ad-connections/hq-ad-connections.service.js');
const {FakeZernioSocialAdapter,hqZernioConnector,hqZernioEnvironment}=await import('../../../apps/api/dist/marketing/social/zernio-social-adapter.js');
const database=new RuntimeDatabaseService();
// The fake sees only an explicit test environment; the process environment holds no Zernio key or switch.
const fake=new FakeZernioSocialAdapter(()=>hqZernioEnvironment({HON_ZERNIO_FAKE_PROVIDER:'1',HON_DEPLOYMENT_ENVIRONMENT:'development'}));
const connections=new HqAdConnectionsService(database,hqZernioConnector(fake));
const admin=new pg.Client(targets.owner),restricted=new pg.Client(targets.runtime);
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const K=()=>randomUUID();
const ORG=randomUUID(),S=randomUUID(),ROLE=randomUUID();
const humans=Object.fromEntries(['owner','owner2','exowner','marketer','reader','supportOp','schoolOwner','stranger']
 .map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hqad-${k}-${randomUUID()}`,name:`Fixture ${k}`}]));
const H=k=>humans[k].subject,P=k=>humans[k].id;
const tables=['hq_ad_events','hq_ad_requests','hq_ad_connect_intents','hq_ad_accounts','hq_ad_profile'];
const schoolTables=['school_social_accounts','school_social_profiles'];
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of [...tables,...schoolTables])await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  for(const t of tables)await admin.query(`DELETE FROM hon.${t}`);
  for(const t of schoolTables)await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`,[ORG]);
  for(const t of [...tables,...schoolTables])await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  const ps=Object.values(humans).map(h=>h.id),us=Object.values(humans).map(h=>h.user);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`,[ORG]);
  await admin.query('DELETE FROM hon.organizations WHERE id=$1',[ORG]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[us]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const counts=async()=>row(`SELECT (SELECT count(*) FROM hon.hq_ad_accounts)::int a,(SELECT count(*) FROM hon.hq_ad_connect_intents)::int i,
 (SELECT count(*) FROM hon.hq_ad_events)::int e,(SELECT count(*) FROM hon.hq_ad_requests)::int r,(SELECT count(*) FROM hon.hq_ad_profile)::int p,
 (SELECT count(*) FROM hon.school_social_accounts)::int school`);
const stateOf=url=>new URL(url).searchParams.get('state');

await Promise.all([admin.connect(),restricted.connect()]);
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(restricted,CHAMPIONS_RUNTIME_ROLE);
await verifyChampionsProofConnection({query:(...a)=>database['getPool']().query(...a)},CHAMPIONS_RUNTIME_ROLE);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. posture ----------
 for(const[sig,allowed]of [['read_hq_ad_accounts(text)',true],['start_hq_ad_connect(text,jsonb,text)',true],['record_hq_ad_profile(text,uuid,text)',true],
  ['claim_hq_ad_connect(text,text)',true],['record_hq_ad_accounts(text,uuid,jsonb)',true],['disconnect_hq_ad_account(text,uuid,jsonb,uuid)',true],
  ['require_hq_ad_actor(text,boolean)',false],['hq_ad_owner_eligible(uuid)',false],['hq_ad_open_intent(uuid,uuid)',false],['hq_ad_event(text,uuid,uuid,uuid,jsonb)',false],
  ['hq_ad_accounts_json()',false],['guard_hq_ad()',false]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 for(const t of tables){
  for(const priv of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await restricted.query('SELECT has_table_privilege(current_user,$1,$2) a',['hon.'+t,priv])).rows[0].a,false,`${t} ${priv}`);
  assert.deepEqual(await row("SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass",['hon.'+t]),{r:true,f:true},t);
 }
 await cleanup();

 // ---------- fixture ----------
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[h.user,h.subject,`${h.user}@example.test`,h.name]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[h.id,h.user,h.name]);}
 for(const[who,role,perms,until]of [['owner','HON_HQ_OWNER',[],null],['owner2','HON_HQ_OWNER',[],null],['exowner','HON_HQ_OWNER',[],'1 minute'],
  ['marketer','HON_HQ_OPERATOR',['hq.marketing.manage'],null],['reader','HON_HQ_OPERATOR',['hq.marketing.read'],null],['supportOp','HON_HQ_SUPPORT',['hq.marketing.manage'],null]])
  await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until?`clock_timestamp()-interval '${until}'`:'NULL'})`,[P(who),role,perms]);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQAD Fixture Dojo','HQAD Fixture Dojo','ACTIVE',clock_timestamp())",[ORG]);
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQAD Main',$1::text,'UTC')",[S,ORG]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[ROLE,ORG]);
 await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[ORG,S,P('schoolOwner'),ROLE]);
 // A school already holds a Facebook account and its own Zernio profile.
 await admin.query("INSERT INTO hon.school_social_profiles(organization_id,school_id,provider_profile_id,linked_by_principal_id) VALUES($1,$2,'school_profile_1',$3)",[ORG,S,P('schoolOwner')]);
 await admin.query("INSERT INTO hon.school_social_accounts(organization_id,school_id,platform,provider_account_id,display_name,status,connected_by_principal_id) VALUES($1,$2,'FACEBOOK','fb_school_held','School Page','CONNECTED',$3)",[ORG,S,P('schoolOwner')]);
 await admin.query('COMMIT');
 const start=await counts();
 assert.deepEqual({...start,school:0},{a:0,i:0,e:0,r:0,p:0,school:0});

 // ---------- 1. authority ----------
 for(const who of ['exowner','supportOp','schoolOwner','stranger']){
  await deny(connections.list(H(who)),403,'SAAS_FORBIDDEN');
  await deny(connections.start(H(who),{provider:'GOOGLE_ADS'}),403,'SAAS_FORBIDDEN');
 }
 for(const who of ['marketer','reader']){
  const l=await connections.list(H(who));
  assert.deepEqual([l.accounts,l.profileLinked,l.viewer.canConnect,l.connectEnabled],[[],false,false,true],who);
  await deny(connections.start(H(who),{provider:'GOOGLE_ADS'}),403,'SAAS_FORBIDDEN');
 }
 assert.equal((await connections.list(H('owner'))).viewer.canConnect,true);
 assert.deepEqual(await counts(),start,'refusals wrote nothing');

 // ---------- 2. connect Google Ads: profile linked once, accounts from HON's own profile ----------
 const g=await connections.start(H('owner'),{provider:'GOOGLE_ADS'});
 assert.equal(new URL(g.authUrl).pathname,'/hq/marketing/ads/return');
 const profileId=fake.profiles.get('hon-hq'); assert.ok(profileId);
 assert.equal((await row('SELECT provider_profile_id p FROM hon.hq_ad_profile')).p,profileId);
 await deny(connections.complete(H('owner2'),{state:stateOf(g.authUrl)}),400,'HQ_AD_CONNECT_STATE_INVALID');
 const gDone=await connections.complete(H('owner'),{state:stateOf(g.authUrl)});
 assert.deepEqual([gDone.provider,gDone.connected,gDone.conflicts,gDone.accounts.map(a=>[a.provider,a.status,a.displayName])],
  ['GOOGLE_ADS',1,0,[['GOOGLE_ADS','CONNECTED','Synthetic Dojo Google Ads']]]);
 await deny(connections.complete(H('owner'),{state:stateOf(g.authUrl)}),400,'HQ_AD_CONNECT_STATE_INVALID');
 assert(!JSON.stringify(gDone).includes('gads_'),'provider id never leaves the API');

 // ---------- 3. Meta: the school-held Facebook account is skipped and counted ----------
 fake.extra.set(profileId,[{providerAccountId:'fb_school_held',platform:'FACEBOOK',displayName:'School Page'}]);
 const m=await connections.start(H('owner2'),{provider:'META_ADS'});
 assert.equal(new URL(m.authUrl).searchParams.get('connected'),'facebook');
 const mDone=await connections.complete(H('owner2'),{state:stateOf(m.authUrl)});
 assert.deepEqual([mDone.connected,mDone.conflicts],[1,1]);
 assert.equal((await row("SELECT count(*)::int n FROM hon.hq_ad_accounts WHERE provider_account_id='fb_school_held'")).n,0);
 const listed=await connections.list(H('reader'));
 assert.deepEqual(listed.accounts.map(a=>[a.provider,a.status]).sort(),[['GOOGLE_ADS','CONNECTED'],['META_ADS','CONNECTED']]);
 assert.equal(listed.profileLinked,true);
 assert(!JSON.stringify(listed).includes('@example.test'));
 for(const h of Object.values(humans))assert(!JSON.stringify(listed).includes(h.subject),'no subject');

 // ---------- 4. profile conflicts, expiry, rate limit ----------
 const x=await connections.start(H('owner'),{provider:'GOOGLE_ADS'});
 const intent=(await row("SELECT id FROM hon.hq_ad_connect_intents WHERE consumed_at IS NULL ORDER BY created_at DESC LIMIT 1")).id;
 await sqlDeny(restricted.query('SELECT hon.record_hq_ad_profile($1,$2,$3)',[H('owner'),intent,'another_profile']),'23514');
 await sqlDeny(restricted.query('SELECT hon.record_hq_ad_profile($1,$2,$3)',[H('owner'),intent,'school_profile_1']),'23514');
 await admin.query('BEGIN');await admin.query('ALTER TABLE hon.hq_ad_connect_intents DISABLE TRIGGER USER');
 await admin.query("UPDATE hon.hq_ad_connect_intents SET created_at=created_at-interval '11 minutes',expires_at=expires_at-interval '11 minutes' WHERE id=$1",[intent]);
 await admin.query('ALTER TABLE hon.hq_ad_connect_intents ENABLE TRIGGER USER');await admin.query('COMMIT');
 await deny(connections.complete(H('owner'),{state:stateOf(x.authUrl)}),400,'HQ_AD_CONNECT_STATE_EXPIRED');
 await deny(connections.complete(H('owner'),{state:'A'.repeat(43)}),400,'HQ_AD_CONNECT_STATE_INVALID');
 const used=(await row('SELECT count(*)::int n FROM hon.hq_ad_connect_intents')).n;
 for(let n=used;n<10;n++)await connections.start(H('owner'),{provider:'META_ADS'});
 await deny(connections.start(H('owner'),{provider:'META_ADS'}),429,'HQ_AD_RATE_LIMITED');
 for(const bad of [{provider:'TIKTOK'},{provider:'GOOGLE_ADS',x:1}])await deny(connections.start(H('owner'),bad),400,'INVALID_SAAS_INPUT');
 await sqlDeny(restricted.query('SELECT hon.start_hq_ad_connect($1,$2::jsonb,$3)',[H('owner'),'{"provider":"GOOGLE_ADS"}','nothex']),'22023');

 // ---------- 5. disconnect: idempotent, version-checked; reconnect keeps one row ----------
 const google=listed.accounts.find(a=>a.provider==='GOOGLE_ADS');
 await deny(connections.disconnect(H('marketer'),google.accountId,{expectedVersion:google.version},K()),403,'SAAS_FORBIDDEN');
 await deny(connections.disconnect(H('owner'),google.accountId,{expectedVersion:google.version+1},K()),409,'SAAS_VERSION_CONFLICT');
 await deny(connections.disconnect(H('owner'),randomUUID(),{expectedVersion:1},K()),404,'SAAS_UNAVAILABLE');
 const dk=K();
 const off=await connections.disconnect(H('owner'),google.accountId,{expectedVersion:google.version},dk);
 assert.deepEqual([off.account.status,off.account.version,off.providerRemoval,off.replayed],['DISCONNECTED',2,'REMOVED',false]);
 assert.equal(fake.removed.length,1);
 const again=await connections.disconnect(H('owner'),google.accountId,{expectedVersion:google.version},dk);
 assert.deepEqual([again.replayed,again.providerRemoval,again.account],[true,'NOT_ATTEMPTED',off.account]);
 assert.equal(fake.removed.length,1,'a replay never asks Zernio again');
 await deny(connections.disconnect(H('owner'),google.accountId,{expectedVersion:3},dk),409,'IDEMPOTENCY_KEY_REUSED');
 await deny(connections.disconnect(H('owner'),google.accountId,{expectedVersion:2},K()),422,'HQ_AD_ACCOUNT_DISCONNECTED');
 // The fake still reports the account on the profile, so reconnecting brings the same row back.
 await admin.query('BEGIN');await admin.query('ALTER TABLE hon.hq_ad_connect_intents DISABLE TRIGGER USER');
 await admin.query("UPDATE hon.hq_ad_connect_intents SET created_at=created_at-interval '2 hours',expires_at=expires_at-interval '2 hours'");
 await admin.query('ALTER TABLE hon.hq_ad_connect_intents ENABLE TRIGGER USER');await admin.query('COMMIT');
 const re=await connections.start(H('owner'),{provider:'GOOGLE_ADS'});
 const reDone=await connections.complete(H('owner'),{state:stateOf(re.authUrl)});
 const back=reDone.accounts.find(a=>a.accountId===google.accountId);
 assert.deepEqual([back.status,back.version,back.disconnectedAt],['CONNECTED',3,null]);
 assert.equal((await row("SELECT count(*)::int n FROM hon.hq_ad_accounts WHERE provider='GOOGLE_ADS'")).n,1);

 // ---------- 6. guards: evidence append-only, rows not rewritable ----------
 await sqlDeny(admin.query("UPDATE hon.hq_ad_accounts SET provider_account_id='other',version=version+1 WHERE id=$1",[google.accountId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_ad_accounts SET display_name='No bump' WHERE id=$1",[google.accountId]),'42501');
 await sqlDeny(admin.query('DELETE FROM hon.hq_ad_accounts WHERE id=$1',[google.accountId]),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_ad_profile SET provider_profile_id='x'"),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_ad_events SET kind='PROFILE_LINKED'"),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_ad_requests SET response='{}'"),'42501');
 await sqlDeny(admin.query("UPDATE hon.hq_ad_connect_intents SET outcome='NOTHING_FOUND' WHERE outcome='RECORDED'"),'42501');
 await sqlDeny(admin.query('TRUNCATE hon.hq_ad_events'),'42501');
 await sqlDeny(admin.query("INSERT INTO hon.hq_ad_profile(singleton,provider_profile_id,linked_by_principal_id) VALUES(true,'p2',$1)",[P('owner')]),'23505');
 const kinds=(await admin.query('SELECT kind,count(*)::int n FROM hon.hq_ad_events GROUP BY kind ORDER BY kind')).rows;
 assert.deepEqual(kinds.map(k=>k.kind),['ACCOUNT_CONNECTED','ACCOUNT_DISCONNECTED','CONNECT_FINISHED','CONNECT_STARTED','PROFILE_LINKED']);
 assert.equal((await counts()).school,start.school,'no school social row was written');

 // ---------- 7. a person revoked meanwhile gets nothing ----------
 const before=await counts();
 await admin.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1",[P('owner2')]);
 await deny(connections.list(H('owner2')),403,'SAAS_FORBIDDEN');
 await deny(connections.disconnect(H('owner2'),google.accountId,{expectedVersion:3},K()),403,'SAAS_FORBIDDEN');
 assert.deepEqual(await counts(),before);
 console.log('HQ ad connections proof passed (posture, owner-only connect, readers read, single-use expiring state, rate limit, one HQ profile, school-held account skipped, disconnect idempotency/version, reconnect, guards, no school rows, revocation).');
}finally{
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]);}
}
