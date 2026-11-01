/** Real signed-session Nest routes + actual HQ PostgreSQL resolver. Synthetic provider only. */
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { request } = require('node:http');
const root = resolve(__dirname, '../../..');
assert.equal(process.env.HON_ZERNIO_API_TEST, '1');
assert.equal(process.env.HON_ZERNIO_VERIFICATION_APPROVED, undefined);
assert.equal(process.env.ZERNIO_API_KEY, undefined);
for (const key of Object.keys(process.env)) assert(!/^(?:OPENAI|ANTHROPIC|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key));
const ownerUrl = new URL(process.env.DATABASE_URL ?? ''), runtimeUrl = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
for (const [url, username] of [[ownerUrl,'hon_champions_owner'],[runtimeUrl,'hon_champions_runtime']]) {
  assert.equal(url.protocol,'postgresql:'); assert.equal(url.hostname,'localhost'); assert.equal(url.port,'5432');
  assert.equal(url.pathname,'/hon_champions_validation'); assert.equal(url.username,username);
}
const apiRequire = createRequire(resolve(root,'apps/api/package.json'));
const dbRequire = createRequire(resolve(root,'packages/database/package.json'));
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing'), { Client } = dbRequire('pg');
const { issueSession, HON_SESSION_COOKIE } = apiRequire('@hon/auth');
const contracts = apiRequire('@hon/contracts');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { HonIdentityService } = require('../dist/foundation/hon-identity.service.js');
const { ZernioIntegrationController, ZernioHumanUiGuard } = require('../dist/integrations/zernio.controller.js');
const { ZernioIntegrationService } = require('../dist/integrations/zernio.service.js');
const { ZernioCredentialRuntime, ZERNIO_RUNTIME } = require('../dist/integrations/zernio-runtime.js');
const owner = new Client({connectionString:ownerUrl.toString(),ssl:false}), database = new RuntimeDatabaseService();
const session = {mode:'OIDC',audience:'zernio-disposable-api',secret:randomBytes(32).toString('hex')};
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;
const checks = [], pass = name => { checks.push(name); console.log('PASS '+name); };
const deferred = () => { let resolve; const promise = new Promise(r=>{resolve=r;}); return {promise,resolve}; };
let app, calls = 0, enabled = false, wait = null, started = null;
const fake = {
  configuration: () => ({...new ZernioCredentialRuntime(()=>({})).configuration(),...(enabled?{credential:'PRESENT',verificationEnabled:true}:{})}),
  verifyCredential: async () => { ++calls; if (started) started.resolve(); if (wait) await wait.promise; return 'VALID'; }
};
const actors = {};
function send(origin,path,{who='owner',method='GET',patch={},body,expired=false,forged=false}={}) {
  const cookie = who ? `${HON_SESSION_COOKIE}=${forged?'forged':issueSession({externalSubject:actors[who].subject},session,Math.floor(Date.now()/1000)-(expired?43201:0))}` : undefined;
  const headers = {...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',
    ...(method==='POST'?{'content-type':'application/json','x-hon-human-command':'zernio-credential-verify'}:{}),...patch};
  return new Promise((accept,reject)=>{const req=request(origin+'/v1/hq/integrations/zernio/'+path,{method,headers},res=>{
    let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>accept({status:res.statusCode,headers:res.headers,body}));
  });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
(async()=>{
try {
  await owner.connect();
  assert.deepEqual((await owner.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0],
    {owner:'hon_champions_owner',marker:'HON disposable Champions Club validation'});
  for (const who of ['owner','operator','support','school','nonhuman','inactive','expired-grant']) {
    const user=randomUUID(),principal=randomUUID(),subject='zernio-fixture-'+who+'-'+randomUUID();actors[who]={user,principal,subject};
    await owner.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic Zernio user')",[user,subject,user+'@example.invalid']);
    await owner.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,$3,'Synthetic Zernio principal',$4)",
      [principal,who==='nonhuman'?null:user,who==='nonhuman'?'AI_EMPLOYEE':'HUMAN_USER',who!=='inactive']);
    if(who!=='school') await owner.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '2 days',CASE WHEN $4 THEN clock_timestamp()-interval '1 day' ELSE NULL END)",
      [principal,who==='operator'?'HON_HQ_OPERATOR':who==='support'?'HON_HQ_SUPPORT':'HON_HQ_OWNER',['hq.integrations.zernio.read'],who==='expired-grant']);
  }
  const snapshot = async () => {
    const tables=(await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='hon' AND tablename<>'hq_operator_grants' ORDER BY tablename")).rows;
    const out={};
    for(const {tablename} of tables) {
      assert.match(tablename,/^[a-z0-9_]+$/);
      const rows=(await owner.query(`SELECT row_to_json(t)::text r FROM hon."${tablename}" t ORDER BY 1`)).rows;
      out[tablename]=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    }
    return out;
  };
  const before=await snapshot();
  const module=await Test.createTestingModule({controllers:[ZernioIntegrationController],providers:[ZernioIntegrationService,ZernioHumanUiGuard,HonIdentityService,
    {provide:RuntimeDatabaseService,useValue:database},{provide:ZERNIO_RUNTIME,useValue:fake}]}).compile();
  app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');
  const origin=`http://127.0.0.1:${app.getHttpServer().address().port}`;process.env.HON_PUBLIC_ORIGIN=origin;
  const confirmation={confirmation:contracts.ZERNIO_VERIFY_CONFIRMATION};
  let r=await send(origin,'configuration');assert.equal(r.status,200);assert.match(r.headers['cache-control'],/no-store/);
  assert.deepEqual(JSON.parse(r.body),{data:contracts.validateZernioConfiguration(fake.configuration())});assert.equal(calls,0);
  pass('signed owner reads minimized configuration through the actual least-privilege HQ resolver, without provider activity');
  for(const args of [{who:null},{expired:true},{forged:true}]) {r=await send(origin,'configuration',args);assert.equal(r.status,401);assert(!r.body.includes('API_SERVER_ENVIRONMENT'));}
  pass('missing, expired and forged signed sessions fail with 401 and no configuration');
  for(const who of ['operator','support','school','nonhuman','inactive','expired-grant']) {
    for(const [path,method] of [['configuration','GET'],['verify','POST']]) {
      r=await send(origin,path,{who,method,body:method==='POST'?confirmation:undefined});assert.equal(r.status,403,who);assert(!r.body.includes('API_SERVER_ENVIRONMENT'));
    }
  }
  assert.equal(calls,0);pass('operator/support even with permission codes, school, nonhuman, inactive and expired HQ authority are denied by real database state');
  r=await send(origin,'verify',{method:'POST',body:confirmation});assert.equal(r.status,503);assert.equal(calls,0);
  pass('shipped verification gate stays disabled; explicit verification is unavailable without a separately authorized synthetic gate');
  enabled=true;
  for(const args of [{patch:{origin:'https://evil.invalid'}},{patch:{'x-hon-school-id':randomUUID()}},{body:{...confirmation,schoolId:randomUUID()}}]) {
    r=await send(origin,'verify',{method:'POST',body:confirmation,...args});assert([400,403].includes(r.status));
  }
  assert.equal((await send(origin,'configuration?schoolId='+randomUUID())).status,400);assert.equal(calls,0);
  pass('selector, forged school and cross-origin requests cannot confer platform authority or reach the fake provider');
  r=await send(origin,'verify',{method:'POST',body:confirmation});assert.equal(r.status,200);contracts.validateZernioVerification(JSON.parse(r.body).data);assert.equal(calls,1);
  pass('explicit authorized synthetic verification returns only the closed receipt, with zero real provider calls');
  wait=deferred();started=deferred();const pending=send(origin,'verify',{method:'POST',body:confirmation});await started.promise;
  assert.equal((await send(origin,'verify',{method:'POST',body:confirmation})).status,409);
  await owner.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp()-interval '1 hour' WHERE principal_id=$1",[actors.owner.principal]);
  wait.resolve();r=await pending;assert.equal(r.status,403);assert(!r.body.includes('checkedAt'));assert.equal(calls,2);
  assert.equal((await send(origin,'configuration')).status,403);
  pass('concurrent verification is refused and post-wait HQ revocation withholds the result through the real live resolver');
  wait=null;started=null;
  await owner.query('UPDATE hon.hq_operator_grants SET effective_until=NULL WHERE principal_id=$1',[actors.owner.principal]);
  r=await send(origin,'verify',{method:'POST',body:confirmation});assert.equal(r.status,200);assert.equal(calls,3);
  pass('settlement releases request ownership after revocation, permitting only a new explicit authorized check');
  enabled=false;assert.deepEqual(await snapshot(),before);
  assert.equal(process.env.HON_ZERNIO_VERIFICATION_APPROVED,undefined);assert.equal(process.env.ZERNIO_API_KEY,undefined);
  pass('all HON business tables including audit/outbox/idempotency/entitlements/credits remain unchanged; fixture-only grants excluded');
  console.log(`All ${checks.length} Zernio signed-session/disposable PostgreSQL scenario groups passed. Real provider calls: 0.`);
} finally {
  if(wait)wait.resolve();
  try {
    // Nest owns the injected RuntimeDatabaseService once the app exists and
    // app.close() invokes its onModuleDestroy hook. Only close it directly if
    // setup failed before that ownership transfer; never end its pool twice.
    if(app)await app.close();
    else await database.onModuleDestroy();
  } finally {
    // The fixture owner client is outside Nest and always belongs to this harness.
    await owner.end();
  }
}
})().catch(error=>{console.error(error);process.exitCode=1;});
