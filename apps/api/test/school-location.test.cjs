const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {SchoolLocationService}=require('../dist/school-location/school-location.service.js');
const {SchoolLocationReadHumanUiGuard,SchoolLocationSaveHumanUiGuard}=require('../dist/school-location/school-location-human-ui.guard.js');
const c=require('@hon/contracts');
// 0392: the school address and the face check-in notice it decides.
const address={country:'US',region:'WA',city:'Seattle',postalCode:'98101',addressLine1:null,addressLine2:null};
const notice={profile:'US_WA_BIOMETRIC',status:'AVAILABLE_WITH_CONSENT',laws:['Washington biometric identifiers law (RCW 19.375)'],addOns:['HEALTH_DATA_CONSENT'],reviewStatus:'TEST_ONLY_DRAFT',rulesVersion:1};
const ctx=(over={})=>({organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID(),principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),externalSubject:'oidc:owner',idempotencyKey:'',...over});
function db(rows,calls=[]){return {withTenantReadOnlyTransaction:async(_c,f)=>f({query:async(sql,args)=>{calls.push([sql,args]);return /hon\.(read|save)_school_location/.test(sql)?{rows}:{rows:[]};}}),
 withTenantTransaction:async(_c,f)=>f({query:async(sql,args)=>{calls.push([sql,args]);return /hon\.(read|save)_school_location/.test(sql)?{rows}:{rows:[]};}})};}
test('read and save call only the 0392 functions with the session subject and verify the answer',async()=>{
 const calls=[];const s=new SchoolLocationService(db([{data:{location:{...address,version:1,updatedAt:'2026-11-16T10:00:00.000Z'},faceCheckInNotice:notice}}],calls));
 assert.equal((await s.read(ctx())).faceCheckInNotice.profile,'US_WA_BIOMETRIC');
 assert(calls.some(([sql,args])=>sql.includes('hon.read_school_location($1)')&&args[0]==='oidc:owner'));
 const saving=new SchoolLocationService(db([{data:{receipt:{location:{...address,version:2,updatedAt:'2026-11-16T10:00:00.000Z'},faceCheckInNotice:notice},replayed:false}}]));
 assert.equal((await saving.save(ctx({idempotencyKey:'k1'}),{location:address,expectedVersion:1})).receipt.location.version,2);
 const wrong=new SchoolLocationService(db([{data:{receipt:{location:{...address,version:5,updatedAt:'2026-11-16T10:00:00.000Z'},faceCheckInNotice:notice},replayed:false}}]));
 await assert.rejects(wrong.save(ctx({idempotencyKey:'k1'}),{location:address,expectedVersion:1}),e=>e.status===503);
 const lying=new SchoolLocationService(db([{data:{location:null,faceCheckInNotice:notice}}]));
 await assert.rejects(lying.read(ctx()),e=>e.status===503);
});
test('only direct human commands; bad input never reaches the database; refusals map to closed codes',async()=>{
 const calls=[];const s=new SchoolLocationService(db([],calls));
 for(const over of [{principalType:'AI_EMPLOYEE'},{source:'ACTION_ENGINE'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}])
  await assert.rejects(s.read(ctx(over)),e=>e.status===403);
 await assert.rejects(s.read(ctx({idempotencyKey:'x'})),e=>e.status===409);
 await assert.rejects(s.save(ctx(),{location:address,expectedVersion:0}),e=>e.status===409);
 for(const bad of [{location:{...address,region:null},expectedVersion:0},{location:address,expectedVersion:-1},{location:address},{location:{...address,city:'<x>'},expectedVersion:0}])
  await assert.rejects(s.save(ctx({idempotencyKey:'k'}),bad),e=>e.status===400);
 assert.equal(calls.length,0);
 for(const [code,message,status,closed] of [['42501','SCHOOL_LOCATION_FORBIDDEN',403,'SCHOOL_LOCATION_FORBIDDEN'],['40001','VERSION_CONFLICT',409,'VERSION_CONFLICT'],
   ['23505','IDEMPOTENCY_KEY_REUSED',409,'IDEMPOTENCY_KEY_REUSED'],['22023','VALIDATION_FAILED',400,'VALIDATION_FAILED'],['55P03','SECRET',409,'SCHOOL_LOCATION_CONFLICT'],['XX000','SECRET SQL',503,'SCHOOL_LOCATION_UNAVAILABLE']]){
  const failing=new SchoolLocationService({withTenantReadOnlyTransaction:async()=>{throw Object.assign(new Error(message),{code});}});
  await assert.rejects(failing.read(ctx()),e=>e.status===status&&e.getResponse().code===closed&&!JSON.stringify(e.getResponse()).includes('SECRET'));
 }
});
test('the guards use their own command names',()=>{
 assert.equal(new SchoolLocationReadHumanUiGuard().command,'school_location.read');
 assert.equal(new SchoolLocationSaveHumanUiGuard().command,'school_location.save');
 assert.throws(()=>c.validateSaveSchoolLocationInput({location:{...address,country:'CA',region:'WA'},expectedVersion:0}));
});
