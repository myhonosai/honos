const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {SchoolDemoDataService}=require('../dist/school-demo-data/school-demo-data.service.js');
const g=require('../dist/school-demo-data/school-demo-data-human-ui.guard.js');
const c=require('@hon/contracts');
// 0459: Settings > Demo data (load and remove).
const counts={adultStudents:8,attendance:287,classSessions:49,classes:3,families:28,guardians:20,invoices:113,leads:15,memberships:38,overdueInvoices:2,payments:73,programs:3,students:38};
const setId=randomUUID();
const loaded={status:'LOADED',setId,version:1,loadedAt:'2026-11-17T07:00:00.000Z',counts,lastRemovedAt:null};
const none={status:'NONE',setId:null,version:null,loadedAt:null,counts:null,lastRemovedAt:'2026-11-17T08:00:00.000Z'};
const ctx=(over={})=>({organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID(),principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),externalSubject:'oidc:owner',idempotencyKey:'',...over});
function db(rows,calls=[]){const client={query:async(sql,args)=>{calls.push([sql,args]);return /school_demo_data/.test(sql)?{rows}:{rows:[]};}};
 return {withTenantReadOnlyTransaction:async(_c,f)=>f(client),withTenantTransaction:async(_c,f)=>f(client)};}
test('read, load and remove call only the 0459 functions with the session subject and verify the answer',async()=>{
 const calls=[];
 assert.equal((await new SchoolDemoDataService(db([{data:loaded}],calls)).read(ctx())).counts.students,38);
 assert(calls.some(([sql,args])=>sql.includes('hon.read_school_demo_data($1)')&&args[0]==='oidc:owner'));
 const l=await new SchoolDemoDataService(db([{data:{record:loaded,replayed:false}}],calls)).load(ctx({idempotencyKey:'k1'}),{});
 assert.equal(l.receipt.setId,setId);assert(calls.some(([sql,args])=>sql.includes('hon.load_school_demo_data(')&&args[1]==='{}'&&args[2]==='k1'));
 const r=await new SchoolDemoDataService(db([{data:{record:none,replayed:true}}],calls)).remove(ctx({idempotencyKey:'k2'}),{setId,expectedVersion:1});
 assert.equal(r.receipt.status,'NONE');assert.equal(r.replayed,true);
 // A load must answer LOADED and a removal NONE; anything else is unverified.
 await assert.rejects(new SchoolDemoDataService(db([{data:{record:none,replayed:false}}])).load(ctx({idempotencyKey:'k'}),{}),e=>e.status===503);
 await assert.rejects(new SchoolDemoDataService(db([{data:{record:loaded,replayed:false}}])).remove(ctx({idempotencyKey:'k'}),{setId,expectedVersion:1}),e=>e.status===503);
 await assert.rejects(new SchoolDemoDataService(db([{data:{...loaded,counts:{...counts,extra:1}}}])).read(ctx()),e=>e.status===503);
});
test('only direct human commands; bad input never reaches the database; refusals map to closed codes',async()=>{
 const calls=[];const s=new SchoolDemoDataService(db([],calls));
 for(const over of [{principalType:'AI_EMPLOYEE'},{source:'ACTION_ENGINE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}])
  await assert.rejects(s.read(ctx(over)),e=>e.status===403);
 await assert.rejects(s.read(ctx({idempotencyKey:'x'})),e=>e.status===409);
 await assert.rejects(s.load(ctx(),{}),e=>e.status===409);
 for(const bad of [{a:1},null,[]])await assert.rejects(s.load(ctx({idempotencyKey:'k'}),bad),e=>e.status===400);
 for(const bad of [{setId},{setId:'x',expectedVersion:1},{setId,expectedVersion:0},{setId,expectedVersion:1,more:true}])
  await assert.rejects(s.remove(ctx({idempotencyKey:'k'}),bad),e=>e.status===400);
 assert.equal(calls.length,0);
 for(const [code,message,status,closed] of [['42501','DEMO_DATA_FORBIDDEN',403,'DEMO_DATA_FORBIDDEN'],['40001','DEMO_DATA_ALREADY_LOADED',409,'DEMO_DATA_ALREADY_LOADED'],
   ['P0002','DEMO_DATA_NOT_LOADED',404,'DEMO_DATA_NOT_LOADED'],['40001','VERSION_CONFLICT',409,'VERSION_CONFLICT'],['23505','IDEMPOTENCY_KEY_REUSED',409,'IDEMPOTENCY_KEY_REUSED'],
   ['55000','DEMO_DATA_REMOVE_FAILED',409,'DEMO_DATA_REMOVE_FAILED'],['42501','DEMO_CONTACT_NOT_CONTACTABLE',403,'DEMO_DATA_FORBIDDEN'],
   ['55P03','SECRET',409,'DEMO_DATA_CONFLICT'],['XX000','SECRET SQL',503,'DEMO_DATA_UNAVAILABLE']]){
  const failing=new SchoolDemoDataService({withTenantTransaction:async()=>{throw Object.assign(new Error(message),{code});}});
  await assert.rejects(failing.remove(ctx({idempotencyKey:'k'}),{setId,expectedVersion:1}),e=>e.status===status&&e.getResponse().code===closed&&!JSON.stringify(e.getResponse()).includes('SECRET'));
 }
});
test('DEMO_DATA_IN_USE carries only verified table names',async()=>{
 const fail=detail=>new SchoolDemoDataService({withTenantTransaction:async()=>{throw Object.assign(new Error('DEMO_DATA_IN_USE'),{code:'40001',detail});}});
 await assert.rejects(fail('{"tables":["class_bookings","attendance_records"]}').remove(ctx({idempotencyKey:'k'}),{setId,expectedVersion:1}),
  e=>e.status===409&&e.getResponse().code==='DEMO_DATA_IN_USE'&&JSON.stringify(e.getResponse().tables)==='["class_bookings","attendance_records"]');
 for(const bad of ['{"tables":["DROP TABLE x"]}','not json','{"tables":[]}'])
  await assert.rejects(fail(bad).remove(ctx({idempotencyKey:'k'}),{setId,expectedVersion:1}),e=>e.status===409&&e.getResponse().tables.length===0);
});
test('the guards use their own command names and the contract is closed',()=>{
 assert.equal(new g.SchoolDemoDataReadHumanUiGuard().command,'school.demo_data.read');
 assert.equal(new g.SchoolDemoDataLoadHumanUiGuard().command,'school.demo_data.load');
 assert.equal(new g.SchoolDemoDataRemoveHumanUiGuard().command,'school.demo_data.remove');
 assert.throws(()=>c.verifySchoolDemoDataView({...none,setId}));
 assert.throws(()=>c.verifySchoolDemoDataView(loaded,'NONE'));
 assert.equal(c.verifySchoolDemoDataView(none,'NONE').lastRemovedAt,'2026-11-17T08:00:00.000Z');
});
