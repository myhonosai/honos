const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { request } = require('node:http');
const { issueSession, sessionConfig, HON_SESSION_COOKIE } = require('@hon/auth');
const c = require('@hon/contracts');
const { ZernioCredentialRuntime, ZERNIO_RUNTIME } = require('../dist/integrations/zernio-runtime.js');
const { ZernioIntegrationService } = require('../dist/integrations/zernio.service.js');
const { ZernioIntegrationController, ZernioHumanUiGuard } = require('../dist/integrations/zernio.controller.js');
const { HonIdentityService } = require('../dist/foundation/hon-identity.service.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const fakeKey = 'sk_' + 'a'.repeat(64);
const enabled = () => ({ ZERNIO_API_KEY: fakeKey, HON_ZERNIO_VERIFICATION_APPROVED: 'true' });
const confirmation = { confirmation: c.ZERNIO_VERIFY_CONFIRMATION };
const owner = { principalId: 'synthetic-owner', hqRole: 'HON_HQ_OWNER' };
const delay = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('Zernio closed browser contracts reject credentials, tenant/role claims and false connected/action states', () => {
  const config = new ZernioCredentialRuntime(() => ({})).configuration();
  assert(c.validateZernioConfiguration(config));
  for (const patch of [{ key: fakeKey }, { connected: true }, { schoolId: 'another-school' },
    { externalActions: 'ENABLED' }, { schoolConnections: 'CONNECTED' }, { credential: 'VALID' }, { verificationEnabled: true }]) {
    assert.throws(() => c.validateZernioConfiguration({ ...config, ...patch }));
  }
  for (const patch of [{ key: fakeKey }, { role: 'OWNER' }, { schoolId: 'x' }, { confirmation: 'PUBLISH' }]) {
    assert.throws(() => c.validateZernioConfirmation({ ...confirmation, ...patch }));
  }
});

test('Zernio configuration and missing/invalid/disabled keys never make provider calls', async () => {
  for (const env of [{}, { ZERNIO_API_KEY: fakeKey }, { ...enabled(), HON_ZERNIO_VERIFICATION_APPROVED: '1' },
    { ...enabled(), ZERNIO_API_KEY: 'Bearer ' + fakeKey }, { ...enabled(), ZERNIO_API_KEY: fakeKey+'\n' }]) {
    let calls = 0;
    const runtime = new ZernioCredentialRuntime(() => env, async () => { ++calls; throw Error('forbidden'); });
    const config = runtime.configuration(); assert.equal(config.verificationEnabled, false);
    assert(!JSON.stringify(config).includes(fakeKey)); assert.equal(await runtime.verifyCredential(), 'UNAVAILABLE'); assert.equal(calls, 0);
  }
});

test('Zernio verification uses only the documented fixed credential GET and strips provider PII', async () => {
  let calls = 0;
  const runtime = new ZernioCredentialRuntime(enabled, async (url, options) => {
    ++calls; assert.equal(url, 'https://zernio.com/api/v1/auth/verify');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.body, undefined); assert.equal(options.headers.Authorization, `Bearer ${fakeKey}`);
    return new Response(JSON.stringify({ valid: true, userId: 'private-id', name: 'Private', email: 'private@example.invalid', scope: 'posts:write', token: fakeKey }), { headers: { 'Content-Type': 'application/json' } });
  });
  assert.equal(await runtime.verifyCredential(), 'VALID'); assert.equal(calls, 1);
  assert.equal(runtime.configuration().schoolConnections, 'NOT_CONFIGURED');
});

for (const [status, result] of [[401,'REJECTED'],[403,'DENIED'],[429,'RATE_LIMITED'],[503,'UNAVAILABLE'],[302,'UNAVAILABLE'],[207,'UNAVAILABLE']]) {
  test(`Zernio ${status} remains ${result}; never retries or exposes raw errors`, async () => {
    let calls = 0; const runtime = new ZernioCredentialRuntime(enabled, async () => {
      ++calls; return new Response(fakeKey, { status });
    });
    assert.equal(await runtime.verifyCredential(), result); assert.equal(calls,1);
  });
}

for (const body of ['{', 'null', '[]', '{"valid":"true"}', '{}', 'x'.repeat(8193)]) {
  test(`Zernio refuses malformed/oversized response (${body.length} bytes)`, async () => {
    const runtime = new ZernioCredentialRuntime(enabled, async () => new Response(body, { headers: { 'content-type':'application/json' } }));
    assert.equal(await runtime.verifyCredential(), 'UNKNOWN');
  });
}

test('Zernio transport exceptions and HTML cannot leak secrets or masquerade as verification', async () => {
  const runtime = new ZernioCredentialRuntime(enabled, async () => { throw new Error(fakeKey); });
  assert.equal(await runtime.verifyCredential(), 'UNKNOWN');
  const html = new ZernioCredentialRuntime(enabled, async () => new Response('<html>ok</html>', { headers: { 'content-type':'text/html' } }));
  assert.equal(await html.verifyCredential(), 'UNKNOWN');
});

test('Zernio key rotation or verification-gate revocation during a check invalidates its result', async () => {
  for (const field of ['ZERNIO_API_KEY','HON_ZERNIO_VERIFICATION_APPROVED']) {
    const env=enabled(),pending=delay(); const runtime = new ZernioCredentialRuntime(() => env, () => pending.promise);
    const run=runtime.verifyCredential();env[field]='changed';pending.resolve(new Response('{"valid":true}',{headers:{'content-type':'application/json'}}));
    assert.equal(await run,'UNKNOWN');
  }
});
test('Zernio timeout aborts the sole read attempt without retrying or exposing a transport error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });let calls=0;
  const runtime=new ZernioCredentialRuntime(enabled,async (url,{signal})=>{++calls;return new Promise((accept,reject)=>signal.addEventListener('abort',()=>reject(Error(fakeKey)),{once:true}));});
  try {const result=runtime.verifyCredential();t.mock.timers.tick(8000);assert.equal(await result,'UNKNOWN');assert.equal(calls,1);}
  finally {t.mock.timers.reset();}
});

test('Zernio school owners, operators, support, revoked grants and missing HQ scopes are denied before configuration', async () => {
  for (const scope of [undefined,{...owner,hqRole:'HON_HQ_OPERATOR'},{...owner,hqRole:'HON_HQ_SUPPORT'}]) {
    let reads=0,calls=0;
    const service=new ZernioIntegrationService({ async resolveHqOperatorScope(subject,permission) {
      assert.equal(subject,'verified-session-subject');assert.equal(permission,'hq.integrations.zernio.read');return scope;
    } }, { configuration(){++reads;return {};},async verifyCredential(){++calls;return 'VALID';} });
    await assert.rejects(service.configuration('verified-session-subject'),e=>e.getStatus()===403);
    await assert.rejects(service.verify('verified-session-subject',confirmation),e=>e.getStatus()===403);
    assert.equal(reads,0);assert.equal(calls,0);
  }
});

test('Zernio rejects extra fields and disabled verification before network', async () => {
  let calls=0;const service=new ZernioIntegrationService({async resolveHqOperatorScope(){return owner;}},
    {configuration:()=>new ZernioCredentialRuntime(()=>({})).configuration(),async verifyCredential(){++calls;return 'VALID';}});
  await assert.rejects(service.verify('owner',{...confirmation,key:fakeKey}),e=>e.getStatus()===400);
  await assert.rejects(service.verify('owner',confirmation),e=>e.getStatus()===503);
  assert.equal(calls,0);
});

test('Zernio concurrent checks are refused, live authority is rechecked after waiting and busy state settles', async () => {
  const pending=delay();let allowed=true,calls=0;
  const service=new ZernioIntegrationService({async resolveHqOperatorScope(){return allowed?owner:undefined;}},
    {configuration:()=>new ZernioCredentialRuntime(enabled).configuration(),async verifyCredential(){++calls;return pending.promise;}});
  const first=service.verify('owner',confirmation);await Promise.resolve();await Promise.resolve();
  await assert.rejects(service.verify('owner',confirmation),e=>e.getStatus()===409);allowed=false;pending.resolve('VALID');
  await assert.rejects(first,e=>e.getStatus()===403);assert.equal(calls,1);
  allowed=true;const receipt=await service.verify('owner',confirmation);assert(c.validateZernioVerification(receipt));
  assert(!JSON.stringify(receipt).includes(fakeKey));assert.equal(receipt.externalActions,'DISABLED');
});

async function fixture() {
  process.env.HON_AUTH_MODE='OIDC';process.env.HON_SESSION_JWT_SECRET='synthetic-zernio-test-secret-long-enough-only';
  process.env.HON_SESSION_AUDIENCE='synthetic-hon-zernio';process.env.HON_PUBLIC_ORIGIN='https://hon.example';
  let calls=0,allowed=true;
  const mod=await Test.createTestingModule({controllers:[ZernioIntegrationController],providers:[ZernioIntegrationService,ZernioHumanUiGuard,HonIdentityService,
    {provide:RuntimeDatabaseService,useValue:{async resolveHqOperatorScope(subject){return allowed&&subject==='owner'?owner:undefined;}}},
    {provide:ZERNIO_RUNTIME,useValue:{configuration:()=>new ZernioCredentialRuntime(enabled).configuration(),async verifyCredential(){++calls;return 'VALID';}}}]}).compile();
  const app=mod.createNestApplication({bodyParser:false});app.use(json({strict:true}));app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');
  const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/integrations/zernio`;
  const cookie=(subject='owner',expired=false)=>`${HON_SESSION_COOKIE}=${issueSession({externalSubject:subject},sessionConfig(),Math.floor(Date.now()/1000)-(expired?43201:0))}`;
  const headers=()=>({cookie:cookie(),origin:'https://hon.example','content-type':'application/json','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':'zernio-credential-verify'});
  return {app,base,cookie,headers,calls:()=>calls,revoke:()=>{allowed=false;}};
}
function send(url,{method='GET',headers={},body}={}) {return new Promise((accept,reject)=>{const req=request(url,{method,headers},res=>{
  let text='';res.on('data',v=>text+=v);res.on('end',()=>accept({status:res.statusCode,body:text,headers:res.headers}));});req.on('error',reject);req.end(body);});}

test('Zernio HTTP signed-session owner reads configuration and explicitly verifies without exposing keys', async () => {
  const f=await fixture();try {
    const get=await send(f.base+'/configuration',{headers:{cookie:f.cookie()}});assert.equal(get.status,200);
    assert(c.validateZernioConfiguration(JSON.parse(get.body).data));assert.equal(f.calls(),0);assert.match(get.headers['cache-control'],/no-store/);
    const check=await send(f.base+'/verify',{method:'POST',headers:f.headers(),body:JSON.stringify(confirmation)});
    assert.equal(check.status,200);assert(c.validateZernioVerification(JSON.parse(check.body).data));assert.equal(f.calls(),1);assert(!check.body.includes(fakeKey));
    assert.equal((await send(f.base+'/verify',{method:'POST',headers:f.headers(),body:JSON.stringify({...confirmation,key:fakeKey})})).status,400);
    assert.equal(f.calls(),1);
  } finally {await f.app.close();}
});
test('Zernio HTTP expired/forged/missing sessions and non-HQ identities fail closed', async () => {
  const f=await fixture();try {
    for(const cookie of [undefined,'hon_session=forged',f.cookie('owner',true),f.cookie('school-owner')]){
      const r=await send(f.base+'/configuration',{headers:cookie?{cookie}:{}});assert([401,403].includes(r.status));assert(!r.body.includes(fakeKey));
    }
    f.revoke();assert.equal((await send(f.base+'/configuration',{headers:{cookie:f.cookie()}})).status,403);assert.equal(f.calls(),0);
  } finally {await f.app.close();}
});
test('Zernio HTTP rejects cross-origin actions, selector queries and credential headers', async () => {
  const f=await fixture();try {
    assert.equal((await send(f.base+'/configuration?schoolId=foreign',{headers:{cookie:f.cookie()}})).status,400);
    assert.equal((await send(f.base+'/configuration',{headers:{cookie:f.cookie(),authorization:`Bearer ${fakeKey}`}})).status,403);
    for(const patch of [{origin:'https://evil.invalid'},{'sec-fetch-site':'cross-site'},{'x-hon-human-command':'publish'},{'x-hon-school-id':'foreign'}]) {
      assert.equal((await send(f.base+'/verify',{method:'POST',headers:{...f.headers(),...patch},body:JSON.stringify(confirmation)})).status,403);
    }
    assert.equal(f.calls(),0);
  } finally {await f.app.close();}
});
