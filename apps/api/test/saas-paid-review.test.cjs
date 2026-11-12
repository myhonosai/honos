const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID:K}=require('node:crypto'),{request}=require('node:http');
require('reflect-metadata');
const c=require('@hon/contracts');
const {Test}=require('@nestjs/testing'),{json}=require('express');
const {SaasPaidReviewHqController}=require('../dist/saas-paid-review/saas-paid-review.controller.js');
const {SaasPaidReviewService}=require('../dist/saas-paid-review/saas-paid-review.service.js');
const {SaasBillingService}=require('../dist/saas-billing/saas-billing.service.js');
const {SaasCommandGuard,SaasReadGuard}=require('../dist/saas-billing/saas-billing.guards.js');
const {HonIdentityGuard}=require('../dist/foundation/hon-identity.guard.js');
const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');

const resolution=(status='AWAITING_REFUND_EVIDENCE')=>({resolutionId:K(),subjectKind:'SCHEDULE_BINDING',subjectId:K(),organizationId:K(),decision:'REFUND_OWED',status,
  version:status==='REFUND_VERIFIED'?2:1,heldItemCount:1,heldAmountMinor:24900,reason:'Fixture held payment owed back',
  refundedAmountMinor:status==='REFUND_VERIFIED'?24900:null,refundEvidence:status==='REFUND_VERIFIED'?['evt_refund_1']:[],createdAt:'2031-01-01T00:00:00.000Z',
  refundVerifiedAt:status==='REFUND_VERIFIED'?'2031-01-02T00:00:00.000Z':null,providerActionExecuted:false});
const item=(patch={})=>({subjectKind:'SCHEDULE_BINDING',subjectId:K(),subjectVersion:4,organizationId:K(),schoolId:K(),billingStatus:'NEEDS_REVIEW',reason:'AMOUNT_MISMATCH',
  heldItemCount:1,heldAmountMinor:24901,refundedAmountMinor:0,fullyRefunded:false,receivedAt:'2031-01-01T00:00:00.000Z',blocker:null,allowedDecisions:['REFUND_OWED'],
  accessRetryAvailable:false,openResolution:null,providerActionExecuted:false,...patch});
const resolveBody=()=>({subjectKind:'SCHEDULE_BINDING',subjectId:K(),expectedVersion:4,decision:'REFUND_OWED',reason:'Fixture held payment owed back',confirmation:c.SAAS_PAID_REVIEW_RESOLVE_CONFIRMATION});

test('0237 paid review: closed command inputs refuse provider actions, caller authority and unknown keys',()=>{
  const ok=resolveBody();assert(Object.isFrozen(c.validateSaasPaidReviewResolveInput(ok)));
  for(const patch of [{subjectKind:'SUBSCRIPTION'},{subjectId:'x'},{expectedVersion:0},{decision:'REFUND_NOW'},{reason:'short'},{reason:' padded reason here '},{confirmation:'REFUND'},{organizationId:K()},{executeRefund:true},{amountMinor:1}])
    assert.throws(()=>c.validateSaasPaidReviewResolveInput({...ok,...patch}),JSON.stringify(patch));
  assert.deepEqual(c.validateSaasPaidReviewVerifyInput({expectedVersion:1,confirmation:c.SAAS_PAID_REVIEW_VERIFY_CONFIRMATION}),{expectedVersion:1,confirmation:c.SAAS_PAID_REVIEW_VERIFY_CONFIRMATION});
  for(const bad of [{expectedVersion:1},{expectedVersion:1,confirmation:'YES'},{expectedVersion:1,confirmation:c.SAAS_PAID_REVIEW_VERIFY_CONFIRMATION,refundedAmountMinor:1}])assert.throws(()=>c.validateSaasPaidReviewVerifyInput(bad));
  assert.equal(c.validateSaasPaidReviewCursor(undefined),null);
  for(const bad of ['x','2031-01-01T00:00:00.000Z~'+K(),"' OR 1=1"])assert.throws(()=>c.validateSaasPaidReviewCursor(bad));
});

test('0237 paid review: queue and receipts are closed and never claim a provider action',()=>{
  const q={items:[item(),item({blocker:'REVERSAL_POLICY_REQUIRED',allowedDecisions:[]}),item({allowedDecisions:[],openResolution:resolution()})],nextCursor:null,providerActionExecuted:false};
  assert.deepEqual(c.validateSaasPaidReviewQueue(q),q);
  for(const patch of [{providerActionExecuted:true},{extra:1},{nextCursor:'bad'}])assert.throws(()=>c.validateSaasPaidReviewQueue({...q,...patch}));
  for(const patch of [{blocker:'REVERSAL_POLICY_REQUIRED'},{openResolution:resolution()},{allowedDecisions:['ACTIVATE']},{providerActionExecuted:true},{blocker:'UNKNOWN_BLOCKER',allowedDecisions:[]},{refundedAmountMinor:-1},{extra:true}])
    assert.throws(()=>c.validateSaasPaidReviewQueue({...q,items:[item(patch)]}),JSON.stringify(patch));
  const verified={resolution:resolution('REFUND_VERIFIED'),billingStatus:'ACTIVE',billingReviewOpen:false,replayed:false};
  assert.deepEqual(c.validateSaasPaidReviewVerifyReceipt(verified),verified);
  for(const r of [resolution(),{...resolution('REFUND_VERIFIED'),refundedAmountMinor:100},{...resolution('REFUND_VERIFIED'),refundEvidence:[]},{...resolution('REFUND_VERIFIED'),providerActionExecuted:true},{...resolution('REFUND_VERIFIED'),version:1}])
    assert.throws(()=>c.validateSaasPaidReviewVerifyReceipt({...verified,resolution:r}));
});

test('0237 paid review: routes are HQ-only reads and same-origin human commands mapped to the fixed database calls',async()=>{
  const calls=[],receipt={resolution:resolution(),item:item({allowedDecisions:[],openResolution:resolution()}),replayed:false};
  const callSaasBilling=async(op,args)=>{calls.push([op,args]);if(op==='readPaidReviews')return {items:[],nextCursor:null,providerActionExecuted:false};return receipt;};
  const mod=await Test.createTestingModule({controllers:[SaasPaidReviewHqController],providers:[SaasPaidReviewService,SaasBillingService,SaasCommandGuard,SaasReadGuard,{provide:RuntimeDatabaseService,useValue:{callSaasBilling}}]})
    .overrideGuard(HonIdentityGuard).useValue({canActivate(ctx){ctx.switchToHttp().getRequest().honIdentity={externalSubject:'verified-hq'};return true;}}).compile();
  const app=mod.createNestApplication({bodyParser:false});app.use(json({strict:true}));app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');
  const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/hq/saas/paid-reviews`;
  const send=(url,{method='GET',headers={},body}={})=>new Promise((yes,no)=>{const q=request(url,{method,headers},r=>{let t='';r.on('data',v=>t+=v);r.on('end',()=>yes({status:r.statusCode,body:t,headers:r.headers}));});q.on('error',no);q.end(body);});
  const human=command=>({'content-type':'application/json',origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':command,'idempotency-key':K()});
  const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';
  try {
    const list=await send(base,{headers:{'sec-fetch-site':'same-origin'}});assert.equal(list.status,200,list.body);assert.match(list.headers['cache-control']??'',/no-store/);
    assert.equal((await send(base+'?cursor=bad',{headers:{'sec-fetch-site':'same-origin'}})).status,400);
    const body=JSON.stringify(resolveBody());
    assert.equal((await send(base+'/resolve',{method:'POST',headers:{...human(c.SAAS_COMMANDS.resolvePaidReview),'x-hon-human-command':'other'},body})).status,403);
    const resolved=await send(base+'/resolve',{method:'POST',headers:human(c.SAAS_COMMANDS.resolvePaidReview),body});assert.equal(resolved.status,200,resolved.body);
    const rid=K(),verify=await send(`${base}/${rid}/verify-refund`,{method:'POST',headers:human(c.SAAS_COMMANDS.verifyPaidReviewRefund),body:JSON.stringify({expectedVersion:1,confirmation:c.SAAS_PAID_REVIEW_VERIFY_CONFIRMATION})});
    assert.notEqual(verify.status,404);
    assert.deepEqual(calls.map(x=>x[0]),['readPaidReviews','resolvePaidReview','verifyPaidReviewRefund']);
    assert.deepEqual(calls[0][1],['verified-hq',null]);assert.equal(calls[2][1][1],rid);
  } finally { if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old; await app.close(); }
});
