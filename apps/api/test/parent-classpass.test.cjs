const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
require('reflect-metadata');
const {ParentClassPassViewService}=require('../dist/families/parent-classpass-view.service.js');
const {ParentClassPassViewController,ParentClassPassReadGuard,rejectParentClassPassInputs}=require('../dist/families/parent-classpass-view.controller.js');
const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');
const scope={principalId:randomUUID(),organizationId:randomUUID(),schoolId:randomUUID(),familyId:randomUUID(),accessLevel:'PRIMARY_GUARDIAN'};
const view={generatedAt:'2026-10-01T00:00:00.000Z',accessLevel:'PRIMARY_GUARDIAN',paymentProviderOutcome:'UNAVAILABLE',children:{items:[],limited:false}};
const req=(patch={})=>({method:'GET',headers:{},originalUrl:'/api/v1/parent/classpass',...patch});
const status=n=>e=>e.getStatus?.()===n;
test('parent ClassPass uses verified subject only and rechecks the live family before and after a projection',async()=>{
 const calls=[];const service=new ParentClassPassViewService({resolveParentJourneyScopes:async(subject)=>{calls.push(['scope',subject]);return[scope];},readParentClassPassView:async(subject)=>{calls.push(['read',subject]);return view;}});
 const result=await service.get('verified');assert.deepEqual(result.data,view);assert.equal(result.meta.requestId,result.meta.correlationId);assert.deepEqual(calls,[['scope','verified'],['scope','verified'],['read','verified'],['scope','verified'],['scope','verified']]);
});
test('parent ClassPass denies absent/ambiguous/viewer/changed scopes and fails safely on malformed or unavailable SQL results',async()=>{
 for(const [scopes,n]of[[[],403],[[scope,scope],409],[[{...scope,accessLevel:'VIEWER'}],403]]){let reads=0;await assert.rejects(()=>new ParentClassPassViewService({resolveParentJourneyScopes:async()=>scopes,readParentClassPassView:async()=>{reads++;}}).get('verified'),status(n));assert.equal(reads,0);}
 let count=0;await assert.rejects(()=>new ParentClassPassViewService({resolveParentJourneyScopes:async()=>[{...scope,familyId:++count>2?randomUUID():scope.familyId}],readParentClassPassView:async()=>view}).get('verified'),status(403));
 for(const raw of[{...view,staff:[]},{...view,paymentProviderOutcome:'SUCCEEDED'},null])await assert.rejects(()=>new ParentClassPassViewService({resolveParentJourneyScopes:async()=>[scope],readParentClassPassView:async()=>raw}).get('verified'),status(503));
 await assert.rejects(()=>new ParentClassPassViewService({resolveParentJourneyScopes:async()=>[scope],readParentClassPassView:async()=>{throw Object.assign(new Error('SQL_SECRET'),{code:'42501'});}}).get('verified'),status(403));
});
test('parent ClassPass exact GET route rejects selectors, bodies and cross-site/authority headers',async()=>{
 const controller=new ParentClassPassViewController({get:async(subject)=>{assert.equal(subject,'verified');return view;}});
 assert.equal(Reflect.getMetadata('path',ParentClassPassViewController),'parent/classpass');assert.equal(Reflect.getMetadata('path',controller.read),'/');
 const headers=Reflect.getMetadata('__headers__',controller.read);assert(headers.some(h=>h.name==='Cache-Control'&&h.value==='private, no-store'));
 assert.deepEqual(await controller.read({},req({honIdentity:{externalSubject:'verified'},headers:{'external-subject':'forged'}})),view);
 await assert.rejects(()=>controller.read({},req()),status(403));
 for(const patch of[{method:'POST'},{headers:{'sec-fetch-site':'cross-site'}},{headers:{'x-hon-school-id':scope.schoolId}},{headers:{'x-hon-human-command':'classpass'}}])assert.throws(()=>rejectParentClassPassInputs(req(patch),{}),status(403));
 for(const patch of[{body:{}},{originalUrl:'/api/v1/parent/classpass?'},{originalUrl:'/api/v1/parent/classpass?childId=forged'}])assert.throws(()=>rejectParentClassPassInputs(req(patch),{}),status(400));
 for(const k of['childId','schoolId','organizationId','familyId','passId','action'])assert.throws(()=>rejectParentClassPassInputs(req(),{[k]:'forged'}),status(400));
 assert.equal(new ParentClassPassReadGuard().canActivate({switchToHttp:()=>({getRequest:()=>({...req(),query:{}})})}),true);
});
test('parent ClassPass runtime wrapper starts repeatable read READ ONLY with no tenant selectors or raw SQL',async()=>{
 const calls=[],client={query:async(sql,args)=>{calls.push([sql,args]);return{rows:[{data:view}]};},release:()=>calls.push(['release'])};
 const db=new RuntimeDatabaseService();db.assertRuntimePosture=async()=>{};db.getPool=()=>({connect:async()=>client});
 assert.deepEqual(await db.readParentClassPassView('verified'),view);
 assert.equal(calls[0][0],'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');assert(calls.some(([sql,args])=>sql==='SELECT hon.read_parent_classpass_view($1) AS data'&&args[0]==='verified'));
 assert(!calls.some(([sql])=>/set_config|FROM hon\./i.test(sql)));assert.equal(calls.at(-1)[0],'release');
});
