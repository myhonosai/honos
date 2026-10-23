/** Actual frontend transport -> signed-session Nest controllers -> marked disposable PostgreSQL. No identity/API mocks. */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {issueSession,HON_SESSION_COOKIE} from '@hon/auth';
import {syntheticSetInput} from './fixtures/hq-offers.mjs';
assert.equal(process.env.HON_PRICING_API_TEST,'1');
const ownerUrl=new URL(process.env.DATABASE_URL??''),runtimeUrl=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
assert.equal(ownerUrl.hostname,'localhost');assert.equal(ownerUrl.port,'5432');assert.equal(ownerUrl.pathname,'/hon_champions_validation');assert.equal(ownerUrl.username,'hon_champions_owner');
assert.equal(runtimeUrl.hostname,'localhost');assert.equal(runtimeUrl.port,'5432');assert.equal(runtimeUrl.pathname,ownerUrl.pathname);assert.equal(runtimeUrl.username,'hon_champions_runtime');
assert(Object.keys(process.env).every(key=>!/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)),'No provider credentials or execution flags');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),apiRequire=createRequire(resolve(root,'apps/api/package.json')),webRequire=createRequire(resolve(root,'apps/web/package.json')),dbRequire=createRequire(resolve(root,'packages/database/package.json'));
apiRequire('reflect-metadata');const {Test}=apiRequire('@nestjs/testing'),pg=dbRequire('pg'),ts=webRequire('typescript');
const load=p=>import(pathToFileURL(resolve(root,'apps/api/dist',p)).href);
const {RuntimeDatabaseService}=await load('foundation/runtime-database.service.js'),{HonIdentityService}=await load('foundation/hon-identity.service.js'),{HonIdentityGuard}=await load('foundation/hon-identity.guard.js');
const {IdentityController}=await load('foundation/identity.controller.js'),{HqController}=await load('hq/hq.controller.js'),{HqOverviewService}=await load('hq/hq-overview.service.js'),{HqSchoolDirectoryService}=await load('hq/hq-school-directory.service.js');
const {SaasOffersHqController}=await load('saas-billing/saas-offers.controller.js'),{SaasBillingService}=await load('saas-billing/saas-billing.service.js'),{SaasCommandGuard,SaasReadGuard}=await load('saas-billing/saas-billing.guards.js');
const database=new RuntimeDatabaseService(),owner=new pg.Client({connectionString:ownerUrl.toString(),ssl:false}),session={mode:'OIDC',audience:'hon-pricing-disposable-api',secret:randomBytes(32).toString('hex')};
process.env.HON_AUTH_MODE=session.mode;process.env.HON_SESSION_AUDIENCE=session.audience;process.env.HON_SESSION_JWT_SECRET=session.secret;
const originalFetch=globalThis.fetch;let app,actor='owner',loseNext=false,posts=[];const checks=[];
const pass=name=>{checks.push(name);console.log('PASS '+name);};
try{
  await owner.connect();const marker=(await owner.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker,{owner:'hon_champions_owner',marker:'HON disposable Champions Club validation'});
  const sql=(q,v=[])=>owner.query(q,v),actors={};
  for(const who of ['owner','operator','support','school']){
    const user=randomUUID(),principal=randomUUID(),subject='pricing-http-'+who+'-'+randomUUID();actors[who]={user,principal,subject};
    await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Synthetic pricing user')",[user,subject,`${user}@example.test`]);
    await sql("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Synthetic principal',true)",[principal,user]);
    if(who!=='school')await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[principal,who==='owner'?'HON_HQ_OWNER':who==='operator'?'HON_HQ_OPERATOR':'HON_HQ_SUPPORT',['hq.billing.manage','hq.dashboard.view']]);
  }
  const org=randomUUID(),school=randomUUID(),role=randomUUID();
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic dojo','Synthetic dojo')",[org]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')",[org]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic school',$1::text)",[school,org]);
  await sql("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'SYNTHETIC_PURCHASER','Synthetic purchaser')",[role,org]);
  await sql("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.hon.purchase')",[role,org]);
  await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)",[org,school,actors.school.principal,role]);
  const module=await Test.createTestingModule({controllers:[IdentityController,HqController,SaasOffersHqController],providers:[HonIdentityService,HonIdentityGuard,HqOverviewService,HqSchoolDirectoryService,SaasBillingService,SaasCommandGuard,SaasReadGuard,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
  app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');const origin=`http://127.0.0.1:${app.getHttpServer().address().port}`;process.env.HON_PUBLIC_ORIGIN=origin;
  const contractsUrl=pathToFileURL(webRequire.resolve('@hon/contracts')).href;
  async function compile(path,replacements={}){let code=ts.transpileModule(await readFile(resolve(root,path),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
    code=code.replace(/from\s+['"]@hon\/contracts['"]/g,'from '+JSON.stringify(contractsUrl));for(const[from,to]of Object.entries(replacements))code=code.replace('from '+JSON.stringify(from),'from '+JSON.stringify(to)).replace("from '"+from+"'",'from '+JSON.stringify(to));return 'data:text/javascript;base64,'+Buffer.from(code).toString('base64');}
  const overviewUrl=await compile('apps/web/src/components/hq-overview-http.ts');const http=await import(await compile('apps/web/src/components/hq-modern/pricing-offers-http.ts',{'../hq-overview-http':overviewUrl}));
  globalThis.fetch=async(path,options)=>{
    assert.match(path,/^\/api\/v1\/(?:identity\/me|hq\/overview|hq\/saas\/offers(?:\/sets(?:\/[a-f0-9-]+(?:\/(?:revise|discard|publish))?)?|\/[a-f0-9-]+\/stop-sales)?)$/);
    const headers=new Headers(options.headers);headers.set('Origin',origin);headers.set('Sec-Fetch-Site','same-origin');headers.set('Sec-Fetch-Mode','same-origin');headers.set('Sec-Fetch-Dest','empty');
    if(actor)headers.set('Cookie',`${HON_SESSION_COOKIE}=${issueSession({externalSubject:actors[actor].subject},session)}`);
    const response=await originalFetch(origin+path.slice(4),{...options,headers});
    if(options.method==='POST'){posts.push({path,body:options.body,key:headers.get('Idempotency-Key'),status:response.status});if(loseNext&&response.status===200){loseNext=false;throw new DOMException('Synthetic lost response after real commit','TimeoutError');}}
    return response;
  };
  const tables=['organization_entitlements','saas_catalog_versions','saas_subscriptions','saas_subscription_history','saas_invoices','saas_payment_evidence','saas_checkout_sessions','saas_credit_allowances','saas_credit_ledger','saas_access_program','saas_access_states','saas_payment_program'];
  const snapshot=async()=>{const out={};for(const table of tables)out[table]=(await sql(`SELECT to_jsonb(t)::text r FROM hon.${table} t ORDER BY 1`)).rows;return out;};const before=await snapshot();
  const access=await http.readPricingAccess();assert(access.owner);const input=syntheticSetInput(),subject=actors.owner.subject;
  const create=http.preparePricingRequest('create',null,input,randomUUID(),subject);let receipt=await http.sendPricingRequest(create);const id=receipt.data.set.setId;assert.equal(receipt.data.set.offers.length,6);assert(!receipt.data.replayed);pass('signed owner saves a real six-offer backend draft through the frontend transport');
  const revised={expectedRevision:1,termsReference:input.termsReference,founderTotalLimit:input.founderTotalLimit,offers:input.offers.map((o,i)=>i?o:{...o,priceMinor:33333})};
  const revise=http.preparePricingRequest('revise',id,revised,randomUUID(),subject);loseNext=true;await assert.rejects(http.sendPricingRequest(revise),e=>e.code==='UNKNOWN'&&e.uncertain);
  const beforeReplay=(await sql('SELECT count(*)::int n FROM hon.saas_requests')).rows[0].n;receipt=await http.sendPricingRequest(revise,true);assert(receipt.data.replayed);assert.equal(receipt.data.set.revision,2);assert.equal((await sql('SELECT count(*)::int n FROM hon.saas_requests')).rows[0].n,beforeReplay);
  assert.equal(posts.at(-1).body,posts.at(-2).body);assert.equal(posts.at(-1).key,posts.at(-2).key);pass('lost post-commit response retries the identical body/key exactly once without another request record');
  await assert.rejects(http.sendPricingRequest(http.preparePricingRequest('revise',id,{...revised,expectedRevision:1},randomUUID(),subject)),e=>e.code==='SAAS_VERSION_CONFLICT');
  const detail=await http.readPricingSet(id),publish=http.preparePricingRequest('publish',id,{expectedRevision:2,previewDigest:detail.preview.previewDigest,approval:'APPROVE_FOR_NEW_PURCHASES_ONLY'},randomUUID(),subject);
  const direct=async(who,request)=>originalFetch(origin+(request.kind==='stop'?'/v1/hq/saas/offers/'+request.target+'/stop-sales':'/v1/hq/saas/offers/sets/'+request.target+'/'+request.kind),{method:'POST',mode:'same-origin',headers:{'Content-Type':'application/json','Origin':origin,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'same-origin','Sec-Fetch-Dest':'empty','X-HON-Human-Command':request.kind==='stop'?'saas-offer-sales-stop':'saas-offer-set-'+request.kind,'Idempotency-Key':request.key,'Cookie':`${HON_SESSION_COOKIE}=${issueSession({externalSubject:actors[who].subject},session)}`},body:request.body});
  assert.equal((await direct('operator',publish)).status,403);assert.equal((await direct('school',publish)).status,403);
  actor='operator';assert(!(await http.readPricingAccess()).owner);await assert.rejects(http.sendPricingRequest({...publish,subject:actors.operator.subject}),e=>e.code==='FORBIDDEN');
  for(const who of ['support','school',null]){actor=who;await assert.rejects(http.readPricingAccess());}actor='owner';pass('operator writes, support/school billing access and absent sessions are independently refused');
  const stale=http.preparePricingRequest('publish',id,{expectedRevision:2,previewDigest:'0'.repeat(64),approval:'APPROVE_FOR_NEW_PURCHASES_ONLY'},randomUUID(),subject);
  await assert.rejects(http.sendPricingRequest(stale),e=>e.code==='SAAS_OFFER_PREVIEW_CHANGED');
  receipt=await http.sendPricingRequest(publish);assert.equal(receipt.data.set.status,'PUBLISHED');const publishedSnapshot=structuredClone(receipt.data.set.offers);
  await assert.rejects(http.sendPricingRequest(http.preparePricingRequest('revise',id,{...revised,expectedRevision:2},randomUUID(),subject)),e=>e.code==='SAAS_OFFER_SET_NOT_DRAFT');pass('publication requires the actual server digest; published configuration is not editable');
  const next=http.preparePricingRequest('create',null,{...input,basedOnSetId:id,offers:input.offers.map(o=>({...o,priceMinor:o.priceMinor+123}))},randomUUID(),subject),newSet=(await http.sendPricingRequest(next)).data.set;
  const newPreview=await http.readPricingSet(newSet.setId);await http.sendPricingRequest(http.preparePricingRequest('publish',newSet.setId,{expectedRevision:newSet.revision,previewDigest:newPreview.preview.previewDigest,approval:'APPROVE_FOR_NEW_PURCHASES_ONLY'},randomUUID(),subject));
  assert.equal((await http.readPricingSet(id)).set.status,'RETIRED');assert.deepEqual((await http.readPricingSet(id)).set.offers,publishedSnapshot);pass('new prices create a different set; the retired version keeps its exact published terms');
  const stop=http.preparePricingRequest('stop',newSet.offers[0].offerId,{reasonCode:'TERMS_REVIEW'},randomUUID(),subject);const stopped=await http.sendPricingRequest(stop);assert.equal(stopped.data.offer.salesStop.reasonCode,'TERMS_REVIEW');assert(!(await http.readPricingAccess()).management.onSaleOfferIds.includes(newSet.offers[0].offerId));
  const discardId=(await http.sendPricingRequest(http.preparePricingRequest('create',null,input,randomUUID(),subject))).data.set.setId;await http.sendPricingRequest(http.preparePricingRequest('discard',discardId,{expectedRevision:1},randomUUID(),subject));assert.equal((await http.readPricingSet(discardId)).set.status,'DISCARDED');pass('stop-sales and discard keep authoritative lifecycle/history evidence');
  const countBefore=(await sql('SELECT count(*)::int n FROM hon.saas_requests')).rows[0].n;
  await sql("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp()-interval '1 second' WHERE principal_id=$1",[actors.owner.principal]);
  await assert.rejects(http.sendPricingRequest(stop,true),e=>e.code==='FORBIDDEN');assert.equal((await direct('owner',stop)).status,403);assert.equal((await sql('SELECT count(*)::int n FROM hon.saas_requests')).rows[0].n,countBefore);pass('live grant expiration refuses even retained idempotency replay');
  assert.deepEqual(await snapshot(),before);pass('subscriptions, historical prices, invoices, payments, checkout, entitlements, credits and paid access remain byte-identical');
  console.log(JSON.stringify({checks:checks.length,realSignedSession:true,realPostgreSQL:true,mockedIdentity:false,mockedApi:false,providerCalls:0,financialActivation:false}));
}finally{globalThis.fetch=originalFetch;try{if(app)await app.close();else await database.onModuleDestroy();}finally{await owner.end();}}
