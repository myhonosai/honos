const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { Test } = require('@nestjs/testing');
const { ValidationPipe, ForbiddenException } = require('@nestjs/common');
const contract = require('@hon/contracts');
const { MarketplaceService } = require('../dist/marketplace/marketplace.service.js');
const { MarketplaceController } = require('../dist/marketplace/marketplace.controller.js');
const { MarketplaceHumanUiGuard } = require('../dist/marketplace/marketplace.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const scope={organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID()};
const context=(patch={})=>({...scope,externalSubject:'verified-human',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...patch});
const input=(patch={})=>({expectedVersion:0,title:'General planning blueprint',category:'OPERATIONS',assetKind:'BLUEPRINT',targetModule:'WORK_ITEMS',requiredPermissions:['work_item.read'],releaseNotes:'General descriptive release',previewText:'A general owner planning checklist.',status:'DRAFT',...patch});
const asset=(patch={})=>{const {expectedVersion,...fields}=input();return {id:randomUUID(),version:1,...fields,...patch};};
const denied=(work,status)=>assert.rejects(async()=>work(),e=>e.getStatus()===status);
test('marketplace closed metadata and projection deny sensitive/executable/import/purchase fields',()=>{
 contract.validateMarketplaceInput(input());
 for(const p of [{studentId:randomUUID()},{customer:{name:'PRIVATE'}},{url:'https://test.example'},{attachments:[]},{code:'apply'},{configuration:{}},{payload:{}},{provider:'x'},{price:1},{permissions:['action.execute']},{previewText:'a@school.test'},{previewText:'example.com'},{previewText:'password abc'},{previewText:'const x = 1;'},{previewText:'{"a":1}'},{previewText:'function apply()'},{previewText:'curl endpoint'},{previewText:'1234567890'},{releaseNotes:'x'.repeat(401)},{requiredPermissions:[]},{requiredPermissions:['work_item.read','work_item.read']},{requiredPermissions:['work_item.read','work_item.manage']},{targetModule:'AI'},{status:'INSTALLED'}])assert.throws(()=>contract.validateMarketplaceInput(input(p)),JSON.stringify(p));
 const a=asset({status:'PUBLISHED'});contract.verifyMarketplaceAsset(a,true);
 for(const p of [{principalId:scope.principalId},{schoolId:scope.schoolId},{displayName:'PRIVATE'},{body:'PRIVATE'},{history:[]},{previewText:'secret'},{status:'DRAFT'}])assert.throws(()=>contract.verifyMarketplaceAsset({...a,...p},true));
 const s={id:randomUUID(),assetId:a.id,assetVersion:a.version,version:1,status:'REQUIRES_REVIEW',enabled:false,asset:a};contract.verifyMarketplaceSelection(s);contract.verifyMarketplaceSelection({...s,asset:null});
 for(const p of [{enabled:true},{status:'APPLIED'},{configuration:{}},{version:2},{assetVersion:2}])assert.throws(()=>contract.verifyMarketplaceSelection({...s,...p}));
 assert.throws(()=>contract.verifyMarketplaceHistory({id:a.id,items:[{version:1,status:'DRAFT',previewText:'PRIVATE'}],nextBefore:null,executionAllowed:false}));
 assert.throws(()=>contract.verifyMarketplacePage({items:[a],nextAfter:randomUUID(),executionAllowed:false},contract.verifyMarketplaceAsset));
});
test('marketplace service fails before SQL for prohibited contexts and rejects unsafe database projection',async()=>{
 let calls=0;const db={withTenantTransaction:async(c,work)=>{calls++;return work({query:async()=>({rows:[]})});}};const svc=new MarketplaceService(db);
 for(const p of [{source:'AI_TOOL'},{source:'PUBLIC_API'},{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}])await denied(()=>svc.read(context(p),'BROWSE'),403);
 await denied(()=>svc.mutate(context(),'ASSET',null,input({config:{}})),400);assert.equal(calls,0);await denied(()=>svc.mutate(context({idempotencyKey:''}),'ASSET',null,input()),409);
 db.withTenantTransaction=async()=>{throw Object.assign(new Error('PRIVATE secret DATABASE_URL'),{code:'XX000'});};await assert.rejects(()=>svc.read(context(),'ACCESS'),e=>e.getStatus()===503&&!JSON.stringify(e.getResponse()).includes('PRIVATE'));
 db.withTenantTransaction=async(c,work)=>work({query:async(sql)=>({rows:[{data:sql.includes('read_marketplace')?{canBrowse:true,canCreate:true,canSave:true,executionAllowed:false,principalId:'PRIVATE'}:null}]})});await denied(()=>svc.read(context(),'ACCESS'),503);
});
test('marketplace authenticated same-origin closed endpoints do not allow install/purchase/curation',async()=>{
 let writes=0,granted=true;const a=asset();const db={resolveMarketplaceScope:async(subject,school)=>granted&&subject==='verified-human'&&school===scope.schoolId?scope:undefined,withTenantTransaction:async(c,work)=>work({query:async(sql)=>{
  if(sql.includes('mutate_marketplace')){writes++;return{rows:[{data:{result:a,replayed:false}}]};}
  if(sql.includes('read_marketplace'))return{rows:[{data:{canBrowse:true,canCreate:true,canSave:true,executionAllowed:false}}]};return{rows:[]};
 }})};
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const mod=await Test.createTestingModule({controllers:[MarketplaceController],providers:[MarketplaceService,MarketplaceHumanUiGuard,{provide:RuntimeDatabaseService,useValue:db}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(c){const r=c.switchToHttp().getRequest();if(r.headers['x-test-human']!=='verified')throw new ForbiddenException({code:'IDENTITY_REQUIRED'});r.honIdentity={externalSubject:'verified-human'};return true;}}).compile();
 const app=mod.createNestApplication();app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');
 const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/staff/marketplace`,q=`?schoolId=${scope.schoolId}`;const h={'x-test-human':'verified',origin:'https://hon.example','content-type':'application/json','x-hon-human-command':'marketplace','idempotency-key':randomUUID()};
 try{
  assert.equal((await fetch(base+'/access'+q)).status,403);
  const good=await fetch(base+q,{method:'POST',headers:h,body:JSON.stringify(input())});assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'private, no-store');assert.equal(writes,1);
  for(const patch of [{origin:'https://evil.test'},{'x-hon-human-command':'apply'},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'},{'content-type':'text/plain'}])assert.equal((await fetch(base+q,{method:'POST',headers:{...h,...patch},body:JSON.stringify(input())})).status,403);
  for(const patch of [{attachments:[]},{actorId:randomUUID()},{configuration:{}},{previewText:'https://test.example'}])assert.equal((await fetch(base+q,{method:'POST',headers:h,body:JSON.stringify(input(patch))})).status,400);
  assert.equal(writes,1);assert.equal((await fetch(base+'/access'+q+'&organizationId='+scope.organizationId,{headers:h})).status,400);
  for(const endpoint of ['purchase','install','apply','curate','execute','export'])assert.equal((await fetch(base+'/'+a.id+'/'+endpoint+q,{method:'POST',headers:h,body:'{}'})).status,404);
  granted=false;assert.equal((await fetch(base+'/access'+q,{headers:h})).status,403);
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('marketplace implementation has no external/provider/Action Engine or configuration effects',()=>{
 const fs=require('node:fs'),path=require('node:path');const dir=path.join(__dirname,'../src/marketplace');const code=fs.readdirSync(dir).map(x=>readFileSync(path.join(dir,x),'utf8')).join('\n');
 for(const pattern of [/fetch\(/,/ActionEngineService/,/invokeLLM/,/Shopify/i,/stripe/i,/child_process/,/executeAction/,/UPDATE hon\./,/process\.env/])assert(!pattern.test(code),String(pattern));
 const registry=readFileSync(path.join(__dirname,'../../../packages/config/src/marketplace.ts'),'utf8');assert(registry.includes('executionAllowed: false'));assert(!registry.includes('ACTION_REGISTRY'));
});
